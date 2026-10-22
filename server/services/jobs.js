import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, one, run } from '../db.js';
import { getProvider } from '../providers/index.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';

/**
 * Background jobs (ffmpeg remux / transcode).
 *
 * Browsers cannot play most `.mkv` files, so this turns them into MP4
 * without re-encoding (fast, no quality loss) and writes the result into any
 * configured storage provider.
 */

let ffmpegPath = null;

/** Locate an ffmpeg binary. */
export function findFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath;
  const candidates = [
    process.env.FFMPEG_PATH,
    'ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) {
        ffmpegPath = candidate;
        return ffmpegPath;
      }
      continue;
    }
    // Bare name: rely on PATH.
    ffmpegPath = candidate;
    return ffmpegPath;
  }
  return null;
}

/** Whether ffmpeg is available on this machine. */
export function ffmpegAvailable() {
  return Boolean(findFfmpeg());
}

/** How many ffmpeg processes may run at the same time. */
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 2;

const running = new Map();
/** Jobs waiting for a free slot. */
const queue = [];

const VALID_TYPES = new Set(['remux', 'transcode']);

/**
 * Create a job.
 *
 * @param {object} options
 * @param {'remux'|'transcode'} options.type
 * @param {number} options.sourceId     the source to convert
 * @param {string} options.provider     target provider instance id
 * @param {string} options.targetPath   destination path in that provider
 * @param {object} [options.user]       the acting user
 * @param {string} [options.ip]
 */
export function createJob({
  type = 'remux',
  sourceId,
  provider,
  targetPath,
  user = null,
  ip = null,
}) {
  if (!ffmpegAvailable()) {
    const err = new Error('ffmpeg is not installed on this server');
    err.status = 400;
    throw err;
  }
  if (!VALID_TYPES.has(type)) {
    const err = new Error(`Unknown job type: ${type}`);
    err.status = 400;
    throw err;
  }
  const source = one('SELECT * FROM sources WHERE id = ?', Number(sourceId));
  if (!source) {
    const err = new Error('Source not found');
    err.status = 404;
    throw err;
  }
  if (!provider || !targetPath) {
    const err = new Error('provider and targetPath are required');
    err.status = 400;
    throw err;
  }

  const safeTarget = sanitizeTargetPath(targetPath);

  // The duration is used to turn ffmpeg's progress into a percentage. The
  // `sources` table has no duration of its own, so it comes from the movie's
  // runtime (stored in minutes).
  const movie = source.movie_id ? one('SELECT runtime FROM movies WHERE id = ?', source.movie_id) : null;
  const durationSec = Number(movie?.runtime || 0) * 60;

  const id = crypto.randomUUID();
  run(
    `INSERT INTO jobs (id, type, status, user_id, source_id, movie_id, provider, target_path, progress, duration_sec, message)
     VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    id,
    type,
    'queued',
    user?.id ?? null,
    source.id,
    source.movie_id,
    provider,
    safeTarget,
    durationSec,
    'Queued',
  );

  audit(user, 'job.created', id, { type, sourceId: source.id, provider, targetPath: safeTarget }, ip);

  // Start on the next tick so the HTTP response is not blocked.
  setTimeout(() => enqueue(id), 50);

  return one('SELECT * FROM jobs WHERE id = ?', id);
}

/**
 * Keep the target path inside a sane folder so a job cannot overwrite
 * arbitrary objects in a bucket.
 */
function sanitizeTargetPath(targetPath) {
  const raw = String(targetPath || '').replace(/\\/g, '/');
  const parts = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') continue; // never traverse upwards
    parts.push(segment);
  }
  if (!parts.length) throw Object.assign(new Error('A destination path is required'), { status: 400 });
  return parts.join('/');
}

/** Queue a job and start it when a slot is free. */
function enqueue(id) {
  queue.push(id);
  pumpQueue();
}

function pumpQueue() {
  while (running.size < MAX_CONCURRENT_JOBS && queue.length) {
    const id = queue.shift();
    runJob(id).catch((err) => console.error('[job] failed:', err.message));
  }
}

/** Run a job to completion. */
export async function runJob(id) {
  const job = one('SELECT * FROM jobs WHERE id = ?', id);
  if (!job) throw new Error('Job not found');
  if (running.has(id)) return job;
  if (job.status === 'done' || job.status === 'cancelled' || job.status === 'failed') {
    pumpQueue();
    return job;
  }

  const source = one('SELECT * FROM sources WHERE id = ?', job.source_id);
  if (!source) {
    updateJob(id, { status: 'failed', message: 'Source no longer exists' });
    pumpQueue();
    return one('SELECT * FROM jobs WHERE id = ?', id);
  }

  let provider;
  try {
    provider = getProvider(job.provider);
  } catch (err) {
    updateJob(id, { status: 'failed', message: err.message });
    pumpQueue();
    return one('SELECT * FROM jobs WHERE id = ?', id);
  }

  const inputUrl = buildInputUrl(source);

  // ffmpeg writes to the local filesystem; the result is uploaded to the
  // provider afterwards.
  const tmpDir = path.join(config.dataRoot, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${id}-${path.basename(job.target_path)}`);

  const args = ['-hide_banner', '-y'];
  // The job token travels in a header so it never lands in an access log.
  if (config.jobToken) {
    args.push('-headers', `X-Job-Token: ${config.jobToken}\r\n`);
  }
  args.push('-i', inputUrl);
  args.push('-c:v', job.type === 'remux' ? 'copy' : 'libx264');
  if (job.type !== 'remux') {
    args.push('-preset', 'veryfast', '-crf', '20');
  }
  args.push('-c:a', job.type === 'remux' ? 'copy' : 'aac');
  args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1');
  args.push(tmpFile);

  updateJob(id, { status: 'running', message: 'Converting…' });

  return new Promise((resolve) => {
    const child = spawn(findFfmpeg(), args, { windowsHide: true });
    running.set(id, child);

    let stderrTail = '';
    let cancelled = false;

    child.stdout.on('data', (chunk) => {
      // ffmpeg -progress emits "out_time_us=..." and "out_time_ms=...".
      const text = chunk.toString();
      const match = /out_time_us=(\d+)/.exec(text) || /out_time_ms=(\d+)/.exec(text);
      if (!match) return;
      const micros = /out_time_us=/.test(text) ? Number(match[1]) : Number(match[1]) * 1000;
      const seconds = micros / 1_000_000;
      const duration = Number(job.duration_sec || 0);
      if (duration > 0) {
        const progress = Math.min(99, Math.round((seconds / duration) * 100));
        updateJob(id, { progress, message: `Converting… ${progress}%` });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on('error', (err) => {
      running.delete(id);
      fs.rm(tmpFile, { force: true }, () => {});
      updateJob(id, { status: 'failed', message: err.message });
      pumpQueue();
      resolve(one('SELECT * FROM jobs WHERE id = ?', id));
    });

    child.on('close', async (code) => {
      running.delete(id);
      pumpQueue();

      // A cancelled job keeps its cancelled status.
      const current = one('SELECT status FROM jobs WHERE id = ?', id);
      if (current?.status === 'cancelled') {
        fs.rm(tmpFile, { force: true }, () => {});
        resolve(one('SELECT * FROM jobs WHERE id = ?', id));
        return;
      }

      if (code !== 0) {
        fs.rm(tmpFile, { force: true }, () => {});
        updateJob(id, {
          status: 'failed',
          message: `ffmpeg exited with code ${code}: ${stderrTail.split('\n').slice(-3).join(' ')}`,
        });
        resolve(one('SELECT * FROM jobs WHERE id = ?', id));
        return;
      }

      try {
        updateJob(id, { status: 'uploading', message: 'Uploading result…', progress: 99 });
        const stat = statSync(tmpFile);
        await provider.upload(job.target_path, tmpFile, { size: stat.size });
        fs.rm(tmpFile, { force: true }, () => {});

        // Attach the result to the movie so it shows up in the library
        // straight away (this is how "download HLS as MP4" works).
        if (job.movie_id) {
          run(
            `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind)
             VALUES (?,?,?,?,?,?,?,?,'file')
             ON CONFLICT(provider, remote_path) DO UPDATE SET
               movie_id = excluded.movie_id, size = excluded.size`,
            job.movie_id,
            job.provider,
            job.target_path,
            path.basename(job.target_path),
            stat.size,
            'video/mp4',
            'MP4',
            path.basename(job.target_path),
          );
        }

        updateJob(id, {
          status: 'done',
          progress: 100,
          message: 'Finished',
          output: job.target_path,
        });
      } catch (err) {
        fs.rm(tmpFile, { force: true }, () => {});
        updateJob(id, { status: 'failed', message: `Upload failed: ${err.message}` });
      }
      resolve(one('SELECT * FROM jobs WHERE id = ?', id));
    });
  });
}

/**
 * The ffmpeg input URL.
 *
 * ffmpeg needs a seekable input for remuxing, so the job reads the source
 * through the normal streaming route. The job token is sent as a header
 * (see the `-headers` flag) so it never appears in an access log.
 */
function buildInputUrl(source) {
  const base = config.publicUrl.replace(/\/$/, '');
  return `${base}/api/stream/${source.id}`;
}

function updateJob(id, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  params.push(id);
  run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

export function listJobs({ limit = 50, status = null } = {}) {
  if (status) {
    return q('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit);
  }
  return q('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', limit);
}

export function getJob(id) {
  return one('SELECT * FROM jobs WHERE id = ?', id);
}

export function cancelJob(id) {
  const child = running.get(id);
  if (child) {
    child.kill();
    running.delete(id);
  }
  // Remove it from the queue too, in case it never started.
  const queueIndex = queue.indexOf(id);
  if (queueIndex !== -1) queue.splice(queueIndex, 1);

  const job = getJob(id);
  if (!job) return null;
  updateJob(id, { status: 'cancelled', message: 'Cancelled' });
  pumpQueue();
  return getJob(id);
}
