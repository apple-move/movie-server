/**
 * Exercises every player option in a real browser.
 * Run: node scripts/test-player-options.js
 */
import { chromium } from 'playwright';
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

/** Upload a file to the local provider. */
async function upload(token, filePath, fields = {}) {
  const buf = fs.readFileSync(filePath);
  const boundary = `----pl${Date.now()}`;
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

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#login-username', 'admin');
await page.fill('#login-password', 'admin123');
await page.click('button[type=submit]');
await page.waitForSelector('.hero', { timeout: 15000 });

// Build a real clip so the player has something to decode, and attach it to
// a movie of our own — the test must not depend on a remote provider.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-player-'));
const clipPath = path.join(tmpDir, 'clip.mp4');
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  // 720p, so there are lower qualities to switch to.
  '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', clipPath,
]);

const token = await page.evaluate(() => localStorage.getItem('ms_token'));
check('the session token was captured', Boolean(token));

const up = await upload(token, clipPath, { provider: 'local', folder: 'Player Test' });
check('the test clip uploaded', up.res.status === 201, JSON.stringify(up.json));

const ownMovie = await page.evaluate(
  async ({ remotePath }) => {
    const tk = localStorage.getItem('ms_token');
    const h = { authorization: `Bearer ${tk}`, 'content-type': 'application/json' };
    const movie = await (
      await fetch('/api/movies', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ title: 'Player Option Test', year: 2024 }),
      })
    ).json();
    await fetch(`/api/movies/${movie.movie.id}/sources`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ provider: 'local', remotePath }),
    });
    return movie.movie.id;
  },
  { remotePath: up.json.remotePath },
);
check('the test movie was created', Boolean(ownMovie));

const withSource = ownMovie;

await page.goto(`${BASE}/#/watch/${withSource}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.mp video', { timeout: 15000 });

// Wait for the metadata. A remote provider can be slow to deliver the
// first bytes, so give it a generous amount of time.
await page
  .waitForFunction(
    () => {
      const v = document.querySelector('.mp video');
      return v && v.readyState >= 1 && v.duration > 0;
    },
    { timeout: 60_000 },
  )
  .catch(() => {});
await page.waitForTimeout(1500);

const player = page.locator('.mp');

/* ------------------------------------------------------------ basics */
section('1. Player basics');
check('the player is open', await player.isVisible());
check('there is a video element', (await page.locator('.mp video').count()) === 1);
check('the quality badge is shown', await page.locator('.mp__quality').isVisible());
check('the badge says something', (await page.locator('.mp__quality').innerText()).length > 0,
  await page.locator('.mp__quality').innerText());

const playback = await page.evaluate(() => {
  const v = document.querySelector('.mp video');
  return { readyState: v.readyState, duration: v.duration, paused: v.paused, error: v.error?.code ?? null };
});
check('the video has metadata', playback.readyState >= 1, JSON.stringify(playback));
check('the video has a duration', playback.duration > 0, String(playback.duration));
check('there is no playback error', playback.error === null, String(playback.error));

/* ----------------------------------------------------------- quality */
section('2. Quality control');
await page.locator('.mp__btn[title*="Video quality"]').click();
await page.waitForTimeout(500);
check('the quality menu opens', await page.locator('.mp__menu[data-menu=quality]').isVisible());

const qualityText = await page.locator('.mp__menu[data-menu=quality]').textContent();
check('the quality menu offers "Original"', qualityText.includes('Original'), qualityText.slice(0, 120));
check('the quality menu offers a converted quality',
  /\d{3,4}p/.test(qualityText), qualityText.slice(0, 160));

// Switch to a lower quality and confirm the video keeps playing.
const before = await page.evaluate(() => document.querySelector('.mp video').currentTime);
await page.locator('.mp__menu[data-menu=quality] button:has-text("360p")').first().click();
// The converted stream has to be produced first, which can take a while on a
// remote source.
await page
  .waitForFunction(
    () => {
      const v = document.querySelector('.mp video');
      return v && v.readyState >= 1 && v.currentTime > 0;
    },
    { timeout: 120_000 },
  )
  .catch(() => {});
await page.waitForTimeout(2000);

const after = await page.evaluate(() => {
  const v = document.querySelector('.mp video');
  return {
    currentTime: v.currentTime,
    paused: v.paused,
    readyState: v.readyState,
    error: v.error?.code ?? null,
    src: v.currentSrc,
    badge: document.querySelector('.mp__quality')?.textContent,
  };
});
check('the video still works after the switch', after.error === null, JSON.stringify(after));
check('the badge now shows the chosen quality',
  (after.badge || '').includes('360'), after.badge);
check('playback continues across the switch', after.currentTime > 0, JSON.stringify(after));
console.log(`      (position ${before.toFixed(1)}s -> ${after.currentTime.toFixed(1)}s)`);

// Switch back to the original.
await page.locator('.mp__btn[title*="Video quality"]').click();
await page.waitForTimeout(400);
await page.locator('.mp__menu[data-menu=quality] button:has-text("Original")').first().click();
await page.waitForTimeout(3000);
const backToOriginal = await page.evaluate(() => {
  const v = document.querySelector('.mp video');
  return { error: v.error?.code ?? null, src: v.currentSrc };
});
check('switching back to Original works', backToOriginal.error === null, JSON.stringify(backToOriginal));
check('Original streams the file directly',
  backToOriginal.src.includes('/api/stream/') && !backToOriginal.src.includes('master.m3u8'),
  backToOriginal.src);

/* -------------------------------------------------------------- speed */
section('3. Playback speed');
await page.locator('.mp__speed').click();
await page.waitForTimeout(400);
check('the speed menu opens', await page.locator('.mp__menu[data-menu=speed]').isVisible());
await page.locator('.mp__menu[data-menu=speed] button:has-text("1.5×")').click();
await page.waitForTimeout(600);
const speed = await page.evaluate(() => document.querySelector('.mp video').playbackRate);
check('the playback rate is 1.5', speed === 1.5, String(speed));

/* ---------------------------------------------------------- subtitles */
section('4. Subtitles');
await page.locator('.mp__btn[title*="Subtitles"]').click();
await page.waitForTimeout(400);
check('the subtitle menu opens', await page.locator('.mp__menu[data-menu=subtitles]').isVisible());
const subText = await page.locator('.mp__menu[data-menu=subtitles]').textContent();
// A movie without subtitles says so; one with them lists the tracks.
check('the subtitle menu is usable',
  subText.includes('Style') || subText.toLowerCase().includes('no subtitles'),
  subText.slice(0, 120));
check('the subtitle menu can be turned off',
  subText.includes('Off') || subText.toLowerCase().includes('no subtitles'),
  subText.slice(0, 120));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* -------------------------------------------------------------- audio */
section('5. Audio');
await page.locator('.mp__btn[title*="More options"]').click();
await page.waitForTimeout(400);
const menuText = await page.locator('.mp__menu[data-menu=sources]').textContent();
check('the options menu lists the video quality', menuText.includes('Video quality'), menuText.slice(0, 200));
check('the options menu lists the audio quality', menuText.includes('Audio quality'));
check('the options menu lists the aspect ratio', menuText.includes('Aspect ratio'));
check('the options menu lists the picture filter', menuText.includes('Picture filter'));
check('the options menu lists the volume boost', menuText.includes('Volume boost'));
check('the options menu lists the sleep timer', menuText.includes('Sleep timer'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ------------------------------------------------------------ filters */
section('6. Picture filters and aspect ratio');
await page.locator('.mp__btn[title*="More options"]').click();
await page.waitForTimeout(400);
await page.locator('.mp__menu[data-menu=sources] button:has-text("Dimmer")').click();
await page.waitForTimeout(600);
const filter = await page.evaluate(() => document.querySelector('.mp__video').getAttribute('data-filter'));
check('the picture filter is applied', filter === 'dim', String(filter));

await page.locator('.mp__btn[title*="More options"]').click();
await page.waitForTimeout(400);
await page.locator('.mp__menu[data-menu=sources] button:has-text("21 : 9")').click();
await page.waitForTimeout(500);
const aspect = await page.evaluate(() => document.querySelector('.mp__video').style.transform);
check('the aspect ratio is applied', aspect.includes('scale'), aspect);
await page.locator('.mp__btn[title*="More options"]').click();
await page.waitForTimeout(400);
await page.locator('.mp__menu[data-menu=sources] button:has-text("Off")').first().click();
await page.waitForTimeout(400);

/* ------------------------------------------------------------- stats */
section('7. Statistics');
await page.locator('.mp__btn[title*="Statistics"]').click();
await page.waitForTimeout(800);
check('the statistics overlay is visible', await page.locator('.mp__stats').isVisible());
const statsText = await page.locator('.mp__stats').innerText();
check('it shows the resolution', statsText.includes('Resolution'), statsText.slice(0, 100));
check('it shows the buffer', statsText.includes('Buffer'));
check('it shows the speed', statsText.includes('Speed'));
await page.locator('.mp__btn[title*="Statistics"]').click();
await page.waitForTimeout(300);

/* ---------------------------------------------------------- snapshots */
section('8. Snapshots');
const snapshot = await page.evaluate(async () => {
  const v = document.querySelector('.mp video');
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth || 320;
  canvas.height = v.videoHeight || 180;
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob ? blob.size : 0;
});
check('a snapshot can be captured', snapshot > 1000, String(snapshot));

/* ------------------------------------------------------------- loop */
section('9. A–B loop');
await page.locator('.mp__btn[title*="A–B loop"]').click();
await page.waitForTimeout(700);
check('the loop region appears', await page.locator('.mp__loop').isVisible());
await page.locator('.mp__btn[title*="A–B loop"]').click();
await page.waitForTimeout(300);
await page.locator('.mp__btn[title*="A–B loop"]').click();
await page.waitForTimeout(500);
check('the loop can be cleared', !(await page.locator('.mp__loop').isVisible()));

/* --------------------------------------------------------- bookmarks */
section('10. Bookmarks');
const bookmarksBefore = await page.evaluate(async () => {
  const token = localStorage.getItem('ms_token');
  const res = await fetch('/api/movies?limit=100', { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.movies.length;
});
await page.locator('.mp__btn[title*="Bookmark"]').click();
await page.waitForTimeout(1200);
const toastVisible = await page.locator('.mp__toast').innerText().catch(() => '');
check('a bookmark can be added', /bookmark/i.test(toastVisible), toastVisible);

/* --------------------------------------------------------- shortcuts */
section('11. Keyboard shortcuts');
await page.keyboard.press('f');
await page.waitForTimeout(700);
check('F toggles fullscreen',
  await page.evaluate(() => Boolean(document.fullscreenElement)));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.keyboard.press('?');
await page.waitForTimeout(500);
check('? opens the shortcut list', await page.locator('.mp__help').isVisible());
const helpText = await page.locator('.mp__help').innerText();
check('the shortcut list mentions the quality key', helpText.includes('Video quality'), helpText.slice(0, 200));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.keyboard.press('i');
await page.waitForTimeout(600);
check('I toggles the statistics', await page.locator('.mp__stats').isVisible());
await page.keyboard.press('i');
await page.waitForTimeout(300);

/* ------------------------------------------------------------- close */
section('12. Closing');
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
check('Escape closes the player', (await page.locator('.mp').count()) === 0);
check('the watch URL is cleared', !page.url().includes('#/watch/'), page.url());

/* ------------------------------------------------------------ errors */
section('13. Console health');
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// Clean up the movie this test created.
await page.evaluate(async (id) => {
  const tk = localStorage.getItem('ms_token');
  await fetch(`/api/movies/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tk}` },
  });
}, withSource);
fs.rmSync(tmpDir, { recursive: true, force: true });

await browser.close();

console.log(`\n${'='.repeat(44)}`);
console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
if (fail) console.log(`  Failing: ${failures.join(', ')}`);
console.log(`${'='.repeat(44)}\n`);
process.exit(fail ? 1 : 0);
