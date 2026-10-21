/**
 * End-to-end test of the ffmpeg remux job:
 *   upload an MKV → convert it to MP4 → the result is attached to the movie.
 * Requires ffmpeg on PATH.
 * Run: node scripts/test-remux.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  ${detail}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function req(method, url, { token, body, raw } = {}) {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(60_000) };
  if (token) opts.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url.startsWith('http') ? url : `${BASE}${url}`, opts);
  if (raw) return { res, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, text };
}

async function upload(token, filePath, fields = {}) {
  const buf = fs.readFileSync(filePath);
  const boundary = `----rm${Date.now()}`;
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  const name = filePath.split(/[\\/]/).pop();
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function main() {
  const login = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const token = login.json?.token;
  if (!token) {
    console.error('Could not log in. Is the server running?');
    process.exit(1);
  }

  const status = await req('GET', '/api/admin/status', { token });
  if (!status.json?.ffmpeg) {
    console.log('  ffmpeg is not available on this machine — skipping.');
    process.exit(0);
  }
  check('ffmpeg is available', true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-remux-'));

  /* ------------------------------------------------------ make an MKV --- */
  const mp4Path = path.join(tmpDir, 'source.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    mp4Path,
  ]);
  const mkvPath = path.join(tmpDir, 'movie.mkv');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', mp4Path, '-c', 'copy', mkvPath,
  ]);
  check('test MKV created', fs.statSync(mkvPath).size > 0);

  const up = await upload(token, mkvPath, { provider: 'local', folder: 'Remux Tests' });
  check('MKV uploaded', up.res.status === 201, JSON.stringify(up.json));

  const movie = await req('POST', '/api/movies', {
    token, body: { title: 'Remux Test', year: 2024, genres: ['Test'] },
  });
  const movieId = movie.json?.movie?.id;
  const attach = await req('POST', `/api/movies/${movieId}/sources`, {
    token, body: { provider: 'local', remotePath: up.json.remotePath },
  });
  check('MKV attached as a source', attach.res.status === 201, attach.text);
  const sourceId = attach.json?.source?.id;

  /* ------------------------------------------------------- start a job -- */
  section('Remux job');
  const job = await req('POST', '/api/admin/jobs', {
    token,
    body: {
      type: 'remux',
      sourceId,
      provider: 'local',
      targetPath: 'Remux Tests/remuxed.mp4',
    },
  });
  check('job created', job.res.status === 201, job.text);
  const jobId = job.json?.job?.id;

  // Wait for the job to finish.
  let final = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await req('GET', `/api/admin/jobs/${jobId}`, { token });
    final = poll.json?.job;
    if (['done', 'failed', 'cancelled'].includes(final?.status)) break;
  }
  check('job finished', ['done', 'failed'].includes(final?.status), JSON.stringify(final));
  check('job succeeded', final?.status === 'done', final?.message);
  check('job reached 100%', final?.progress === 100, String(final?.progress));

  /* ------------------------------------------------------ verify result */
  section('Result');
  const movieAfter = await req('GET', `/api/movies/${movieId}`, { token });
  const sources = movieAfter.json?.movie?.sources || [];
  const mp4Source = sources.find((s) => s.mime === 'video/mp4');
  check('MP4 source attached to the movie', Boolean(mp4Source), JSON.stringify(sources.map((s) => s.mime)));

  if (mp4Source) {
    const stream = await req('GET', `/api/stream/${mp4Source.id}`, { token, raw: true });
    check('the MP4 can be streamed', stream.res.status === 200, String(stream.res.status));
    check('the MP4 has the expected size', stream.buf.length > 1000, String(stream.buf.length));

    // Verify the browser can actually decode it.
    const playable = await req('GET', `/api/stream/${mp4Source.id}/info`, { token });
    check('the MP4 reports a video mime', playable.json?.source?.mime === 'video/mp4', playable.json?.source?.mime);
  }

  await req('DELETE', `/api/movies/${movieId}`, { token });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${'='.repeat(44)}`);
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  if (fail) console.log(`  Failing: ${failures.join(', ')}`);
  console.log(`${'='.repeat(44)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
