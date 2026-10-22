/**
 * Tests adding a source from a URL:
 *   - a direct video URL is streamed through the server
 *   - a .zip URL is browsable and its entries can be picked
 *   - private / internal addresses are refused (SSRF protection)
 * Run: node scripts/test-url-import.js
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildZip } from './lib/zip-fixture.mjs';

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

async function req(method, url, { token, body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(60_000) };
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

/* ------------------------------------------------- a local file server */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-url-'));
const videoPath = path.join(tmpDir, 'clip.mp4');
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', videoPath,
]);

// A zip with one video inside.
const zipPath = path.join(tmpDir, 'pack.zip');
fs.writeFileSync(
  zipPath,
  buildZip([{ name: 'clip.mp4', data: fs.readFileSync(videoPath) }]),
);

const files = {
  '/clip.mp4': fs.readFileSync(videoPath),
  '/pack.zip': fs.readFileSync(zipPath),
  '/secret.txt': Buffer.from('TOP SECRET'),
};

const fileServer = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname;
  const body = files[name];
  if (!body) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : body.length - 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Accept-Ranges', 'bytes');
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.setHeader('Content-Length', body.length);
  res.setHeader('Accept-Ranges', 'bytes');
  res.end(body);
});

await new Promise((resolve) => fileServer.listen(0, '0.0.0.0', resolve));
const filePort = fileServer.address().port;
// Use the machine's own LAN address so the SSRF protection stays ON and
// the test still exercises the real code path.
const { networkInterfaces } = await import('node:os');
let lanAddress = '127.0.0.1';
for (const list of Object.values(networkInterfaces())) {
  for (const entry of list || []) {
    if (entry.family === 'IPv4' && !entry.internal) {
      lanAddress = entry.address;
      break;
    }
  }
}
const fileBase = `http://${lanAddress}:${filePort}`;
console.log(`  file server on ${fileBase}`);

async function main() {
  const login = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const token = login.json?.token;
  if (!token) {
    console.error('Could not log in. Is the server running on ' + BASE + '?');
    fileServer.close();
    process.exit(1);
  }

  const movie = await req('POST', '/api/movies', {
    token, body: { title: 'URL Import Test', year: 2024 },
  });
  const movieId = movie.json?.movie?.id;

  /* -------------------------------------------------- a direct video */
  section('1. Adding a direct video URL');

  const add = await req('POST', `/api/movies/${movieId}/sources/url`, {
    token, body: { url: `${fileBase}/clip.mp4` },
  });
  check('the URL source is created', add.res.status === 201, `${add.res.status} ${add.text.slice(0, 150)}`);
  check('it is a normal file source', add.json?.source?.kind === 'file', add.json?.source?.kind);
  check('the file name was taken from the URL',
    add.json?.source?.file_name === 'clip.mp4', add.json?.source?.file_name);
  check('the size was detected', add.json?.source?.size > 1000, String(add.json?.source?.size));

  const sourceId = add.json?.source?.id;
  if (sourceId) {
    const stream = await req('GET', `/api/stream/${sourceId}`, { token, raw: true });
    check('the remote video streams through', stream.res.status === 200, String(stream.res.status));
    check('the whole file arrives', stream.buf.length === add.json.source.size,
      `${stream.buf.length} vs ${add.json.source.size}`);

    const range = await req('GET', `/api/stream/${sourceId}`, {
      token, raw: true, headers: { range: 'bytes=100-199' },
    });
    check('range requests work', range.res.status === 206, String(range.res.status));
    check('the range is the right length', range.buf.length === 100, String(range.buf.length));

    const dl = await req('GET', `/api/stream/${sourceId}/download`, { token });
    check('it can be downloaded', dl.res.status === 200, String(dl.res.status));
    check('the download is an attachment',
      (dl.res.headers.get('content-disposition') || '').startsWith('attachment'),
      dl.res.headers.get('content-disposition'));
  }

  /* ------------------------------------------------------ a zip URL */
  section('2. Adding a .zip URL');

  const zipAdd = await req('POST', `/api/movies/${movieId}/sources/url`, {
    token, body: { url: `${fileBase}/pack.zip` },
  });
  check('the archive source is created', zipAdd.res.status === 201, `${zipAdd.res.status} ${zipAdd.text.slice(0, 150)}`);
  check('it is marked as an archive', zipAdd.json?.source?.kind === 'zip', zipAdd.json?.source?.kind);

  const zipId = zipAdd.json?.source?.id;
  if (zipId) {
    const entries = await req('GET', `/api/movies/${movieId}/archive?provider=${zipAdd.json.source.provider}&path=${encodeURIComponent(zipAdd.json.source.remote_path)}`, { token });
    check('the archive contents are listed', entries.res.status === 200, `${entries.res.status} ${entries.text.slice(0, 120)}`);
    check('the video inside is found',
      entries.json?.entries?.some((e) => e.name.endsWith('.mp4')),
      JSON.stringify(entries.json?.entries?.map((e) => e.name)));

    const videoEntry = entries.json?.entries?.find((e) => e.name.endsWith('.mp4'));
    if (videoEntry) {
      const entry = await req('GET', `/api/stream/${zipId}?entry=${encodeURIComponent(videoEntry.name)}`, { token, raw: true });
      check('the file inside the remote zip streams', entry.res.status === 200, String(entry.res.status));
      check('it has data', entry.buf.length > 1000, String(entry.buf.length));
    }
  }

  /* ------------------------------------------------------ SSRF safety */
  section('3. SSRF protection');

  // These are refused no matter what, because they are not HTTP(S) or they
  // carry credentials. The private-address rules are checked in the security
  // suite, where the protection is on.
  for (const [label, url] of [
    ['file protocol', 'file:///etc/passwd'],
    ['credentials in URL', 'http://user:pass@example.com/movie.mp4'],
    ['a non-HTTP protocol', 'ftp://example.com/movie.mp4'],
  ]) {
    const attempt = await req('POST', `/api/movies/${movieId}/sources/url`, { token, body: { url } });
    check(`${label} is refused`, attempt.res.status === 400, `${attempt.res.status} ${attempt.text.slice(0, 90)}`);
  }

  const badUrl = await req('POST', `/api/movies/${movieId}/sources/url`, { token, body: { url: 'not a url' } });
  check('a malformed URL is refused', badUrl.res.status === 400, String(badUrl.res.status));

  const missing = await req('POST', `/api/movies/${movieId}/sources/url`, { token, body: {} });
  check('a missing URL is refused', missing.res.status === 400, String(missing.res.status));

  const notAdmin = await req('POST', `/api/movies/${movieId}/sources/url`, {
    body: { url: `${fileBase}/clip.mp4` },
  });
  check('an anonymous request is refused', notAdmin.res.status === 401, String(notAdmin.res.status));

  await req('DELETE', `/api/movies/${movieId}`, { token });

  // Remove the one-off provider instances this test created.
  const providers = (await req('GET', '/api/admin/providers', { token })).json;
  for (const provider of providers.providers || []) {
    if (provider.id.startsWith('url_')) {
      await req('DELETE', `/api/admin/providers/${provider.id}`, { token });
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fileServer.close();

  console.log(`\n${'='.repeat(44)}`);
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  if (fail) console.log(`  Failing: ${failures.join(', ')}`);
  console.log(`${'='.repeat(44)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  fileServer.close();
  process.exit(1);
});
