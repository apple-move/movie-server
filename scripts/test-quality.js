/**
 * Tests the on-the-fly quality control (ffmpeg -> HLS on demand).
 * Run: node scripts/test-quality.js
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
  const opts = { method, headers: {}, signal: AbortSignal.timeout(120_000) };
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
  const boundary = `----q${Date.now()}`;
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
    console.error('Could not log in. Is the server running on ' + BASE + '?');
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-q-'));

  // A real 720p H.264 clip so there is something to actually transcode.
  const clip = path.join(tmpDir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', clip,
  ]);

  const up = await upload(token, clip, { provider: 'local', folder: 'Quality Tests' });
  check('test clip uploaded', up.res.status === 201, JSON.stringify(up.json));

  const movie = await req('POST', '/api/movies', {
    token, body: { title: 'Quality Test', year: 2024, genres: ['Test'] },
  });
  const movieId = movie.json?.movie?.id;
  const attach = await req('POST', `/api/movies/${movieId}/sources`, {
    token, body: { provider: 'local', remotePath: up.json.remotePath },
  });
  const sourceId = attach.json?.source?.id;
  check('source attached', Boolean(sourceId), attach.text);

  /* ------------------------------------------------------- media info */
  section('1. Media info (ffprobe)');

  const info = await req('GET', `/api/stream/${sourceId}/media-info`, { token });
  check('media-info responds', info.res.status === 200, info.text.slice(0, 100));
  check('ffmpeg is available', info.json?.available === true, JSON.stringify(info.json?.available));
  check('the probe found the video stream', Boolean(info.json?.probe?.video), JSON.stringify(info.json?.probe));
  check('the resolution was detected',
    info.json?.probe?.video?.height === 720,
    `height=${info.json?.probe?.video?.height}`);
  check('the duration was detected', info.json?.probe?.duration > 0, String(info.json?.probe?.duration));
  check('the audio track was detected', (info.json?.probe?.audio?.length || 0) >= 1);

  /* -------------------------------------------------------- renditions */
  section('2. Quality list');
  const renditions = info.json?.renditions || [];
  check('at least two qualities are offered', renditions.length >= 2, JSON.stringify(renditions.map((r) => r.key)));
  check('the original is offered', renditions.some((r) => r.key === 'source'), JSON.stringify(renditions.map((r) => r.key)));
  check('720p is NOT offered (that is the source resolution)',
    !renditions.some((r) => r.key === '720p'),
    JSON.stringify(renditions.map((r) => r.key)));
  check('480p is offered', renditions.some((r) => r.key === '480p'), JSON.stringify(renditions.map((r) => r.key)));
  check('360p is offered', renditions.some((r) => r.key === '360p'));
  check('no rendition is larger than the source',
    renditions.every((r) => r.height <= 720),
    JSON.stringify(renditions.map((r) => r.height)));
  check('the audio options are offered', (info.json?.audio?.length || 0) >= 2, JSON.stringify(info.json?.audio));

  /* ------------------------------------------------------ master list */
  section('3. Master playlist');
  const master = await req('GET', `/api/stream/${sourceId}/master.m3u8`, { token });
  check('master playlist responds', master.res.status === 200, master.text.slice(0, 120));
  check('it is an HLS playlist', master.text.startsWith('#EXTM3U'), master.text.slice(0, 40));
  check('it has the right content type',
    (master.res.headers.get('content-type') || '').includes('mpegurl'),
    master.res.headers.get('content-type'));
  const variantCount = (master.text.match(/#EXT-X-STREAM-INF/g) || []).length;
  check('it lists every quality', variantCount === renditions.length, `${variantCount} vs ${renditions.length}`);
  check('the variants link back to the renditions',
    master.text.includes('/rendition.m3u8?q='), master.text.slice(0, 200));

  /* --------------------------------------------------- real transcode */
  section('4. On-the-fly transcode');
  const started = Date.now();
  const rendition = await req('GET', `/api/stream/${sourceId}/rendition.m3u8?q=360p&a=stereo`, { token });
  const elapsed = Date.now() - started;
  check('rendition playlist responds', rendition.res.status === 200, `${rendition.res.status} ${rendition.text.slice(0, 120)}`);
  check('it is a media playlist', rendition.text.includes('#EXTINF'), rendition.text.slice(0, 120));
  const segmentRefs = (rendition.text.match(/seg\d+\.ts/g) || []).length;
  check('it lists segments', segmentRefs > 0, String(segmentRefs));
  console.log(`      (transcoded in ${(elapsed / 1000).toFixed(1)}s)`);

  /* ------------------------------------------------------- the segment */
  section('5. Segment delivery');
  const firstSegment = /seg\d+\.ts/.exec(rendition.text)?.[0];
  check('a segment name was found', Boolean(firstSegment), rendition.text.slice(0, 160));

  if (firstSegment) {
    const seg = await req('GET', `/api/stream/${sourceId}/transcode/${firstSegment}`, { token, raw: true });
    check('the segment is served', seg.res.status === 200, String(seg.res.status));
    check('the segment has data', seg.buf.length > 1000, String(seg.buf.length));
    check('it has the right content type',
      (seg.res.headers.get('content-type') || '').includes('mp2t'),
      seg.res.headers.get('content-type'));
  }

  /* ------------------------------------------------- session reuse */
  section('6. The transcode session is reused');
  const again = await req('GET', `/api/stream/${sourceId}/rendition.m3u8?q=360p&a=stereo`, { token });
  check('the same rendition is served again', again.res.status === 200, String(again.res.status));
  check('the playlist is the same', again.text === rendition.text, 'the playlist changed');

  /* ------------------------------------------------------ audio option */
  section('7. Audio options');
  const stereo = await req('GET', `/api/stream/${sourceId}/rendition.m3u8?q=360p&a=low`, { token });
  check('a different audio bitrate starts its own session', stereo.res.status === 200, String(stereo.res.status));

  /* --------------------------------------------------- path traversal */
  section('8. Segment path safety');
  const evil = await req('GET', `/api/stream/${sourceId}/transcode/..%2F..%2Fmovie-server.db`, { token });
  check('a traversal attempt is rejected', evil.res.status === 400 || evil.res.status === 404, String(evil.res.status));

  const badName = await req('GET', `/api/stream/${sourceId}/transcode/evil.sh`, { token });
  check('a non-segment name is rejected', badName.res.status === 400, String(badName.res.status));

  /* ----------------------------------------------------------- cleanup */
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
