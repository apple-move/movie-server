import { Router } from 'express';
import { createHash } from 'node:crypto';
import { one, q, run } from '../db.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import {
  listProviders,
  getProvider,
  getInstanceRow,
  reloadInstance as reloadProviderInstance,
} from '../providers/index.js';
import { humanSize, isVideoName, isSubtitleName, isArchiveName, isPlaylistName, mimeFromName } from '../lib/mime.js';
import { listZipEntries, pickVideoEntry } from '../lib/zip.js';
import { validateUrl, safeFetch, fileNameFromUrl } from '../lib/safe-url.js';
import { audit } from '../lib/audit.js';

export const moviesRouter = Router();

/** Attach source counts and the primary source to a movie row. */
function decorate(movie) {
  if (!movie) return null;
  const sources = q(
    `SELECT id, provider, file_name, size, quality, label, mime, kind, container
       FROM sources WHERE movie_id = ? ORDER BY size DESC`,
    movie.id,
  );
  const subtitles = q(
    `SELECT s.id, s.language, s.label, s.mime, src.id AS source_id
       FROM subtitles s JOIN sources src ON src.id = s.source_id
      WHERE src.movie_id = ?`,
    movie.id,
  );
  return {
    ...movie,
    genres: safeParse(movie.genres),
    cast: safeParse(movie.cast),
    crew: safeParse(movie.crew),
    keywords: safeParse(movie.keywords),
    featured: Boolean(movie.featured),
    sources,
    subtitles,
    totalSize: sources.reduce((sum, s) => sum + (s.size || 0), 0),
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value ?? '[]');
  } catch {
    return [];
  }
}

function getMovie(id) {
  return one('SELECT * FROM movies WHERE id = ?', id);
}

// ---------------------------------------------------------------- metadata
// These must be registered before `/:id` so they are not swallowed by it.

/** GET /api/movies/meta/genres — distinct genre list. */
moviesRouter.get('/meta/genres', requireAuth, (req, res) => {
  const rows = q('SELECT genres FROM movies');
  const set = new Set();
  for (const row of rows) {
    for (const g of safeParse(row.genres)) set.add(g);
  }
  res.json({ genres: [...set].sort() });
});

/** GET /api/movies/meta/providers — storage provider status. */
moviesRouter.get('/meta/providers', requireAuth, (req, res) => {
  res.json({ providers: listProviders() });
});

/** GET /api/movies — browse the library. */
moviesRouter.get('/', requireAuth, (req, res) => {
  const { q: search, genre, year, sort = 'recent', featured } = req.query;

  const where = [];
  const params = [];

  if (search) {
    const term = `%${escapeLike(String(search).toLowerCase())}%`;
    where.push("(m.title_lower LIKE ? ESCAPE '\\' OR LOWER(m.overview) LIKE ? ESCAPE '\\')");
    params.push(term, term);
  }
  if (genre) {
    where.push("m.genres LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(String(genre))}"%`);
  }
  if (year) {
    where.push('m.year = ?');
    params.push(toIntOrNull(year));
  }
  if (featured === '1' || featured === 'true') {
    where.push('m.featured = 1');
  }

  const order =
    {
      recent: 'm.created_at DESC',
      title: 'm.title_lower ASC',
      year: 'm.year DESC',
      rating: 'm.rating DESC',
    }[sort] || 'm.created_at DESC';

  // Clamp pagination so a bad query string can never reach SQLite as NaN.
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);
  const lim = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const off = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = q(
    `SELECT m.* FROM movies m ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    lim,
    off,
  );
  const { c: total } = one(`SELECT COUNT(*) AS c FROM movies m ${whereSql}`, ...params);

  res.json({ movies: rows.map(decorate), total });
});

/** GET /api/movies/:id */
moviesRouter.get('/:id', requireAuth, (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie: decorate(movie) });
});

/** GET /api/movies/:id/related */
moviesRouter.get('/:id/related', requireAuth, (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  const genres = safeParse(movie.genres);
  if (genres.length === 0) {
    const rows = q('SELECT * FROM movies WHERE id != ? ORDER BY created_at DESC LIMIT 12', movie.id);
    return res.json({ movies: rows.map(decorate) });
  }
  const rows = q(
    `SELECT * FROM movies WHERE id != ? AND (${genres.map(() => "genres LIKE ? ESCAPE '\\'").join(' OR ')})
     ORDER BY rating DESC LIMIT 12`,
    movie.id,
    ...genres.map((g) => `%"${escapeLike(g)}"%`),
  );
  res.json({ movies: rows.map(decorate) });
});

// ---------------------------------------------------------------- mutations

/** POST /api/movies — create a movie record. */
moviesRouter.post('/', requireAuth, requireAdmin, (req, res) => {
  const {
    title,
    year,
    overview,
    tagline,
    runtime,
    rating,
    genres = [],
    poster_url,
    backdrop_url,
    tmdb_id,
    imdb_id,
    featured = false,
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const cleanTitle = String(title).trim();
  const genreList = Array.isArray(genres)
    ? genres
    : String(genres)
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);

  const res2 = run(
    `INSERT INTO movies (title, title_lower, year, overview, tagline, runtime, rating, genres, poster_url, backdrop_url, tmdb_id, imdb_id, featured)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cleanTitle,
    cleanTitle.toLowerCase(),
    toIntOrNull(year),
    overview ?? null,
    tagline ?? null,
    toIntOrNull(runtime),
    toNumberOrNull(rating),
    JSON.stringify(genreList),
    poster_url ?? null,
    backdrop_url ?? null,
    toIntOrNull(tmdb_id),
    imdb_id ?? null,
    featured ? 1 : 0,
  );
  audit(req.user, 'movie.created', Number(res2.lastInsertRowid), { title }, req.ip);
  res.status(201).json({ movie: decorate(getMovie(Number(res2.lastInsertRowid))) });
});

/** PATCH /api/movies/:id */
moviesRouter.patch('/:id', requireAuth, requireAdmin, (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });

  const body = req.body || {};
  const fields = [];
  const params = [];

  const map = {
    title: 'title',
    year: 'year',
    overview: 'overview',
    tagline: 'tagline',
    runtime: 'runtime',
    rating: 'rating',
    poster_url: 'poster_url',
    backdrop_url: 'backdrop_url',
    tmdb_id: 'tmdb_id',
    imdb_id: 'imdb_id',
    trailer_url: 'trailer_url',
    release_date: 'release_date',
    skip_intro: 'skip_intro',
    skip_credits: 'skip_credits',
  };

  for (const [key, column] of Object.entries(map)) {
    if (body[key] === undefined) continue;
    fields.push(`${column} = ?`);
    params.push(
      column === 'title'
        ? String(body[key]).trim()
        : ['year', 'runtime', 'tmdb_id', 'vote_count'].includes(column)
          ? toIntOrNull(body[key])
          : ['rating', 'skip_intro', 'skip_credits'].includes(column)
            ? toNumberOrNull(body[key])
            : body[key],
    );
  }
  if (body.title !== undefined) {
    fields.push('title_lower = ?');
    params.push(String(body.title).trim().toLowerCase());
  }
  if (body.vote_count !== undefined) {
    fields.push('vote_count = ?');
    params.push(toIntOrNull(body.vote_count));
  }
  for (const key of ['cast', 'crew', 'keywords']) {
    if (body[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(
      JSON.stringify(Array.isArray(body[key]) ? body[key] : []),
    );
  }
  if (body.genres !== undefined) {
    const list = Array.isArray(body.genres) ? body.genres : String(body.genres).split(',').map((g) => g.trim()).filter(Boolean);
    fields.push('genres = ?');
    params.push(JSON.stringify(list));
  }
  if (body.featured !== undefined) {
    fields.push('featured = ?');
    params.push(body.featured ? 1 : 0);
  }

  if (fields.length) {
    fields.push("updated_at = datetime('now')");
    params.push(movie.id);
    run(`UPDATE movies SET ${fields.join(', ')} WHERE id = ?`, ...params);
  }
  audit(req.user, 'movie.updated', movie.id, { fields: Object.keys(body) }, req.ip);
  res.json({ movie: decorate(getMovie(movie.id)) });
});

/** DELETE /api/movies/:id */
moviesRouter.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  run('DELETE FROM movies WHERE id = ?', movie.id);
  audit(req.user, 'movie.deleted', movie.id, { title: movie.title }, req.ip);
  res.json({ ok: true });
});

/**
 * POST /api/movies/:id/sources — attach a storage file to a movie.
 * The remote file is looked up in the given provider to grab its real size.
 */
moviesRouter.post('/:id/sources', requireAuth, requireAdmin, async (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });

  const { provider, remotePath, quality, label, kind, entry } = req.body || {};
  if (!provider || !remotePath) {
    return res.status(400).json({ error: 'provider and remotePath are required' });
  }
  const instance = getProvider(provider);
  if (!instance.isConfigured()) {
    return res.status(400).json({ error: `${instance.name} is not configured` });
  }

  let stat = null;
  try {
    stat = await instance.stat(remotePath);
  } catch (err) {
    return res.status(400).json({ error: `Could not read file: ${err.message}` });
  }
  if (!stat) return res.status(404).json({ error: 'File not found in provider' });

  // Work out what kind of source this is: a plain file, a video inside an
  // archive, or an HLS playlist. Only the known kinds are accepted.
  const VALID_KINDS = ['file', 'zip', 'hls'];
  let sourceKind = VALID_KINDS.includes(kind) ? kind : 'file';
  let container = null;
  let effectiveSize = stat.size;
  let effectiveMime = stat.mime;

  if (sourceKind === 'file') {
    if (isArchiveName(stat.name)) sourceKind = 'zip';
    else if (isPlaylistName(stat.name)) sourceKind = 'hls';
  }

  // A file that is already attached to ANOTHER movie is MOVED, not silently
  // duplicated. The caller is told where it came from so the UI can warn.
  const attached = one(
    'SELECT s.movie_id, m.title FROM sources s LEFT JOIN movies m ON m.id = s.movie_id WHERE s.provider = ? AND s.remote_path = ?',
    provider,
    remotePath,
  );
  const movedFrom = attached && attached.movie_id !== movie.id
    ? { id: attached.movie_id, title: attached.title }
    : null;

  if (sourceKind === 'zip') {
    container = 'zip';
    try {
      const entries = await listZipEntries(instance, remotePath);
      const chosen = entry
        ? entries.find((e) => e.name === entry && !e.isDir)
        : pickVideoEntry(entries);
      if (!chosen) {
        return res.status(400).json({ error: 'No playable video inside the archive' });
      }
      effectiveSize = chosen.size;
      effectiveMime = mimeFromName(chosen.name);
    } catch (err) {
      console.error('[movies] archive read failed:', err.message);
      return res.status(400).json({ error: 'The archive could not be read' });
    }
  }

  try {
    run(
      `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind, container)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider, remote_path) DO UPDATE SET
         movie_id = excluded.movie_id,
         size = excluded.size,
         mime = excluded.mime,
         kind = excluded.kind,
         container = excluded.container`,
      movie.id,
      provider,
      remotePath,
      stat.name,
      effectiveSize,
      effectiveMime,
      quality ?? null,
      label ?? null,
      sourceKind,
      container,
    );
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const source = one(
    'SELECT * FROM sources WHERE provider = ? AND remote_path = ?',
    provider,
    remotePath,
  );
  res.status(201).json({ source, movedFrom });
});

/**
 * POST /api/movies/:id/sources/url
 *
 * Add a source from a URL instead of a file:
 *   - a direct video URL  → streamed straight through the server
 *   - a .zip URL          → the archive contents can be picked in the player
 *
 * The URL is validated against SSRF before it is ever fetched.
 */
moviesRouter.post('/:id/sources/url', requireAuth, requireAdmin, async (req, res) => {
  const movie = getMovie(Number(req.params.id));
  if (!movie) return res.status(404).json({ error: 'Movie not found' });

  const raw = String(req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'A URL is required' });

  let validated;
  try {
    validated = await validateUrl(raw);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const fileName = fileNameFromUrl(validated.url.toString());
  const isArchive = /\.(zip)$/i.test(fileName) || isArchiveName(fileName);
  const kind = isArchive ? 'zip' : 'file';

  // Register a one-off provider instance for this URL. The id is a full
  // hash, so two different URLs never collide.
  const instanceId = `url_${createHash('sha256').update(validated.url.toString()).digest('hex').slice(0, 24)}`;
  const existing = getInstanceRow(instanceId);
  const providerConfig = JSON.stringify({ url: validated.url.toString(), name: fileName });

  if (existing) {
    // Refresh the stored URL — it may have changed (or the id may be from an
    // earlier configuration).
    run(
      'UPDATE provider_instances SET config = ?, name = ? WHERE id = ?',
      providerConfig,
      fileName,
      instanceId,
    );
    // The cached provider still holds the old URL.
    await reloadProviderInstance(instanceId);
  } else {
    run(
      `INSERT INTO provider_instances (id, type, name, config, enabled, is_default)
       VALUES (?,?,?,?,1,0)`,
      instanceId,
      isArchive ? 'url-archive' : 'url',
      fileName,
      providerConfig,
    );
  }

  let size = 0;
  let mime = mimeFromName(fileName);
  try {
    const provider = getProvider(instanceId);
    await provider.init();
    // Find out how big the file is, and whether it really is a video.
    const head = await safeFetch(validated.url.toString(), {
      method: 'HEAD',
    });
    const length = Number(head.headers.get('content-length') || 0);
    const type = head.headers.get('content-type') || '';
    if (length > 0) size = length;
    if (type && !mimeFromName(fileName).includes('octet-stream')) mime = type;
  } catch (err) {
    console.error('[movies] URL probe failed:', err.message);
    // A failed HEAD is not fatal — the file may still stream.
  }

  let container = null;
  if (isArchive) {
    container = 'zip';
    try {
      const provider = getProvider(instanceId);
      const entries = await listZipEntries(provider, validated.url.toString());
      const video = pickVideoEntry(entries);
      if (!video) {
        // The instance would be left behind, so it is removed again.
        if (!existing) run('DELETE FROM provider_instances WHERE id = ?', instanceId);
        return res.status(400).json({ error: 'That archive contains no playable video' });
      }
      size = video.size;
      mime = mimeFromName(video.name);
    } catch (err) {
      console.error('[movies] archive read failed:', err.message);
      if (!existing) run('DELETE FROM provider_instances WHERE id = ?', instanceId);
      return res.status(400).json({ error: 'That archive could not be read' });
    }
  }

  try {
    run(
      `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind, container)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider, remote_path) DO UPDATE SET
         movie_id = excluded.movie_id, size = excluded.size, mime = excluded.mime, kind = excluded.kind`,
      movie.id,
      instanceId,
      validated.url.toString(),
      fileName,
      size,
      mime,
      req.body?.quality ?? null,
      req.body?.label ?? fileName,
      kind,
      container,
    );
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const source = one(
    'SELECT * FROM sources WHERE provider = ? AND remote_path = ?',
    instanceId,
    validated.url.toString(),
  );
  audit(
    req.user,
    'source.url_attached',
    source?.id,
    { url: validated.url.toString(), kind },
    req.ip,
  );
  res.status(201).json({ source });
});

/**
 * GET /api/movies/:id/archive?provider=&path=
 * Lists the entries inside an archive so the admin can pick which one to add.
 */
moviesRouter.get('/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  const { provider, path: remotePath } = req.query;
  if (!provider || !remotePath) {
    return res.status(400).json({ error: 'provider and path are required' });
  }
  try {
    const instance = getProvider(provider);
    const entries = await listZipEntries(instance, remotePath);
    res.json({
      entries: entries
        .filter((e) => !e.isDir)
        .map((e) => ({
          name: e.name,
          size: e.size,
          compressedSize: e.compressedSize,
          method: e.method,
          isVideo: isVideoName(e.name),
          isSubtitle: isSubtitleName(e.name),
        })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/sources/:id */
moviesRouter.delete('/sources/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const source = one('SELECT id, file_name FROM sources WHERE id = ?', id);
  run('DELETE FROM sources WHERE id = ?', id);
  audit(req.user, 'source.removed', id, { file: source?.file_name }, req.ip);
  res.json({ ok: true });
});

/**
 * GET /api/movies/:id/progress — resume position for the current user.
 */
moviesRouter.get('/:id/progress', requireAuth, (req, res) => {
  const row = one(
    'SELECT * FROM watch_progress WHERE user_id = ? AND movie_id = ?',
    req.user.id,
    Number(req.params.id),
  );
  res.json({ progress: row || null });
});

/** POST /api/movies/:id/progress — save resume position. */
moviesRouter.post('/:id/progress', requireAuth, (req, res) => {
  const { position, duration, sourceId } = req.body || {};
  const movieId = Number(req.params.id);
  if (!getMovie(movieId)) return res.status(404).json({ error: 'Movie not found' });

  run(
    `INSERT INTO watch_progress (user_id, movie_id, source_id, position_sec, duration_sec, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(user_id, movie_id) DO UPDATE SET
       position_sec = excluded.position_sec,
       duration_sec = excluded.duration_sec,
       source_id = excluded.source_id,
       updated_at = excluded.updated_at`,
    req.user.id,
    movieId,
    sourceId ?? null,
    Number(position) || 0,
    Number(duration) || null,
  );
  res.json({ ok: true });
});

/**
 * GET /api/movies/progress/bulk
 * All watch positions for the current user in one request.
 */
moviesRouter.get('/progress/bulk', requireAuth, (req, res) => {
  const rows = q('SELECT * FROM watch_progress WHERE user_id = ?', req.user.id);
  res.json({ progress: rows });
});

/**
 * GET /api/browse/remote?provider=r2&prefix=movies
 * Lists files available in a storage provider so an admin can attach them.
 */
export const browseRouter = Router();

browseRouter.get('/remote', requireAuth, requireAdmin, async (req, res) => {
  const { provider, prefix = '' } = req.query;
  if (!provider) return res.status(400).json({ error: 'provider is required' });
  const instance = getProvider(provider);
  if (!instance.isConfigured()) {
    return res.status(400).json({ error: `${instance.name} is not configured` });
  }
  try {
    const files = await instance.list(prefix);
    res.json({
      files: files.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        sizeLabel: humanSize(f.size),
        mtime: f.mtime,
        isVideo: isVideoName(f.name),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Escape LIKE wildcards so a search for "100%" or "a_b" is treated literally
 * instead of matching everything.
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}
