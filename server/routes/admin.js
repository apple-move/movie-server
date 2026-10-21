import { Router } from 'express';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import {
  listProviders,
  getProvider,
  createInstance,
  updateInstance,
  deleteInstance,
  reloadInstance,
  redactInstance,
  getInstanceRow,
  listInstanceRows,
  PROVIDER_TYPES,
  PROVIDER_FIELDS,
} from '../providers/index.js';
import { scanProvider, readProviderImage } from '../services/scanner.js';
import { enrichMovie, tmdb, fetchFullDetails, getSetting, setSetting } from '../services/tmdb.js';
import { one, q, run } from '../db.js';
import { config } from '../config.js';
import { mimeFromName, humanSize } from '../lib/mime.js';
import { audit, listAuditLog, AUDIT_ACTIONS, purgeAuditLog } from '../lib/audit.js';
import { listSessions, revokeSession } from '../lib/sessions.js';
import { listBans, banIp, unbanIp } from '../lib/ip-ban.js';
import { createJob, listJobs, getJob, cancelJob, ffmpegAvailable } from '../services/jobs.js';

export const adminRouter = Router();

/** GET /api/admin/status — overall system status for the admin panel. */
adminRouter.get('/status', requireAuth, requireAdmin, async (req, res) => {
  const movies = one('SELECT COUNT(*) AS c FROM movies').c;
  const sources = one('SELECT COUNT(*) AS c FROM sources').c;
  const users = one('SELECT COUNT(*) AS c FROM users').c;
  const totalSize = one('SELECT COALESCE(SUM(size), 0) AS s FROM sources').s;
  res.json({
    movies,
    sources,
    users,
    totalSize,
    totalSizeLabel: humanSize(totalSize),
    providers: listProviders(),
    tmdb: tmdb.isConfigured(),
    ffmpeg: ffmpegAvailable(),
    publicUrl: config.publicUrl,
    uptime: process.uptime(),
    nodeVersion: process.version,
    memory: process.memoryUsage().rss,
  });
});

/* ------------------------------------------------------------ providers */

/** GET /api/admin/provider-types — the fields needed to add each type. */
adminRouter.get('/provider-types', requireAuth, requireAdmin, (req, res) => {
  res.json({ types: PROVIDER_TYPES, fields: PROVIDER_FIELDS });
});

/** GET /api/admin/providers — list every configured instance. */
adminRouter.get('/providers', requireAuth, requireAdmin, (req, res) => {
  res.json({ providers: listProviders() });
});

/** POST /api/admin/providers — add a storage instance. */
adminRouter.post('/providers', requireAuth, requireAdmin, async (req, res) => {
  const { id, type, name, config, isDefault } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type is required' });
  try {
    const row = createInstance({ id, type, name, config, isDefault });
    // Initialise it straight away so it is usable right away.
    const provider = await reloadInstance(row.id);
    if (!provider) {
      return res.status(400).json({ error: 'The provider could not be initialised — check the details' });
    }
    audit(req.user, 'provider.created', row.id, { type, name: row.name }, req.ip);
    res.status(201).json({ provider: redactInstance(getInstanceRow(row.id)) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/** PATCH /api/admin/providers/:id — update an instance. */
adminRouter.patch('/providers/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, config, enabled, isDefault } = req.body || {};
  try {
    const row = await updateInstance(req.params.id, { name, config, enabled, isDefault });
    audit(req.user, 'provider.updated', row.id, { name: row.name }, req.ip);
    res.json({ provider: redactInstance(getInstanceRow(req.params.id)) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/** DELETE /api/admin/providers/:id — remove an instance. */
adminRouter.delete('/providers/:id', requireAuth, requireAdmin, (req, res) => {
  const inUse = one('SELECT COUNT(*) AS c FROM sources WHERE provider = ?', req.params.id);
  if (inUse?.c > 0) {
    return res.status(400).json({
      error: `${inUse.c} source(s) still use this provider. Detach them first.`,
    });
  }
  try {
    deleteInstance(req.params.id);
    audit(req.user, 'provider.deleted', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/** GET /api/admin/providers/:id/usage — how much space is used. */
adminRouter.get('/providers/:id/usage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = getProvider(req.params.id);
    const usage = await provider.usage();
    res.json({
      usage: { ...usage, bytesLabel: humanSize(usage.bytes) },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ----------------------------------------------------------------- jobs */

/** GET /api/admin/jobs — background job queue. */
adminRouter.get('/jobs', requireAuth, requireAdmin, (req, res) => {
  res.json({ jobs: listJobs({ limit: 50, status: req.query.status }) });
});

/** POST /api/admin/jobs — start a remux/transcode job. */
adminRouter.post('/jobs', requireAuth, requireAdmin, (req, res) => {
  const { type, sourceId, provider, targetPath, videoCodec, audioCodec } = req.body || {};
  try {
    const job = createJob({
      type,
      sourceId,
      provider,
      targetPath,
      videoCodec,
      audioCodec,
      user: req.user,
      ip: req.ip,
    });
    res.status(201).json({ job });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/** GET /api/admin/jobs/:id — job status. */
adminRouter.get('/jobs/:id', requireAuth, requireAdmin, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

/** DELETE /api/admin/jobs/:id — cancel a running job. */
adminRouter.delete('/jobs/:id', requireAuth, requireAdmin, (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  audit(req.user, 'job.cancelled', req.params.id, null, req.ip);
  res.json({ job });
});

/**
 * POST /api/admin/convert
 *
 * One-click "give me an MP4": remuxes (or downloads) the source into a
 * browser-playable MP4 and attaches it to the movie. Used for MKV files and
 * for turning an HLS stream into a downloadable file.
 */
adminRouter.post('/convert', requireAuth, requireAdmin, async (req, res) => {
  const { sourceId, provider, targetPath, type = 'remux' } = req.body || {};
  if (!sourceId) return res.status(400).json({ error: 'sourceId is required' });

  const source = one('SELECT * FROM sources WHERE id = ?', Number(sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const targetProvider = provider || source.provider;
  const name = (targetPath || '').trim() ||
    `converted/${source.file_name || `source-${source.id}`}`.replace(/\.[^.]*$/, '.mp4');

  try {
    const job = createJob({
      type,
      sourceId: source.id,
      provider: targetProvider,
      targetPath: name,
      user: req.user,
      ip: req.ip,
    });
    res.status(201).json({ job });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------- audit */

/** GET /api/admin/audit — the audit trail. */
adminRouter.get('/audit', requireAuth, requireAdmin, (req, res) => {
  res.json({
    entries: listAuditLog({
      limit: req.query.limit,
      action: req.query.action,
      userId: req.query.userId,
    }),
    actions: AUDIT_ACTIONS,
  });
});

/** DELETE /api/admin/audit — prune old entries. */
adminRouter.delete('/audit', requireAuth, requireAdmin, (req, res) => {
  if (req.query.confirm !== '1') {
    return res.status(400).json({ error: 'Pass ?confirm=1 to delete audit entries' });
  }
  const removed = purgeAuditLog(req.query.days);
  res.json({ removed });
});

/* ------------------------------------------------------------- sessions */

/** GET /api/admin/sessions — who is signed in. */
adminRouter.get('/sessions', requireAuth, requireAdmin, (req, res) => {
  res.json({ sessions: listSessions() });
});

/** DELETE /api/admin/sessions/:id — sign a device out. */
adminRouter.delete('/sessions/:id', requireAuth, requireAdmin, (req, res) => {
  revokeSession(req.params.id);
  audit(req.user, 'session.revoked', req.params.id, null, req.ip);
  res.json({ ok: true });
});

/* ------------------------------------------------------------- ip bans */

/** GET /api/admin/bans — blocked addresses. */
adminRouter.get('/bans', requireAuth, requireAdmin, (req, res) => {
  res.json({ bans: listBans() });
});

/** POST /api/admin/bans — block an address. */
adminRouter.post('/bans', requireAuth, requireAdmin, (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip is required' });
  banIp(ip, reason);
  audit(req.user, 'ip.banned', ip, { reason }, req.ip);
  res.json({ ok: true });
});

/** DELETE /api/admin/bans/:ip — unblock an address. */
adminRouter.delete('/bans/:ip', requireAuth, requireAdmin, (req, res) => {
  unbanIp(req.params.ip);
  audit(req.user, 'ip.unbanned', req.params.ip, null, req.ip);
  res.json({ ok: true });
});

/* ------------------------------------------------------------- settings */

/** GET /api/admin/settings — server settings. */
adminRouter.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({ settings: readSettings() });
});

/** PUT /api/admin/settings — update server settings. */
adminRouter.put('/settings', requireAuth, requireAdmin, (req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      String(key),
      JSON.stringify(value),
    );
  }
  audit(req.user, 'settings.updated', null, updates, req.ip);
  res.json({ settings: readSettings() });
});

function readSettings() {
  const out = {};
  for (const row of q('SELECT key, value FROM settings')) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

/* ------------------------------------------------------ bulk operations */

/** POST /api/admin/bulk — act on many movies at once. */
adminRouter.post('/bulk', requireAuth, requireAdmin, (req, res) => {
  const { action, movieIds = [] } = req.body || {};
  const ids = movieIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: 'movieIds is required' });

  let affected = 0;
  if (action === 'delete') {
    for (const id of ids) {
      run('DELETE FROM movies WHERE id = ?', id);
      affected += 1;
    }
    audit(req.user, 'movie.deleted', ids.join(','), { count: ids.length }, req.ip);
  } else if (action === 'feature') {
    for (const id of ids) {
      run('UPDATE movies SET featured = 1 WHERE id = ?', id);
      affected += 1;
    }
  } else if (action === 'unfeature') {
    for (const id of ids) {
      run('UPDATE movies SET featured = 0 WHERE id = ?', id);
      affected += 1;
    }
  } else {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  res.json({ ok: true, affected });
});

/* --------------------------------------------------------------- scan -- */

/** POST /api/admin/scan — import files from a provider into the library. */
adminRouter.post('/scan', requireAuth, requireAdmin, async (req, res) => {
  const { provider, prefix = '' } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider is required' });
  try {
    const stats = await scanProvider(provider, { prefix });
    audit(req.user, 'provider.scanned', provider, stats, req.ip);
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[scan] failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** POST /api/admin/enrich/:movieId — pull metadata + poster from TMDB. */
adminRouter.post('/enrich/:movieId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const movie = await enrichMovie(Number(req.params.movieId), {
      overwrite: Boolean(req.body?.overwrite),
    });
    res.json({ ok: true, movie });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/tmdb/search?q= — search TMDB for the admin panel. */
adminRouter.get('/tmdb/search', requireAuth, requireAdmin, async (req, res) => {
  const { q: query, year } = req.query;
  if (!query) return res.status(400).json({ error: 'q is required' });
  try {
    const results = await tmdb.search(query, year);
    res.json({
      results: results.slice(0, 12).map((r) => ({
        id: r.id,
        title: r.title,
        year: (r.release_date || '').slice(0, 4),
        overview: r.overview,
        rating: r.vote_average,
        poster: tmdb.image(r.poster_path, 'w300'),
        backdrop: tmdb.image(r.backdrop_path, 'w780'),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/tmdb/key — whether a key is configured (never the key).
 *
 * Registered BEFORE `/tmdb/:tmdbId`, otherwise the parameterised route
 * would swallow it.
 */
adminRouter.get('/tmdb/key', requireAuth, requireAdmin, (req, res) => {
  res.json({ configured: tmdb.isConfigured() });
});

/**
 * PUT /api/admin/tmdb/key
 * Store the TMDB API key so it can be changed from the Admin panel.
 */
adminRouter.put('/tmdb/key', requireAuth, requireAdmin, (req, res) => {
  const key = String(req.body?.apiKey || '').trim();
  if (key) setSetting('tmdb_api_key', key);
  else setSetting('tmdb_api_key', '');
  audit(req.user, 'settings.updated', 'tmdb_api_key', { configured: Boolean(key) }, req.ip);
  res.json({ ok: true, configured: Boolean(key) });
});

/** GET /api/admin/tmdb/:tmdbId — full TMDB details for one movie. */
adminRouter.get('/tmdb/:tmdbId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const details = await fetchFullDetails(req.params.tmdbId);
    res.json({ details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/tmdb/import
 *
 * Add a movie straight from TMDB with EVERYTHING: title, year, synopsis,
 * tagline, runtime, rating, genres, keywords, poster, backdrop, cast, crew
 * and the trailer. One call, one complete entry.
 */
adminRouter.post('/tmdb/import', requireAuth, requireAdmin, async (req, res) => {
  const { tmdbId, featured = false } = req.body || {};
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId is required' });

  try {
    const details = await fetchFullDetails(tmdbId);

    // Do not create the same film twice.
    const existing = one('SELECT id, title FROM movies WHERE tmdb_id = ?', details.id);
    if (existing) {
      // Write the details we already fetched. Re-searching by title could
      // match a DIFFERENT film and mix the two.
      run(
        `UPDATE movies SET
           title = ?, title_lower = ?, year = ?, overview = ?, tagline = ?,
           runtime = ?, rating = ?, genres = ?, poster_url = ?, backdrop_url = ?,
           imdb_id = ?, cast = ?, crew = ?, keywords = ?, trailer_url = ?,
           release_date = ?, vote_count = ?, updated_at = datetime('now')
         WHERE id = ?`,
        details.title,
        details.title.toLowerCase(),
        details.year,
        details.overview,
        details.tagline,
        details.runtime,
        details.rating,
        JSON.stringify(details.genres),
        details.poster,
        details.backdrop,
        details.imdbId,
        JSON.stringify(details.cast),
        JSON.stringify(details.crew),
        JSON.stringify(details.keywords),
        details.trailer?.url || null,
        details.releaseDate,
        details.voteCount,
        existing.id,
      );
      audit(req.user, 'movie.updated', existing.id, { tmdbId: details.id }, req.ip);
      const updated = one('SELECT * FROM movies WHERE id = ?', existing.id);
      return res.json({
        created: false,
        movie: {
          ...updated,
          genres: JSON.parse(updated.genres),
          cast: JSON.parse(updated.cast),
          crew: JSON.parse(updated.crew),
          keywords: JSON.parse(updated.keywords),
        },
      });
    }

    const result = run(
      `INSERT INTO movies
        (title, title_lower, year, overview, tagline, runtime, rating, genres,
         poster_url, backdrop_url, tmdb_id, imdb_id, cast, crew, keywords,
         trailer_url, release_date, vote_count, featured)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      details.title,
      details.title.toLowerCase(),
      details.year,
      details.overview,
      details.tagline,
      details.runtime,
      details.rating,
      JSON.stringify(details.genres),
      details.poster,
      details.backdrop,
      details.id,
      details.imdbId,
      JSON.stringify(details.cast),
      JSON.stringify(details.crew),
      JSON.stringify(details.keywords),
      details.trailer?.url || null,
      details.releaseDate,
      details.voteCount,
      featured ? 1 : 0,
    );
    const movieId = Number(result.lastInsertRowid);
    audit(req.user, 'movie.created', movieId, { tmdbId: details.id, title: details.title }, req.ip);

    const movie = one('SELECT * FROM movies WHERE id = ?', movieId);
    res.status(201).json({
      created: true,
      movie: {
        ...movie,
        genres: JSON.parse(movie.genres),
        cast: JSON.parse(movie.cast),
        crew: JSON.parse(movie.crew),
        keywords: JSON.parse(movie.keywords),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/images?provider=&path=
 * Serves a poster/backdrop that lives inside a storage provider.
 *
 * Available to any signed-in member — posters are part of the library
 * browsing experience. The path must be one the server already knows about
 * (a poster recorded on a movie, or a file under the library root), so a
 * member cannot use this to read arbitrary objects out of the bucket.
 */
export const imagesRouter = Router();

imagesRouter.get('/', requireAuth, async (req, res) => {
  const { provider: providerId, path: remotePath } = req.query;
  if (!providerId || !remotePath) {
    return res.status(400).json({ error: 'provider and path are required' });
  }

  // The path must be one we have recorded against a movie in this library.
  // `instr` is used instead of LIKE so wildcards in the path are literal.
  const known = one(
    `SELECT id FROM movies
      WHERE instr(poster_url, ?) > 0 OR instr(backdrop_url, ?) > 0 LIMIT 1`,
    encodeURIComponent(remotePath),
    encodeURIComponent(remotePath),
  );
  if (!known) {
    return res.status(404).json({ error: 'Image not found in the library' });
  }

  try {
    const buffer = await readProviderImage(providerId, remotePath);
    res.setHeader('Content-Type', mimeFromName(remotePath));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('[images] failed:', err.message);
    res.status(err.status || 500).json({ error: 'Could not load the image' });
  }
});

/** GET /api/admin/providers/:id/probe — test a provider connection. */
adminRouter.get('/providers/:id/probe', requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const provider = getProvider(id);
    if (!provider.isConfigured()) {
      return res.json({ ok: false, error: `${provider.name} is not configured` });
    }
    const files = await provider.list('');
    res.json({ ok: true, fileCount: files.length, sample: files.slice(0, 5).map((f) => f.name) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/** GET /api/admin/movies — a flat list for admin tooling. */
adminRouter.get('/movies', requireAuth, requireAdmin, (req, res) => {
  const rows = q('SELECT id, title, year, featured, created_at FROM movies ORDER BY created_at DESC LIMIT 500');
  res.json({ movies: rows });
});
