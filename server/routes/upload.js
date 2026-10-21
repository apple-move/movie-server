import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { one, run, q } from '../db.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { getProvider } from '../providers/index.js';
import { createLocalProvider } from '../providers/local.js';
import { detectLanguage } from '../lib/subtitle.js';
import { mimeFromName, humanSize } from '../lib/mime.js';

export const uploadRouter = Router();

const upload = multer({
  dest: path.join(config.dataRoot, 'tmp'),
  limits: { fileSize: config.maxUploadSize },
});

/**
 * POST /api/upload
 *
 * Multipart upload that streams the file straight into the chosen storage
 * provider. The file is buffered to a temp file first so multi-GB videos do
 * not sit in memory.
 *
 * Form fields:
 *   file      - the media file
 *   provider  - local | r2 | gdrive | mega | telegram
 *   folder    - destination folder inside the provider (optional)
 *   movieId   - attach the uploaded file to this movie (optional)
 */
uploadRouter.post(
  '/',
  requireAuth,
  requireAdmin,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const providerId = req.body.provider || 'local';

    // Everything below must run inside the try/finally, otherwise a thrown
    // error leaves the multi-GB temp file on disk forever.
    try {
      let provider;
      try {
        provider = getProvider(providerId);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!provider.isConfigured()) {
        return res.status(400).json({ error: `${provider.name} is not configured` });
      }

      const originalName = sanitizeName(req.body.fileName || req.file.originalname || 'upload.bin');
      const folder = sanitizeFolder(req.body.folder || '');
      const remotePath = folder ? `${folder}/${originalName}` : originalName;
      const contentType = req.body.contentType || mimeFromName(originalName);

      const result = await provider.upload(remotePath, req.file.path, {
        size: req.file.size,
        contentType,
        name: originalName,
      });

      let source = null;
      if (req.body.movieId) {
        const movieId = Number(req.body.movieId);
        if (one('SELECT id FROM movies WHERE id = ?', movieId)) {
          run(
            `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(provider, remote_path) DO UPDATE SET movie_id = excluded.movie_id, size = excluded.size`,
            movieId,
            providerId,
            result.path,
            originalName,
            result.size || req.file.size,
            contentType,
          );
          source = one(
            'SELECT * FROM sources WHERE provider = ? AND remote_path = ?',
            providerId,
            result.path,
          );
        }
      }

      res.status(201).json({
        ok: true,
        provider: providerId,
        remotePath: result.path,
        size: result.size || req.file.size,
        sizeLabel: humanSize(result.size || req.file.size),
        source,
      });
    } catch (err) {
      console.error('[upload] failed:', err);
      res.status(500).json({ error: err.message });
    } finally {
      await cleanup(req.file.path);
    }
  },
);

/**
 * POST /api/upload/probe
 * Inspect a file in the local library and guess whether it is a movie, plus
 * extract a guessed title / year from the file name.
 *
 * The path is resolved through the local provider, which enforces the
 * library root — otherwise this would disclose the existence of any file
 * the server can read.
 */
uploadRouter.post('/probe', requireAuth, requireAdmin, (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });

  let abs;
  try {
    abs = createLocalProvider({ root: config.libraryRoot }).resolve(filePath);
  } catch {
    return res.status(400).json({ error: 'Path is outside the library root' });
  }

  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) return res.status(404).json({ error: 'File not found' });

  const name = path.basename(abs);
  res.json({
    name,
    size: stat.size,
    sizeLabel: humanSize(stat.size),
    mime: mimeFromName(name),
    guess: guessFromFilename(name),
  });
});

/**
 * GET /api/upload/existing
 * Lists files already present in a provider so they can be attached to a
 * movie without re-uploading.
 */
uploadRouter.get('/existing', requireAuth, requireAdmin, async (req, res) => {
  const { provider: providerId, prefix = '' } = req.query;
  if (!providerId) return res.status(400).json({ error: 'provider is required' });
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) {
    return res.status(400).json({ error: `${provider.name} is not configured` });
  }
  try {
    const files = await provider.list(prefix);
    res.json({ files: files.map((f) => ({ ...f, sizeLabel: humanSize(f.size) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/upload/subtitle
 * Attaches a subtitle file to an existing source.
 */
uploadRouter.post('/subtitle', requireAuth, requireAdmin, async (req, res) => {
  const { sourceId, provider: providerId, remotePath, language = 'en', label } = req.body || {};
  if (!sourceId || !providerId || !remotePath) {
    return res.status(400).json({ error: 'sourceId, provider and remotePath are required' });
  }
  const source = one('SELECT * FROM sources WHERE id = ?', Number(sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  // The subtitle must live in the same provider as the video it belongs to.
  if (source.provider !== providerId) {
    return res.status(400).json({
      error: `Subtitle provider must match the source provider (${source.provider})`,
    });
  }

  // The file must actually exist — otherwise the subtitle row points at
  // nothing and the player shows an empty track.
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) {
    return res.status(400).json({ error: `${provider.name} is not configured` });
  }
  try {
    const stat = await provider.stat(remotePath);
    if (!stat) return res.status(404).json({ error: 'Subtitle file not found in storage' });
  } catch (err) {
    console.error('[upload] subtitle stat failed:', err.message);
    return res.status(502).json({ error: 'Could not reach the storage provider' });
  }

  const mime = mimeFromName(remotePath);
  // Only real SRT files get converted to VTT; .ass/.ssa are passed through.
  const isSrt = mime === 'application/x-subrip';
  run(
    `INSERT INTO subtitles (source_id, provider, remote_path, language, label, mime)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(provider, remote_path) DO UPDATE SET source_id = excluded.source_id`,
    Number(sourceId),
    providerId,
    remotePath,
    language,
    label ?? null,
    isSrt ? 'application/x-subrip' : mime,
  );
  res.status(201).json({ ok: true });
});

/**
 * GET /api/upload/subtitles?provider=&movieId=
 * Finds subtitle files sitting next to a movie in the same provider folder.
 */
uploadRouter.get('/subtitles', requireAuth, requireAdmin, async (req, res) => {
  const { provider: providerId, movieId } = req.query;
  if (!providerId || !movieId) {
    return res.status(400).json({ error: 'provider and movieId are required' });
  }
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) {
    return res.status(400).json({ error: `${provider.name} is not configured` });
  }
  const sources = q('SELECT * FROM sources WHERE movie_id = ? AND provider = ?', Number(movieId), providerId);
  if (sources.length === 0) return res.json({ subtitles: [] });

  try {
    const files = await provider.list('');
    const known = new Set(sources.map((s) => s.remote_path));
    const subtitleFiles = files.filter(
      (f) => /\.(srt|vtt|ass|ssa|sub)$/i.test(f.name) && !known.has(f.path),
    );
    res.json({
      subtitles: subtitleFiles.map((f) => ({
        path: f.path,
        name: f.name,
        language: detectLanguage(f.name),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Guess title/year/quality from a file name such as "Movie.Name.2019.1080p.BluRay.mkv". */
export function guessFromFilename(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const yearMatch = /(?:\D|^)((?:19|20)\d{2})(?:\D|$)/.exec(base);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  const qualityMatch =
    /\b(2160p|4k|1440p|1080p|1080i|720p|480p|360p|uhd|hd|fullhd)\b/i.exec(base);
  const quality = qualityMatch ? qualityMatch[1].toUpperCase() : null;

  const tags = [];
  for (const tag of ['bluray', 'blu-ray', 'webrip', 'web-dl', 'webdl', 'hdrip', 'dvdrip', 'hdtv', 'remux', 'cam', 'ts']) {
    if (base.toLowerCase().includes(tag)) {
      tags.push(tag.toUpperCase().replace('WEB-DL', 'WEB-DL'));
      break;
    }
  }

  let title = base
    .replace(/[._]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(2160p|4k|1440p|1080p|1080i|720p|480p|360p|uhd|hd|fullhd)\b/gi, ' ')
    .replace(/\b(bluray|blu ray|webrip|web dl|webdl|hdrip|dvdrip|hdtv|remux|cam|ts|x264|x265|h264|h265|hevc|avc|10bit|8bit|proper|repack|extended|uncut|remastered|imax|dual audio|multi audio)\b/gi, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, year, quality, tags };
}

function sanitizeName(name) {
  const cleaned = String(name)
    .replace(/[/\\]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  // A name made only of dots would resolve outside the target directory.
  if (!cleaned || /^\.+$/.test(cleaned)) return 'file.bin';
  return cleaned;
}

function sanitizeFolder(folder) {
  return String(folder)
    .split(/[\\/]+/)
    .map((part) => part.replace(/[<>:"|?*]/g, '_').trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

async function cleanup(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}
