import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getProvider } from '../providers/index.js';

/**
 * On-the-fly transcoding for quality control.
 *
 * A plain video file has exactly one quality. To let the viewer pick a
 * different one, ffmpeg re-encodes the file into HLS segments on demand
 * while the video is playing:
 *
 *   GET /api/stream/:id/master.m3u8      -> the list of qualities
 *   GET /api/stream/:id/rendition.m3u8   -> one quality, as an HLS playlist
 *   GET /api/stream/:id/transcode/:sid/:file -> one HLS segment
 *
 * The result is cached per (source, file version, quality, audio) and the
 * ffmpeg process is killed once the viewer stops watching.
 */

/** How long a session may sit completely idle before it is stopped. */
const IDLE_TTL = 30 * 60 * 1000;

/** The hard limit — a session never lives longer than this. */
const MAX_LIFETIME = 6 * 60 * 60 * 1000;

/** How long to wait for ffmpeg to produce the first playlist. */
const START_TIMEOUT = 45_000;

/** How many ffmpeg processes may run at the same time. */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TRANSCODE) || 3;

/** How many transcode cache directories are kept on disk. */
const MAX_CACHE_DIRS = Number(process.env.MAX_TRANSCODE_CACHE) || 8;

/** Bitrate targets per rendition height. */
const BITRATE_BY_HEIGHT = {
  2160: 14_000_000,
  1080: 5_000_000,
  720: 2_800_000,
  480: 1_400_000,
  360: 800_000,
  240: 400_000,
};

const AUDIO_BITRATE = {
  source: '192k',
  high: '192k',
  stereo: '128k',
  low: '64k',
};

/** Running sessions, keyed by their cache key. */
const sessions = new Map();

/** Sessions that are still starting, so the same work is not done twice. */
const pending = new Map();

/** The URL ffmpeg should read from — always reachable from this machine. */
export function internalUrl() {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
}

/** Is ffmpeg usable on this machine? */
export function ffmpegAvailable() {
  return Boolean(config.ffmpegPath || findBinary('ffmpeg'));
}

function findBinary(name) {
  const candidates =
    process.platform === 'win32'
      ? [`${name}.exe`, name]
      : [name, `/usr/bin/${name}`, `/usr/local/bin/${name}`];
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') || candidate.includes('\\')) {
        if (fs.existsSync(candidate)) return candidate;
      } else {
        return candidate; // rely on PATH
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function binaryPath(name) {
  if (name === 'ffmpeg' && config.ffmpegPath) return config.ffmpegPath;
  return findBinary(name);
}

/* ------------------------------------------------------------- probing */

/** Cached probe results, so a repeated request does not fork ffprobe again. */
const probeCache = new Map();
const PROBE_TTL = 10 * 60 * 1000;

/**
 * Ask ffmpeg about a media file.
 *
 * The read is deliberately capped: a remote MP4 whose `moov` atom sits at the
 * end would otherwise make ffprobe download the whole file.
 *
 * @returns {Promise<object|null>}
 */
export async function probeMedia(inputSpec, { headers = null, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const ffprobe = binaryPath('ffprobe');
    if (!ffprobe) {
      resolve(null);
      return;
    }
    const args = [
      '-v', 'error',
      // Never read more than a few MB while probing.
      '-probesize', String(maxBytes),
      '-analyzeduration', '3',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
    ];
    if (headers) args.push('-headers', headers);
    args.push('-i', inputSpec);

    execFile(
      ffprobe,
      args,
      { timeout: 20_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        try {
          const parsed = parseProbe(JSON.parse(stdout));
          // A probe that found no video stream is useless for the quality list.
          resolve(parsed.video ? parsed : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Probe a source, reusing a recent result.
 * The key includes the source id and its size, so a replaced file is probed
 * again.
 */
export async function probeSource(sourceId, sourceRow, { maxBytes } = {}) {
  const key = `${sourceId}:${sourceRow.size || 0}:${maxBytes || ''}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL) return cached.value;

  const { spec, headers } = await buildInputSpec(sourceId, sourceRow);
  const value = await probeMedia(spec, { headers, maxBytes });
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

function parseProbe(raw) {
  const streams = raw.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const format = raw.format || {};

  return {
    duration: Number(format.duration) || 0,
    bitrate: Number(format.bit_rate) || 0,
    size: Number(format.size) || 0,
    formatName: format.format_name || '',
    video: video
      ? {
          codec: video.codec_name || '',
          profile: video.profile || '',
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          fps: parseFps(video.avg_frame_rate || video.r_frame_rate),
          bitrate: Number(video.bit_rate) || 0,
          pixFmt: video.pix_fmt || '',
        }
      : null,
    audio: audios.map((a, i) => ({
      index: i,
      codec: a.codec_name || '',
      channels: Number(a.channels) || 0,
      channelLayout: a.channel_layout || '',
      language: a.tags?.language || '',
      title: a.tags?.title || '',
      bitrate: Number(a.bit_rate) || 0,
    })),
  };
}

function parseFps(value) {
  if (!value) return 0;
  const [num, den] = String(value).split('/').map(Number);
  if (!num || !den) return 0;
  return Math.round((num / den) * 100) / 100;
}

/* ----------------------------------------------------------- renditions */

/**
 * Work out which qualities can be offered for a source.
 *
 * `sourceResolution` is `{width, height, codec}` when it is already known
 * (the browser reports it for free once the video has loaded). When it is
 * not known, the probe is used as a fallback.
 *
 * The original file is only offered as a "copy" rendition when the browser
 * can decode its codec — otherwise it is transcoded to a standard profile.
 */
export function buildRenditions(probe, sourceResolution = null) {
  const width = sourceResolution?.width || probe?.video?.width || 0;
  const height = sourceResolution?.height || probe?.video?.height || 0;
  const codec = sourceResolution?.codec || probe?.video?.codec || '';
  const browserCanCopy = /^(h264|avc1?)$/i.test(codec);
  const sourceHeight = height || 1080;

  const list = [];

  if (browserCanCopy) {
    list.push({
      key: 'source',
      label: height ? `Original (${height}p)` : 'Original',
      width,
      height,
      bandwidth: probe?.bitrate || 5_000_000,
      copy: true,
      codecs: 'avc1.4d401f,mp4a.40.2',
    });
  }

  for (const target of [2160, 1080, 720, 480, 360, 240]) {
    // Never upscale.
    if (height && target >= sourceHeight) continue;
    list.push({
      key: `${target}p`,
      label: `${target}p`,
      width: Math.round((target * 16) / 9 / 2) * 2,
      height: target,
      bandwidth: BITRATE_BY_HEIGHT[target],
      copy: false,
      // The codec string must have exactly six hex digits
      // (profile, compatibility flags, level). A malformed string makes the
      // browser drop the level, and the variant disappears from the playlist.
      codecs: `avc1.4d401f,mp4a.40.2`,
    });
  }

  if (!list.length) {
    // The source is smaller than 240p, or the codec cannot be copied.
    // "source" is still offered so the original file can be played as-is.
    list.push({
      key: 'source',
      label: 'Original',
      width: width || 640,
      height: sourceHeight,
      bandwidth: 5_000_000,
      copy: false,
      codecs: 'avc1.4d401f,mp4a.40.2',
    });
    list.push({
      key: '240p',
      label: '240p',
      width: 426,
      height: 240,
      bandwidth: BITRATE_BY_HEIGHT[240],
      copy: false,
      codecs: 'avc1.4d401f,mp4a.40.2',
    });
  }

  return list;
}

/** The audio options offered for a source. */
export function buildAudioOptions(probe) {
  const options = [
    { key: 'source', label: 'Original audio' },
    { key: 'stereo', label: 'Stereo (downmix)' },
    { key: 'low', label: 'Low (64 kbps)' },
  ];
  const hasSurround = (probe?.audio || []).some((a) => a.channels >= 5);
  if (hasSurround) {
    options.splice(1, 0, { key: 'high', label: 'Surround (192 kbps)' });
  }
  return options;
}

/* --------------------------------------------------------------- input */

/**
 * Build the input for ffmpeg.
 *
 * Local files are read straight from disk; remote providers are read through
 * this server's own streaming route so ffmpeg can seek with Range requests.
 */
export async function buildInputSpec(sourceId, sourceRow) {
  const provider = getProvider(sourceRow.provider);

  if (sourceRow.provider === 'local') {
    const local = getProvider('local');
    try {
      const abs = local.resolve(sourceRow.remote_path);
      if (fs.existsSync(abs)) return { spec: abs, headers: null };
    } catch { /* fall through to HTTP */ }
  }

  // Use the loopback address so the server can always reach itself.
  const url = `${internalUrl()}/api/stream/${sourceId}`;
  const headers = config.jobToken ? `X-Job-Token: ${config.jobToken}\r\n` : null;
  return { spec: url, headers };
}

/* ------------------------------------------------------------- session */

/** The ffmpeg arguments for one rendition. */
export function buildFfmpegArgs(rendition, audioKey, outDir) {
  const args = [];

  if (rendition.copy) {
    // No re-encode for the video, but the audio may still need converting
    // (AC3/EAC3 in an MKV is not decodable by browsers).
    args.push('-c:v', 'copy');
  } else {
    args.push('-vf', `scale=-2:${rendition.height}`);
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      '-g', '48',
      '-sc_threshold', '0',
    );
  }

  if (audioKey === 'mute') {
    args.push('-an');
  } else {
    if (audioKey === 'stereo') args.push('-ac', '2');
    args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE[audioKey] || '128k', '-ar', '48000');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
    path.join(outDir, 'index.m3u8'),
  );

  return args;
}

/** Wait until ffmpeg has written the playlist. */
async function waitForPlaylist(session, timeout = START_TIMEOUT) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const stat = await fsp.stat(session.playlist);
      if (stat.size > 0) {
        session.ready = true;
        return true;
      }
    } catch { /* not yet */ }
    if (session.child?.exitCode !== null && session.child?.exitCode !== undefined) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Get (or start) the transcode session for a quality.
 *
 * @returns {Promise<{dir, playlist, ready, id}>}
 */
export async function getSession(sourceId, sourceRow, rendition, audioKey) {
  // The key includes the file size, so replacing the file behind a source
  // does not reuse a stale transcode.
  const key = `${sourceId}:${sourceRow.size || 0}:${rendition.key}:${audioKey}`;

  // A session that is still starting is reused instead of starting a second
  // ffmpeg for the same work.
  if (pending.has(key)) return pending.get(key);

  const promise = startSession(key, sourceId, sourceRow, rendition, audioKey)
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function startSession(key, sourceId, sourceRow, rendition, audioKey) {
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    if (existing.ready) return existing;
    const ok = await waitForPlaylist(existing);
    if (ok) return existing;
    killSession(existing);
  }

  // Do not start more than a few ffmpeg processes at a time.
  while (sessions.size >= MAX_CONCURRENT) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) break;
    killSession(oldest);
    await new Promise((r) => setTimeout(r, 50));
  }

  const id = createHash('sha1').update(key).digest('hex').slice(0, 16);
  const outDir = path.join(config.dataRoot, 'transcode', id);
  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(outDir, { recursive: true });

  const { spec, headers } = await buildInputSpec(sourceId, sourceRow);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (headers) args.push('-headers', headers);
  args.push('-i', spec, ...buildFfmpegArgs(rendition, audioKey, outDir));

  const ffmpeg = binaryPath('ffmpeg');
  const child = spawn(ffmpeg, args, { windowsHide: true });

  const session = {
    key,
    id,
    sourceId,
    rendition,
    audioKey,
    dir: outDir,
    playlist: path.join(outDir, 'index.m3u8'),
    child,
    ready: false,
    lastUsed: Date.now(),
    startedAt: Date.now(),
    log: '',
  };
  sessions.set(key, session);

  child.stderr?.on('data', (chunk) => {
    session.log = (session.log + chunk.toString()).slice(-2000);
  });
  child.on('error', (err) => {
    session.error = err.message;
  });
  child.on('exit', () => {
    session.exited = true;
  });

  const ok = await waitForPlaylist(session);
  if (!ok) {
    console.error(`[transcode] failed for ${key}: ${session.error || session.log || 'no playlist'}`);
  }
  return session;
}

/** Stop one session and clean up its files. */
export function killSession(session) {
  if (!session) return;
  try {
    session.child?.kill('SIGKILL');
  } catch { /* ignore */ }
  sessions.delete(session.key);
  fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Find a session by its id.
 */
export function findSessionById(sourceId, sessionId) {
  for (const session of sessions.values()) {
    if (session.id === sessionId && session.sourceId === Number(sourceId)) return session;
  }
  return null;
}

/**
 * Find the session that owns a generated segment file.
 *
 * The session id is part of the segment URL, so this is only a fallback.
 */
export function findSessionForSegment(sourceId, fileName) {
  for (const session of sessions.values()) {
    if (session.sourceId !== Number(sourceId)) continue;
    if (fs.existsSync(path.join(session.dir, fileName))) return session;
  }
  return null;
}

/** Mark a session as still in use. */
export function touchSession(session) {
  if (session) session.lastUsed = Date.now();
}

/**
 * Stop sessions that have not been used for a while, and keep the cache
 * directory count under control.
 */
export function cleanupSessions() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    const idleTooLong = now - session.lastUsed > IDLE_TTL;
    const livedTooLong = now - session.startedAt > MAX_LIFETIME;
    if (idleTooLong || livedTooLong) killSession(session);
  }
  trimCacheDir();
}

/** Delete the oldest cache directories until only a few are left. */
async function trimCacheDir() {
  const root = path.join(config.dataRoot, 'transcode');
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length <= MAX_CACHE_DIRS) return;

  // Sort by modification time, oldest first.
  const stats = await Promise.all(
    dirs.map(async (d) => {
      const full = path.join(root, d.name);
      try {
        const stat = await fsp.stat(full);
        return { full, mtime: stat.mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  const remove = stats.slice(0, stats.length - MAX_CACHE_DIRS);
  for (const { full } of remove) {
    await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Delete every cached transcode. The cache is disposable — it is rebuilt on
 * demand — so this is safe to do at startup.
 */
export async function clearTranscodeCache() {
  const root = path.join(config.dataRoot, 'transcode');
  try {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(root, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Kill every session (called on shutdown). */
export function stopAllSessions() {
  for (const session of [...sessions.values()]) killSession(session);
}

// Periodic cleanup.
const cleanupTimer = setInterval(cleanupSessions, 60_000);
cleanupTimer.unref?.();

/* ------------------------------------------------------------ playlists */

/**
 * The master playlist listing every quality.
 */
export function buildMasterPlaylist(renditions, sourceId, audioKey, query = '') {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const rendition of renditions) {
    const bandwidth = Math.round(rendition.bandwidth || 1_000_000);
    const codecs = rendition.codecs || 'avc1.4d401f,mp4a.40.2';
    const resolution = rendition.width && rendition.height
      ? `,RESOLUTION=${rendition.width}x${rendition.height}`
      : '';
    const params = new URLSearchParams({ q: rendition.key, a: audioKey });
    if (query) params.set('c', query);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution},CODECS="${codecs}",NAME="${rendition.label}"`,
    );
    lines.push(`/api/stream/${sourceId}/rendition.m3u8?${params.toString()}`);
  }
  return `${lines.join('\n')}\n`;
}
