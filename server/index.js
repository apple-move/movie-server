import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { initProviders } from './providers/index.js';
import { authRouter } from './routes/auth.js';
import { moviesRouter, browseRouter } from './routes/movies.js';
import { streamRouter } from './routes/stream.js';
import { uploadRouter } from './routes/upload.js';
import { adminRouter, imagesRouter } from './routes/admin.js';
import { bookmarksRouter } from './routes/bookmarks.js';
import { optionalAuth } from './lib/auth.js';
import { isBanned } from './lib/ip-ban.js';
import { purgeExpiredSessions } from './lib/sessions.js';
import { one } from './db.js';

const app = express();

// `trust proxy` decides whether X-Forwarded-For is believed. The default
// only trusts a proxy on the same machine; behind Nginx set TRUST_PROXY=1.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Minimal cookie parser (only needs the token cookie).
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        req.cookies[key] = value;
      }
    }
  }
  next();
});

// Basic security headers.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob: https://image.tmdb.org https:",
      "media-src 'self' blob:",
      "script-src 'self'",
      // hls.js spawns a web worker for demuxing.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      // Google Fonts serves the stylesheet from fonts.googleapis.com and the
      // woff2 files from fonts.gstatic.com — both must be allowed explicitly.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "connect-src 'self'",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
});

// Populate req.user for requests that already carry a valid session, so the
// IP ban check below can let an admin through even if their own address was
// banned by mistake.
app.use(optionalAuth);

// Blocked IP addresses are rejected before any route runs. An admin can
// still block their own address, so their own requests are let through —
// otherwise they would lock themselves out with no way back.
app.use((req, res, next) => {
  if (req.ip && isBanned(req.ip) && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'This address has been blocked' });
  }
  next();
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/movies', moviesRouter);
app.use('/api/movies', bookmarksRouter);
app.use('/api/browse', browseRouter);
app.use('/api/stream', streamRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/admin', adminRouter);
app.use('/api/images', imagesRouter);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: config.env,
    movies: one('SELECT COUNT(*) AS c FROM movies').c,
  });
});

// Static frontend
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.env === 'production' ? '1h' : 0 }));

// SPA fallback — every unknown non-API route serves the shell.
app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 404 for unknown API routes.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Central error handler.
app.use((err, req, res, _next) => {
  // Multer's own error codes carry the right HTTP semantics.
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is larger than the configured MAX_UPLOAD_SIZE' });
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field' });
  }

  console.error('[error]', err);

  // If the response already started, the only correct move is to abort it —
  // returning would leave the request hanging.
  if (res.headersSent) {
    return res.destroy(err);
  }

  const status = err.status || err.statusCode || 500;

  // SQLite constraint / type errors are caused by bad input, not a server fault.
  if (String(err?.code || '').startsWith('ERR_SQLITE')) {
    return res.status(400).json({ error: 'Invalid request data' });
  }

  // Only expose the message for deliberate client errors (4xx).
  const expose = status >= 400 && status < 500;
  res.status(status).json({
    error: expose ? err.message : 'Internal server error',
    // Stack/SQL detail is only ever shown when explicitly debugging.
    ...(config.debug ? { detail: err.message, stack: err.stack?.split('\n').slice(0, 4) } : {}),
  });
});

/** Delete upload temp files left behind by a crash. */
function sweepTempUploads() {
  const tmpDir = path.join(config.dataRoot, 'tmp');
  if (!fs.existsSync(tmpDir)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(tmpDir)) {
    const file = path.join(tmpDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  if (removed) console.log(`[cleanup] removed ${removed} stale upload temp file(s)`);
}

// Never let a stray rejection or exception take the whole site down.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  // Keep serving — the request that caused it will simply fail.
});

async function start() {
  await initProviders();
  sweepTempUploads();

  // Housekeeping: drop sessions that have expired.
  const purged = purgeExpiredSessions();
  if (purged) console.log(`[cleanup] removed ${purged} expired session(s)`);

  const server = app.listen(config.port, config.host, () => {
    console.log(`\n  Movie Server running`);
    console.log(`  ➜  Local:   http://localhost:${config.port}`);
    console.log(`  ➜  Network: http://${config.host}:${config.port}`);
    console.log(`  ➜  Env:     ${config.env}\n`);
  });

  server.headersTimeout = 60_000;
  server.requestTimeout = 0; // long uploads and downloads
  server.keepAliveTimeout = 65_000;

  const shutdown = (signal) => {
    console.log(`\n[${signal}] shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
