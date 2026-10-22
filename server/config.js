import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/**
 * Minimal .env loader — avoids an extra dependency and works on every Node version.
 * Existing process.env values always win, so real env vars override the file.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};
const str = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
};
/** Multi-line env values (PEM private keys) use \n escapes. */
const multiline = (value, fallback = '') => {
  const v = str(value, '');
  return v ? v.replace(/\\n/g, '\n') : fallback;
};

const resolve = (p, fallback) => {
  const v = str(p, '');
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
};

/**
 * Normalise TRUST_PROXY for Express.
 *
 * Express reads a NUMBER as "trust N hops" but a STRING as a list of trusted
 * addresses or networks. `TRUST_PROXY=1` — the documented one-proxy setup —
 * arrives as a string, so without this it would be parsed as the IP address
 * 0.0.0.1 and X-Forwarded-For would be ignored completely: every client
 * would look like the proxy, which breaks the IP ban list and makes the
 * per-IP rate limit apply to everybody at once.
 */
const normalizeTrustProxy = (value) => {
  const raw = str(value, 'loopback');
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

export const config = {
  env: str(process.env.NODE_ENV, 'development'),
  // When enabled, error responses include the underlying detail. Never turn
  // this on for a public deployment.
  debug: bool(process.env.DEBUG, false),
  port: num(process.env.PORT, 3000),
  host: str(process.env.HOST, '0.0.0.0'),
  publicUrl: str(process.env.PUBLIC_URL, `http://localhost:${num(process.env.PORT, 3000)}`),
  // Which proxies to trust for X-Forwarded-For.
  //   'loopback' (default) — only trust a proxy on the same machine
  //   '1'                   — trust one hop (the usual Nginx setup)
  //   'true'                — trust everything (ONLY behind a proxy you control)
  trustProxy: normalizeTrustProxy(process.env.TRUST_PROXY),
  root: ROOT,

  jwtSecret: str(process.env.JWT_SECRET, 'insecure-dev-secret-change-me'),
  jwtExpiresIn: str(process.env.JWT_EXPIRES_IN, '7d'),

  dbPath: resolve(process.env.DB_PATH, path.join(ROOT, 'data', 'movie-server.db')),
  libraryRoot: resolve(process.env.LIBRARY_ROOT, path.join(ROOT, 'data', 'library')),
  dataRoot: resolve(process.env.DATA_ROOT, path.join(ROOT, 'data')),

  r2: {
    accountId: str(process.env.R2_ACCOUNT_ID),
    accessKeyId: str(process.env.R2_ACCESS_KEY_ID),
    secretAccessKey: str(process.env.R2_SECRET_ACCESS_KEY),
    bucket: str(process.env.R2_BUCKET, 'movies'),
    endpoint: str(process.env.R2_ENDPOINT),
  },

  google: {
    serviceAccountEmail: str(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    serviceAccountPrivateKey: multiline(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    folderId: str(process.env.GOOGLE_DRIVE_FOLDER_ID),
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
    refreshToken: str(process.env.GOOGLE_REFRESH_TOKEN),
  },

  mega: {
    email: str(process.env.MEGA_EMAIL),
    password: str(process.env.MEGA_PASSWORD),
    rootFolder: str(process.env.MEGA_ROOT_FOLDER),
  },

  telegram: {
    botToken: str(process.env.TELEGRAM_BOT_TOKEN),
    chatId: str(process.env.TELEGRAM_CHAT_ID),
  },

  tmdb: {
    apiKey: str(process.env.TMDB_API_KEY),
    language: str(process.env.TMDB_LANGUAGE, 'en-US'),
  },

  maxUploadSize: num(process.env.MAX_UPLOAD_SIZE, 5 * 1024 * 1024 * 1024),
  streamUrlTtl: num(process.env.STREAM_URL_TTL, 7200),
  // A shared secret the background job runner uses to read source files
  // through the normal streaming route (ffmpeg needs a seekable input).
  // Generated automatically when not set, so jobs work out of the box.
  jobToken: str(process.env.JOB_TOKEN, ''),

  // Full path to the ffmpeg/ffprobe binaries, when they are not on PATH.
  ffmpegPath: str(process.env.FFMPEG_PATH, ''),

  // Allow "add by URL" to reach private addresses (a NAS on the LAN, a local
  // media server). Off by default, because it removes the SSRF protection.
  allowPrivateUrls: bool(process.env.ALLOW_PRIVATE_URLS, false),
};

export const isProd = config.env === 'production';

// Secrets that are publicly known and must never be used to sign tokens.
const FORBIDDEN_SECRETS = new Set([
  'insecure-dev-secret-change-me',
  'change-me-to-a-long-random-string',
]);

if (FORBIDDEN_SECRETS.has(config.jwtSecret)) {
  if (isProd) {
    console.error(
      '\n[config] FATAL: JWT_SECRET is missing or still set to a placeholder value.\n' +
        '  Generate a strong secret and put it in your .env file:\n' +
        '    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n',
    );
    process.exit(1);
  }
  console.warn(
    '[config] WARNING: using a placeholder JWT_SECRET. Never do this in production.',
  );
} else if (isProd && config.jwtSecret.length < 32) {
  console.error(
    '[config] FATAL: JWT_SECRET must be at least 32 characters long in production.',
  );
  process.exit(1);
}

for (const dir of [config.dataRoot, path.dirname(config.dbPath), config.libraryRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}

// The job token lets the ffmpeg worker read sources through the streaming
// route. Generate one when it is not configured.
//
// A placeholder value is treated as "not set": the job token grants
// unauthenticated read access to every source, so a publicly known value
// (it ships in .env.example) must never be used as-is.
const PLACEHOLDER_JOB_TOKENS = new Set([
  'change-me-to-a-long-random-string',
  'change-me-too-a-long-random-string',
]);
if (!config.jobToken || PLACEHOLDER_JOB_TOKENS.has(config.jobToken)) {
  config.jobToken = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] JOB_TOKEN was not set (or is still a placeholder) — generated a random one. ' +
      'Set JOB_TOKEN in .env to keep it stable across restarts.',
  );
}
