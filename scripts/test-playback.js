/**
 * Real-playback test: uploads a genuine H.264/AAC MP4 and verifies the
 * browser decodes and plays it through the streaming endpoint.
 * Run: node scripts/test-playback.js
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const VIDEO = process.argv[2];

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  ${detail}`);
  }
}

if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error('Usage: node scripts/test-playback.js <video-file>');
  process.exit(1);
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message));

await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle' });
await page.fill('#login-username', 'admin');
await page.fill('#login-password', 'admin123');
await page.click('button[type=submit]');
await page.waitForSelector('.avatar', { timeout: 10000 });

const token = await page.evaluate(() => localStorage.getItem('ms_token'));
const auth = { authorization: `Bearer ${token}` };

/* Upload the real video. */
const boundary = `----pb${Date.now()}`;
const parts = [
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\nlocal\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\nMovies/Playback Test\r\n`),
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="playback-test.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`,
  ),
  fs.readFileSync(VIDEO),
  Buffer.from(`\r\n--${boundary}--\r\n`),
];
const up = await (
  await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  })
).json();
check('uploaded the real video', up.size > 0, JSON.stringify(up));

const movie = await (
  await fetch(`${BASE}/api/movies`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Playback Test', year: 2024, genres: ['Test'] }),
  })
).json();
const movieId = movie.movie.id;
await fetch(`${BASE}/api/movies/${movieId}/sources`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'local', remotePath: up.remotePath, quality: '720p' }),
});

/* Play it. */
console.log('\n  Playing the uploaded video in the browser…');
await page.goto(`${BASE}/#/watch/${movieId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.mp video', { timeout: 10000 });

await page.waitForFunction(
  () => {
    const v = document.querySelector('.player-page video');
    return v && v.readyState >= 2 && v.duration > 0;
  },
  { timeout: 20000 },
).catch(() => {});

const meta = await page.evaluate(() => {
    const v = document.querySelector('.mp video');
    return {
      readyState: v.readyState,
    duration: v.duration,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    error: v.error ? v.error.code : null,
    src: v.currentSrc,
  };
});
check('video element has metadata', meta.readyState >= 1, `readyState ${meta.readyState}`);
check('video has a valid duration', meta.duration > 0, String(meta.duration));
check('video has no error', meta.error === null, `code ${meta.error}`);
check('video decoded to real dimensions', meta.videoWidth > 0 && meta.videoHeight > 0,
  `${meta.videoWidth}x${meta.videoHeight}`);

/* Let it actually play. */
const played = await page.evaluate(async () => {
  const v = document.querySelector('.mp video');
  try { await v.play(); } catch (e) { return { error: e.message, time: v.currentTime }; }
  await new Promise((r) => setTimeout(r, 2000));
  return { currentTime: v.currentTime, paused: v.paused, error: v.error ? v.error.code : null };
});
check('video is playing', played.currentTime > 0.2, `currentTime ${played.currentTime}`);
check('video is not paused', played.paused === false);
check('no playback error during play', played.error === null, `code ${played.error}`);

/* Seeking — this is what Range requests enable. */
const seeked = await page.evaluate(async () => {
  const v = document.querySelector('.mp video');
  v.currentTime = 7.5;
  await new Promise((r) => setTimeout(r, 1500));
  return { currentTime: v.currentTime, readyState: v.readyState, error: v.error ? v.error.code : null };
});
check('seek landed near the target', Math.abs(seeked.currentTime - 7.5) < 2.0, String(seeked.currentTime));
check('seek did not error', seeked.error === null, `code ${seeked.error}`);

await page.screenshot({ path: 'screenshots/12-real-playback.png' });

/* Cleanup. */
await fetch(`${BASE}/api/movies/${movieId}`, { method: 'DELETE', headers: auth });
await browser.close();

console.log(`\n  PASSED: ${pass}   FAILED: ${fail}\n`);
process.exit(fail ? 1 : 0);
