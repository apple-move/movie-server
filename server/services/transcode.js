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
 *   GET /api/stream/:id/transcode/:file -> one HLS segment
 *
 * The result is cached per (source, quality, audio) and the ffmpeg process is
 * killed once the viewer stops watching.
 */

/** How long a transcode session may sit idle before it is killed. */
const SESSION_TTL = 5 * 60 * 1000;

/** How long to wait for ffmpeg to produce the first playlist. */
const START_TIMEOUT = 45_000;

/** Running sessions, keyed by source + rendition + audio. */
const sessions = new Map();

/** Bitrate targets per rendition height. */
const BITRATE_BY_HEIGHT = {
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
  mute: null,
};

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
      ? [`${name}.exe`, `${name}`]
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

/**
 * Ask ffmpeg about a media file.
 *
 * The read is deliberately capped: a remote MP4 whose `moov` atom sits at the
 * end would otherwise make ffprobe download the whole file.
 *
 * @returns {Promise<object|null>}
 */
export function probeMedia(inputSpec, { headers = null, maxBytes = 4 * 1024 * 1024 } = {}) {
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
          // A probe that found no video stream is useless for the quality
          // list — treat it as a failure.
          resolve(parsed.video ? parsed : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
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

/**
 * Work out which qualities can be offered for a source.
 *
 * `sourceResolution` is `{width, height}` when it is already known (the
 * browser reports it for free once the video has loaded). When it is not
 * known, the probe is used as a fallback.
 *
 * The original file is only offered as a "copy" rendition when the browser
 * can decode its codec — otherwise it is transcoded to a standard profile.
 */
export function buildRenditions(probe, sourceResolution = null) {
  const width = sourceResolution?.width || probe?.video?.width || 0;
  const height = sourceResolution?.height || probe?.video?.height || 0;
  const codec = sourceResolution
    ? (sourceResolution.codec || 'h264')
    : (probe?.video?.codec || '');
  const browserCanCopy = /^(h264|avc1?)$/i.test(codec);

  const list = [];

  if (browserCanCopy) {
    list.push({
      key: 'source',
      label: height ? `Original (${height}p)` : 'Original',
      width,
      height,
      bandwidth: probe?.bitrate || 5_000_000,
      copy: true,
    });
  }

  for (const target of [1080, 720, 480, 360, 240]) {
    // Never upscale.
    if (height && target >= height) continue;
    list.push({
      key: `${target}p`,
      label: `${target}p`,
      width: Math.round((target * 16) / 9 / 2) * 2,
      height: target,
      bandwidth: BITRATE_BY_HEIGHT[target],
      copy: false,
    });
  }

  if (!list.length) {
    // The source is smaller than 240p, or the codec cannot be copied —
    // transcode to a fixed low quality so there is always something to play.
    list.push({
      key: '360p',
      label: '360p',
      width: 640,
      height: 360,
      bandwidth: BITRATE_BY_HEIGHT[360],
      copy: false,
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
 * @returns {Promise<{dir, playlist, ready}>}
 */
export async function getSession(sourceId, sourceRow, rendition, audioKey) {
  const key = `${sourceId}:${rendition.key}:${audioKey}`;

  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    if (existing.ready) return existing;
    // Still starting up.
    const ok = await waitForPlaylist(existing);
    if (ok) return existing;
    // It failed — start over.
    killSession(existing);
  }

  const outDir = path.join(config.dataRoot, 'transcode', createHash('sha1').update(key).digest('hex').slice(0, 16));
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
    sourceId,
    rendition,
    audioKey,
    dir: outDir,
    playlist: path.join(outDir, 'index.m3u8'),
    child,
    ready: false,
    lastUsed: Date.now(),
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

/** Kill sessions that have not been used for a while. */
export function cleanupSessions() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastUsed > SESSION_TTL) {
      killSession(session);
    }
  }
}

/** Kill every session (called on shutdown). */
export function stopAllSessions() {
  for (const session of [...sessions.values()]) killSession(session);
}

/**
 * Find the session that owns a generated segment file.
 */
export function findSessionForSegment(sourceId, fileName) {
  for (const session of sessions.values()) {
    if (session.sourceId !== sourceId) continue;
    if (fs.existsSync(path.join(session.dir, fileName))) return session;
  }
  return null;
}

// Periodic cleanup.
const cleanupTimer = setInterval(cleanupSessions, 60_000);
cleanupTimer.unref?.();

/** The master playlist listing every quality. */
export function buildMasterPlaylist(renditions, sourceId, audioKey) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const rendition of renditions) {
    const bandwidth = Math.round(rendition.bandwidth || 1_000_000);
    const codecs = rendition.copy ? 'avc1.4d401f,mp4a.40.2' : 'avc1.4d401f,mp4a.40.2';
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width || 0}x${rendition.height || 0},CODECS="${codecs}",NAME="${rendition.label}"`,
    );
    lines.push(`/api/stream/${sourceId}/rendition.m3u8?q=${encodeURIComponent(rendition.key)}&a=${encodeURIComponent(audioKey)}`);
  }
  return `${lines.join('\n')}\n`;
}
