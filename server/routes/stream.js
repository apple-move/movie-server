import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { one, q } from '../db.js';
import { requireAuth, requireAuthOrJob } from '../lib/auth.js';
import { getProvider } from '../providers/index.js';
import { parseRange, contentRange, limitStream } from '../lib/range.js';
import { mimeFromName, humanSize } from '../lib/mime.js';
import { listZipEntries, openZipEntryStream, pickVideoEntry } from '../lib/zip.js';
import { rewritePlaylist, listVariants, listSubtitles, splitUri, resolveUri, PLAYLIST_MIME } from '../lib/hls.js';
import {
  ffmpegAvailable,
  probeMedia,
  buildRenditions,
  buildAudioOptions,
  buildInputSpec,
  buildMasterPlaylist,
  getSession,
  findSessionForSegment,
} from '../services/transcode.js';

export const streamRouter = Router();

/** Subtitle files are small; anything larger is a mistake or an attack. */
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

/**
 * GET /api/stream/:sourceId
 *
 * Streams a movie file straight from its storage provider to the browser
 * with full HTTP Range support, so the user can seek and resume without the
 * whole file ever being downloaded first.
 *
 * Three kinds of source are supported:
 *   kind = 'file' — a plain video file
 *   kind = 'zip'  — a video entry inside a .zip archive
 *   kind = 'hls'  — an .m3u8 playlist (served through /hls)
 */
/**
 * GET /api/stream/:sourceId
 *
 * Streams a movie file straight from its storage provider to the browser
 * with full HTTP Range support, so the user can seek and resume without the
 * whole file ever being downloaded first.
 *
 * Three kinds of source are supported:
 *   kind = 'file' — a plain video file
 *   kind = 'zip'  — a video entry inside a .zip archive
 *   kind = 'hls'  — an .m3u8 playlist (served through /hls)
 */
streamRouter.get('/:sourceId', requireAuthOrJob, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const provider = getProvider(source.provider);
  if (!provider.isConfigured()) {
    return res.status(503).json({ error: `${provider.name} is not configured` });
  }

  // A ZIP-backed source streams the entry inside the archive.
  if (source.kind === 'zip') {
    return await streamZipEntry(req, res, source, provider);
  }

  // An HLS playlist is served through /hls. The job token has to survive
  // the redirect, otherwise the ffmpeg worker cannot read the segments.
  if (source.kind === 'hls') {
    const jobQuery = req.query.jobToken
      ? `?jobToken=${encodeURIComponent(String(req.query.jobToken))}`
      : '';
    return res.redirect(302, `/api/stream/${source.id}/hls${jobQuery}`);
  }

  let stat;
  try {
    stat = await provider.stat(source.remote_path);
  } catch (err) {
    // Provider errors can contain endpoint URLs and credential hints, so the
    // detail is logged but never sent to the client.
    console.error(`[stream] stat failed for source ${source.id}:`, err.message);
    return res.status(502).json({ error: 'Could not reach the storage provider' });
  }
  if (!stat) return res.status(404).json({ error: 'File missing from storage' });

  const size = stat.size || source.size || 0;
  const contentType = stat.mime || source.mime || mimeFromName(stat.name);
  const range = parseRange(req.headers.range, size);

  // R2 can hand out a presigned URL so the browser pulls bytes straight from
  // Cloudflare, keeping the server's bandwidth free. The ?direct=1 flag
  // opts into it; without it the stream is always proxied (so auth and
  // range accounting stay in one place).
  if (req.query.direct === '1' && typeof provider.getDirectUrl === 'function') {
    try {
      const direct = await provider.getDirectUrl(source.remote_path);
      if (direct) return res.redirect(302, direct);
    } catch (err) {
      // Fall through to proxying if signing fails.
      console.warn('[stream] direct URL failed, proxying instead:', err.message);
    }
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(416).json({ error: 'Requested range not satisfiable' });
  }

  let upstream;
  try {
    upstream = await provider.createReadStream(source.remote_path, {
      start: range?.start,
      end: range?.end,
    });
  } catch (err) {
    console.error(`[stream] open failed for source ${source.id}:`, err.message);
    return res.status(502).json({ error: 'Could not open the file for streaming' });
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', contentRange(range.start, range.end, size));
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    res.status(200);
    res.setHeader('Content-Length', size);
  }

  // If the provider ignored our Range and sent the full body, trim it here
  // so the client always receives exactly the bytes it asked for.
  const expected = range ? range.end - range.start + 1 : null;
  const out = expected ? limitStream(upstream, expected) : upstream;

  // A provider that dies mid-transfer emits an 'error' event. Without a
  // listener that is an unhandled error and takes the whole process down.
  const fail = (err) => {
    // The viewer seeking away or closing the tab aborts the request — that
    // is normal and must not be reported as a failure.
    const clientGone = res.writableEnded || res.destroyed || req.aborted;
    if (!clientGone) {
      console.error(`[stream] source ${source.id} failed:`, err?.message || err);
    }
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  };
  upstream.on('error', fail);
  out.on('error', fail);
  res.on('close', () => {
    if (upstream.destroy) upstream.destroy();
  });

  out.pipe(res);
});

/**
 * GET /api/stream/:sourceId/download
 * Forces a download with the original file name.
 */
streamRouter.get('/:sourceId/download', requireAuth, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const provider = getProvider(source.provider);
  if (!provider.isConfigured()) {
    return res.status(503).json({ error: `${provider.name} is not configured` });
  }

  let stat;
  try {
    stat = await provider.stat(source.remote_path);
  } catch (err) {
    // Provider errors can contain endpoint URLs and credential hints, so the
    // detail is logged but never sent to the client.
    console.error(`[download] stat failed for source ${source.id}:`, err.message);
    return res.status(502).json({ error: 'Could not reach the storage provider' });
  }
  if (!stat) return res.status(404).json({ error: 'File missing from storage' });

  const size = stat.size || source.size || 0;
  const fileName = stat.name || source.file_name || 'movie.mp4';
  const range = parseRange(req.headers.range, size);

  // Validate the range BEFORE opening the stream: an invalid range must not
  // leak a file handle, and the 416 must not advertise a body it won't send.
  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(416).json({ error: 'Requested range not satisfiable' });
  }

  res.setHeader('Content-Type', stat.mime || source.mime || mimeFromName(fileName));
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Accept-Ranges', 'bytes');

  let upstream;
  try {
    upstream = await provider.createReadStream(source.remote_path, {
      start: range?.start,
      end: range?.end,
    });
  } catch (err) {
    console.error(`[download] open failed for source ${source.id}:`, err.message);
    return res.status(502).json({ error: 'Could not open the file for download' });
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', contentRange(range.start, range.end, size));
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    res.setHeader('Content-Length', size);
  }

  // If the provider ignored our Range and sent the full body, trim it here
  // so the client always receives exactly the bytes it asked for.
  const expected = range ? range.end - range.start + 1 : null;
  const out = expected ? limitStream(upstream, expected) : upstream;

  const fail = (err) => {
    console.error(`[download] source ${source.id} failed:`, err?.message || err);
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  };
  upstream.on('error', fail);
  out.on('error', fail);
  res.on('close', () => {
    if (upstream.destroy) upstream.destroy();
  });

  out.pipe(res);
});

/**
 * GET /api/stream/:sourceId/subtitle/:subtitleId
 * Serves a subtitle track; SRT is converted to WebVTT on the fly.
 */
streamRouter.get('/:sourceId/subtitle/:subtitleId', requireAuth, async (req, res) => {
  const subtitle = one(
    'SELECT * FROM subtitles WHERE id = ? AND source_id = ?',
    Number(req.params.subtitleId),
    Number(req.params.sourceId),
  );
  if (!subtitle) return res.status(404).json({ error: 'Subtitle not found' });

  const provider = getProvider(subtitle.provider);
  if (!provider.isConfigured()) {
    return res.status(503).json({ error: `${provider.name} is not configured` });
  }

  try {
    const upstream = await provider.createReadStream(subtitle.remote_path, {});
    const chunks = [];
    let total = 0;
    for await (const chunk of upstream) {
      total += chunk.length;
      if (total > MAX_SUBTITLE_BYTES) {
        upstream.destroy?.();
        return res.status(413).json({ error: 'Subtitle file is too large' });
      }
      chunks.push(chunk);
    }
    let text = Buffer.concat(chunks).toString('utf8');

    // Only SubRip needs converting; WebVTT is served as-is.
    const isSrt =
      subtitle.mime === 'application/x-subrip' ||
      /\.srt$/i.test(subtitle.remote_path);
    if (isSrt) {
      text = srtToVtt(text);
    }

    res.setHeader('Content-Type', isSrt ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(text);
  } catch (err) {
    // Provider errors can contain endpoint URLs and credential hints, so the
    // detail is logged but never sent to the client.
    console.error(`[stream] subtitle ${subtitle.id} failed:`, err.message);
    res.status(502).json({ error: 'Could not load the subtitle' });
  }
});

/**
 * GET /api/stream/:sourceId/media-info
 *
 * Probes the source with ffprobe and reports what the player can offer:
 * the real resolution, codecs, duration, the audio tracks, and the list of
 * qualities the viewer can switch between.
 */
streamRouter.get('/:sourceId/media-info', requireAuth, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  if (!ffmpegAvailable()) {
    return res.json({ available: false, renditions: [], audio: [], probe: null });
  }

  try {
    const { spec, headers } = await buildInputSpec(source.id, source);
    const probe = await probeMedia(spec, { headers });
    if (!probe) {
      return res.json({ available: false, renditions: [], audio: [], probe: null });
    }
    res.json({
      available: true,
      probe,
      renditions: buildRenditions(probe),
      audio: buildAudioOptions(probe),
    });
  } catch (err) {
    console.error('[media-info] probe failed:', err.message);
    res.json({ available: false, renditions: [], audio: [], probe: null });
  }
});

/**
 * GET /api/stream/:sourceId/master.m3u8
 *
 * The master playlist for a plain video file. Each entry is one quality,
 * produced on demand by ffmpeg while the viewer watches.
 */
streamRouter.get('/:sourceId/master.m3u8', requireAuthOrJob, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const audioKey = String(req.query.a || 'source');

  // The browser reports the real resolution for free once the video has
  // loaded, so the quality list can be built without probing. Probing a
  // remote file can be slow, so it is only a fallback.
  const known = readResolution(req.query);

  try {
    let renditions;
    if (known) {
      renditions = buildRenditions(null, known);
    } else {
      const { spec, headers } = await buildInputSpec(source.id, source);
      const probe = await probeMedia(spec, { headers });
      renditions = buildRenditions(probe);
    }
    res.setHeader('Content-Type', PLAYLIST_MIME);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildMasterPlaylist(renditions, source.id, audioKey));
  } catch (err) {
    console.error('[transcode] master playlist failed:', err.message);
    res.status(502).json({ error: 'Could not prepare the quality list' });
  }
});

/**
 * Read a resolution from the query string (`?w=1920&h=1080&c=h264`).
 */
function readResolution(query) {
  const width = Number(query.w);
  const height = Number(query.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height, codec: query.c ? String(query.c) : 'h264' };
}

/**
 * GET /api/stream/:sourceId/rendition.m3u8?q=720p&a=stereo
 *
 * One quality, as an HLS media playlist. The ffmpeg process is started on
 * the first request and reused for the following segment requests.
 */
streamRouter.get('/:sourceId/rendition.m3u8', requireAuthOrJob, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const quality = String(req.query.q || '720p');
  const audioKey = String(req.query.a || 'source');
  const known = readResolution(req.query);

  try {
    let rendition;
    if (known) {
      const list = buildRenditions(null, known);
      rendition = list.find((r) => r.key === quality) || list[0];
    } else {
      const { spec, headers } = await buildInputSpec(source.id, source);
      const probe = await probeMedia(spec, { headers });
      const list = buildRenditions(probe);
      rendition = list.find((r) => r.key === quality) || list[0];
    }
    if (!rendition) return res.status(400).json({ error: 'No such quality' });

    const session = await getSession(source.id, source, rendition, audioKey);
    if (!session.ready) {
      return res.status(504).json({ error: 'The conversion did not start in time' });
    }

    const playlist = await fsp.readFile(session.playlist, 'utf8');
    // ffmpeg writes plain file names ("seg00000.ts"). The browser would
    // resolve them against the playlist URL, so they are rewritten to the
    // segment route.
    const rewritten = playlist.replace(
      /^(?!#)(?!https?:)[^\r\n]+\.ts$/gm,
      `/api/stream/${source.id}/transcode/$&`,
    );

    res.setHeader('Content-Type', PLAYLIST_MIME);
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);
  } catch (err) {
    console.error('[transcode] rendition failed:', err.message);
    res.status(502).json({ error: 'Could not start the conversion' });
  }
});

/**
 * GET /api/stream/:sourceId/transcode/:file
 * One HLS segment produced by the transcoder.
 */
streamRouter.get('/:sourceId/transcode/:file', requireAuthOrJob, async (req, res) => {
  const file = path.basename(String(req.params.file));
  if (!/^[\w.-]+\.(ts|m4s|mp4)$/i.test(file)) {
    return res.status(400).json({ error: 'Invalid segment name' });
  }

  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  // Find the session that produced this segment.
  const session = findSessionForSegment(source.id, file);
  if (!session) return res.status(404).json({ error: 'Segment not found' });

  session.lastUsed = Date.now();
  const abs = path.join(session.dir, file);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return res.status(404).json({ error: 'Segment not found' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

/**
 * GET /api/stream/:sourceId/info
 * Lightweight metadata for the player (size, type, subtitle list).
 */
streamRouter.get('/:sourceId/info', requireAuth, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });
  const subtitles = q(
    'SELECT id, language, label, mime FROM subtitles WHERE source_id = ?',
    source.id,
  );

  let archive = null;
  let variants = [];
  let hlsSubtitles = [];

  if (source.kind === 'zip') {
    try {
      const provider = getProvider(source.provider);
      const entries = await listZipEntries(provider, source.remote_path);
      archive = {
        entries: entries
          .filter((e) => !e.isDir)
          .map((e) => ({
            name: e.name,
            size: e.size,
            method: e.method,
            isVideo: /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m3u8)$/i.test(e.name),
          })),
      };
    } catch (err) {
      // The parser detail is logged but not returned — it can reveal
      // internal paths and offsets.
      console.error('[stream] archive listing failed:', err.message);
      archive = { error: 'The archive could not be read', entries: [] };
    }
  }

  if (source.kind === 'hls') {
    try {
      const provider = getProvider(source.provider);
      const raw = await readWholeFile(provider, source.remote_path, 2 * 1024 * 1024);
      variants = listVariants(raw, source.remote_path);
      hlsSubtitles = listSubtitles(raw, source.remote_path);
    } catch (err) {
      variants = [];
    }
  }

  res.json({
    source: {
      id: source.id,
      provider: source.provider,
      fileName: source.file_name,
      size: source.size,
      sizeLabel: humanSize(source.size),
      mime: source.mime,
      quality: source.quality,
      label: source.label,
      kind: source.kind,
      container: source.container,
    },
    subtitles,
    archive,
    variants,
    hlsSubtitles,
  });
});

/* --------------------------------------------------------------- ZIP ---- */

/**
 * Stream a video that lives inside a .zip archive.
 *
 * The archive itself stays on the storage provider; only the bytes of the
 * requested entry are transferred.
 */
async function streamZipEntry(req, res, source, provider) {
  let entries;
  try {
    entries = await listZipEntries(provider, source.remote_path);
  } catch (err) {
    console.error('[stream] zip listing failed:', err.message);
    return res.status(502).json({ error: 'Could not read the archive' });
  }

  const entryName = req.query.entry ? String(req.query.entry) : null;
  const entry = entryName
    ? entries.find((e) => e.name === entryName && !e.isDir)
    : pickVideoEntry(entries);

  if (!entry) {
    return res.status(404).json({ error: 'No playable file inside the archive' });
  }

  const size = entry.size;
  const contentType = mimeFromName(entry.name);
  const range = parseRange(req.headers.range, size);

  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(416).json({ error: 'Requested range not satisfiable' });
  }

  let opened;
  try {
    opened = await openZipEntryStream(provider, source.remote_path, entry, {
      start: range?.start,
      end: range?.end,
    });
  } catch (err) {
    console.error('[stream] zip entry failed:', err.message);
    return res.status(502).json({ error: 'Could not open the file inside the archive' });
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Archive-Entry', encodeURIComponent(entry.name));

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', contentRange(range.start, range.end, size));
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    res.status(200);
    res.setHeader('Content-Length', size);
  }

  const fail = (err) => {
    console.error(`[stream] zip source ${source.id} failed:`, err?.message || err);
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  };
  opened.stream.on('error', fail);
  res.on('close', () => opened.stream.destroy?.());

  opened.stream.pipe(res);
}

/* --------------------------------------------------------------- HLS ---- */

/**
 * Paths each source's playlist is allowed to reference.
 *
 * When a playlist is served, every URI it mentions is recorded. A segment
 * request is only honoured when the path is in this set, so a member can
 * never use the playlist route to read an arbitrary object of the provider.
 */
const hlsAllowlist = new Map();

/** Extensions that may legitimately be fetched by an HLS player. */
const HLS_MEDIA_EXTENSIONS = new Set([
  'ts', 'm3u8', 'm4s', 'mp4', 'm4v', 'm4a', 'aac', 'mp3', 'vtt', 'webvtt',
  'key', 'cmfv', 'cmfa', 'jpg', 'jpeg', 'png', 'webp',
]);

function isMediaPath(pathValue) {
  const ext = String(pathValue).split('.').pop()?.toLowerCase() ?? '';
  return HLS_MEDIA_EXTENSIONS.has(ext);
}

/** Record every path the playlist references. */
function collectPlaylistPaths(sourceId, playlistPath, text) {
  const set = hlsAllowlist.get(sourceId) || new Set();
  set.add(playlistPath);
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let uri = null;
    if (trimmed.startsWith('#')) {
      const match = /URI="([^"]+)"/i.exec(trimmed);
      if (!match) continue;
      uri = match[1];
    } else {
      uri = trimmed;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) continue; // absolute URL
    const resolved = resolveUri(uri, playlistPath);
    // The query string is dropped before the file is fetched, so the
    // allowlist has to record the path only — otherwise a segment that is
    // referenced as "seg.ts?token=abc" would never match the request for
    // "seg.ts" and would be rejected as "not referenced by the playlist".
    if (resolved) set.add(splitUri(resolved).path);
  }
  hlsAllowlist.set(sourceId, set);
  return set;
}

/**
 * GET /api/stream/:sourceId/hls?path=<relative path>
 *
 * Serves an HLS playlist or one of its segments. Playlist URIs are rewritten
 * to point back here, so the browser fetches every segment through the same
 * authenticated route.
 */
streamRouter.get('/:sourceId/hls', requireAuthOrJob, async (req, res) => {
  const source = one('SELECT * FROM sources WHERE id = ?', Number(req.params.sourceId));
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const provider = getProvider(source.provider);
  if (!provider.isConfigured()) {
    return res.status(503).json({ error: `${provider.name} is not configured` });
  }

  // The rewritten URIs are paths relative to the provider root, so they are
  // used as-is. Without a `path` the source's own playlist is served.
  const requested = req.query.path ? String(req.query.path) : source.remote_path;

  // SECURITY: a request may only reach files inside the source's own
  // directory. Without this, any signed-in member could read any object of
  // the provider by key.
  const target = constrainToSourceDir(source.remote_path, requested);
  if (target === null) {
    return res.status(400).json({ error: 'Path is outside the playlist directory' });
  }

  const { path: targetPath } = splitUri(target);
  const isPlaylist = /\.m3u8$/i.test(targetPath);

  // Only files the playlist actually references may be fetched. On a cold
  // start (no playlist served yet) fall back to the directory + media
  // extension check.
  const allowed = hlsAllowlist.get(source.id);
  if (!isPlaylist) {
    if (allowed && allowed.size) {
      if (!allowed.has(targetPath)) {
        return res.status(400).json({ error: 'That file is not referenced by the playlist' });
      }
    } else if (!isMediaPath(targetPath)) {
      return res.status(400).json({ error: 'That file cannot be fetched through the playlist route' });
    }
  }

  try {
    if (isPlaylist) {
      const raw = await readWholeFile(provider, targetPath, 4 * 1024 * 1024);
      const jobQuery = req.query.jobToken
        ? `&jobToken=${encodeURIComponent(String(req.query.jobToken))}`
        : '';
      const { text: rewritten, rejected } = rewritePlaylist(
        raw,
        targetPath,
        `/api/stream/${source.id}/hls?path=`,
        jobQuery,
      );
      if (rejected.length) {
        console.warn(`[hls] rejected ${rejected.length} out-of-bounds URI(s) in ${targetPath}`);
      }
      // Remember what this playlist references.
      collectPlaylistPaths(source.id, targetPath, raw);
      res.setHeader('Content-Type', PLAYLIST_MIME);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.send(rewritten);
      return;
    }

    // A segment or key file — serve it with range support.
    const stat = await provider.stat(targetPath);
    if (!stat) return res.status(404).json({ error: 'Segment not found' });

    const size = stat.size;
    const parsed = parseRange(req.headers.range, size);
    if (parsed?.invalid) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    const upstream = await provider.createReadStream(targetPath, {
      start: parsed?.start,
      end: parsed?.end,
    });

    // Subtitle renditions are WebVTT — they must be served as such, or the
    // browser refuses to load them as a <track>.
    const isSubtitle = /\.(vtt|webvtt)$/i.test(targetPath);
    res.setHeader(
      'Content-Type',
      isSubtitle ? 'text/vtt; charset=utf-8' : stat.mime || mimeFromName(targetPath),
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (parsed) {
      res.status(206);
      res.setHeader('Content-Range', contentRange(parsed.start, parsed.end, size));
      res.setHeader('Content-Length', parsed.end - parsed.start + 1);
    } else {
      res.status(200);
      res.setHeader('Content-Length', size);
    }

    const fail = (err) => {
      console.error(`[hls] segment failed:`, err?.message || err);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    };
    upstream.on('error', fail);
    // If the provider ignored our Range and sent the full body, trim it here
    // so the client always receives exactly the bytes it asked for.
    const expected = parsed ? parsed.end - parsed.start + 1 : null;
    const out = expected ? limitStream(upstream, expected) : upstream;
    out.on('error', fail);
    res.on('close', () => upstream.destroy?.());
    out.pipe(res);
  } catch (err) {
    console.error('[hls] failed:', err.message);
    res.status(502).json({ error: 'Could not load the playlist segment' });
  }
});

/**
 * Constrain a requested path to the source playlist's own directory.
 * Returns the normalised path, or null when it escapes.
 */
function constrainToSourceDir(sourcePath, requested) {
  const { path: bare } = splitUri(requested);
  const normalised = normalizeProviderPath(bare);
  if (normalised === null) return null;

  // The source's own playlist is always allowed.
  if (normalised === normalizeProviderPath(sourcePath)) return normalised;

  const base = normalizeProviderPath(
    sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '',
  );
  if (base === null) return null;

  // The requested file must live inside the playlist's directory.
  if (normalised !== base && !normalised.startsWith(`${base}/`)) return null;
  return normalised;
}

/**
 * Normalise a provider-relative path, rejecting anything that escapes the
 * provider root. Returns null when the path is not acceptable.
 */
function normalizeProviderPath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (raw.startsWith('/')) return null; // absolute paths are not allowed
  const parts = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Read a whole (small) file from a provider into a string. */
async function readWholeFile(provider, remotePath, maxBytes = 5 * 1024 * 1024) {
  const upstream = await provider.createReadStream(remotePath, {});
  const chunks = [];
  let total = 0;
  for await (const chunk of upstream) {
    total += chunk.length;
    if (total > maxBytes) {
      upstream.destroy?.();
      throw new Error('File is too large to load into memory');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}


/**
 * Build a Content-Disposition header that survives non-ASCII file names.
 * RFC 5987 requires `'` to be percent-encoded in the extended value.
 */
function contentDisposition(fileName) {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const extended = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

/** Convert SubRip (.srt) to WebVTT. */
export function srtToVtt(srt) {
  const normalized = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.includes('WEBVTT')) return normalized;

  const body = normalized
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 0) return '';
      const timeIndex = lines.findIndex((l) => l.includes('-->'));
      if (timeIndex === -1) return '';
      // Both timestamps need the comma replaced, and the millisecond field
      // padded to three digits or browsers reject the cue.
      const time = lines[timeIndex]
        .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_m, hms, ms) => `${hms}.${ms.padEnd(3, '0')}`)
        .replace(/\s+/g, ' ')
        .trim();
      const text = lines.slice(timeIndex + 1).join('\n');
      return `${time}\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `WEBVTT\n\n${body}\n`;
}
