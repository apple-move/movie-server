/**
 * Frontend smoke test — drives a real browser through the whole UI.
 * Run: node scripts/test-ui.js
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = path.join(process.cwd(), 'screenshots');

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

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  /* ------------------------------------------------------- 1. Login */
  section('1. Login screen');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('redirected to login', page.url().includes('#/login'), page.url());
  check('login form visible', await page.locator('.auth-card').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '01-login.png') });

  // Wrong password shows an error
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'wrongpass');
  await page.click('button[type=submit]');
  await page.waitForSelector('.alert--error:not([hidden])', { timeout: 5000 });
  check('bad login shows error', await page.locator('.alert--error').isVisible());

  // Correct password
  await page.fill('#login-password', 'admin123');
  await page.click('button[type=submit]');
  await page.waitForSelector('.topbar__right .avatar', { timeout: 8000 });
  check('login succeeds and shows avatar', await page.locator('.avatar').isVisible());
  check('redirected to home', page.url().includes('#/'), page.url());

  /* --------------------------------------------------------- 2. Home */
  section('2. Home page');
  await page.waitForSelector('#view .hero, #view .empty', { timeout: 8000 });
  await page.waitForTimeout(800);
  check('nav is visible after login', await page.locator('#nav').isVisible());
  const hasContent = await page.locator('#view').innerText();
  check('home has content', hasContent.trim().length > 0, hasContent.slice(0, 60));

  // Seed a movie so there is something to render.
  const token = await page.evaluate(() => localStorage.getItem('ms_token'));
  check('token stored in localStorage', !!token);

  const posterPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ui-'));

  // Use a real, decodable MP4 so the player is exercised properly.
  const videoPath = path.join(tmpDir, 'The.Matrix.1999.1080p.mp4');
  const realVideo = process.env.TEST_VIDEO;
  if (realVideo && fs.existsSync(realVideo)) {
    fs.copyFileSync(realVideo, videoPath);
  } else {
    // A minimal but valid MP4 (generated once and cached in the temp dir).
    fs.writeFileSync(videoPath, fs.readFileSync(path.join(process.cwd(), 'scripts', 'fixtures', 'sample.mp4')));
  }

  // Upload via the API (multipart) so the UI has real data.
  const boundary = `----ui${Date.now()}`;
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\nlocal\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\nMovies/The Matrix (1999)\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="The.Matrix.1999.1080p.mkv"\r\n` +
        `Content-Type: video/x-matroska\r\n\r\n`,
    ),
    fs.readFileSync(videoPath),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });

  const created = await (
    await fetch(`${BASE}/api/movies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'The Matrix',
        year: 1999,
        overview:
          'A computer hacker learns the true nature of his reality, and his role in the war against its controllers.',
        genres: ['Action', 'Science Fiction'],
        runtime: 136,
        rating: 8.7,
        featured: true,
        poster_url: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        backdrop_url: 'https://image.tmdb.org/t/p/w1280/fNG7i7RqMErkcqhohV2a6cV1Ehy.jpg',
      }),
    })
  ).json();
  const movieId = created.movie.id;

  // A second, unrelated title so the search assertion is meaningful.
  const other = await (
    await fetch(`${BASE}/api/movies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'Blade Runner 2049',
        year: 2017,
        overview: 'A young blade runner discovers a long-buried secret that leads him to track down former LAPD blade runner Rick Deckard.',
        genres: ['Science Fiction', 'Drama'],
        runtime: 164,
        rating: 8.0,
      }),
    })
  ).json();
  const otherMovieId = other.movie.id;
  // Attach the uploaded video to the movie.
  const files = await (
    await fetch(`${BASE}/api/browse/remote?provider=local`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const videoFile = files.files.find((f) => f.name.endsWith('.mkv'));
  await fetch(`${BASE}/api/movies/${movieId}/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ provider: 'local', remotePath: videoFile.path, quality: '1080p' }),
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  check('hero banner rendered', await page.locator('.hero').isVisible());
  check('hero shows the title', (await page.locator('.hero__title').innerText()).includes('Matrix'));
  check('movie cards rendered', (await page.locator('.card').count()) > 0);
  check('poster image loaded', await page.locator('.card__poster img').first().isVisible());
  check('rows rendered', (await page.locator('.row__scroller').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '02-home.png'), fullPage: false });

  /* ------------------------------------------------------ 3. Library */
  section('3. Library page');
  await page.click('a[data-nav=library]');
  await page.waitForTimeout(900);
  check('library grid rendered', await page.locator('.grid').isVisible());
  check('library has cards', (await page.locator('.card').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '03-library.png') });

  /* ------------------------------------------------------- 4. Search */
  section('4. Search');
  const totalCards = await page.locator('.card').count();
  await page.fill('#search-input', 'Matrix');
  await page.waitForTimeout(1000);
  const searchCards = await page.locator('.card').count();
  check('search narrows the result set', searchCards < totalCards, `${searchCards} of ${totalCards}`);
  const titles = await page.locator('.card__title').allInnerTexts();
  check(
    'every result matches the query',
    titles.length > 0 && titles.every((t) => t.toLowerCase().includes('matrix')),
    titles.join(', '),
  );
  await page.fill('#search-input', '');
  await page.waitForTimeout(800);

  /* --------------------------------------------------- 5. Detail modal */
  section('5. Movie detail modal');
  await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // Find the card by its title rather than by position — the grid order
  // depends on when the movie was created.
  await page.locator('.card').filter({ hasText: 'The Matrix' }).first().click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  check('modal opened', await page.locator('.modal').isVisible());
  check('modal shows title', (await page.locator('.modal__title').innerText()).includes('Matrix'));
  check('modal lists sources', (await page.locator('.source-item').count()) > 0);
  check('modal has download button', await page.locator('.modal a.btn:has-text("Download")').first().isVisible());
  await page.screenshot({ path: path.join(SHOTS, '04-detail.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('modal closes on Escape', await page.locator('#modal-root').isHidden());

  /* -------------------------------------------------------- 6. Player */
  section('6. Player');
  await page.goto(`${BASE}/#/watch/${movieId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mp video', { timeout: 5000 });
  check('player overlay opened', await page.locator('.mp').isVisible());
  check('video element present', (await page.locator('.mp video').count()) === 1);
  check('controls visible', await page.locator('.mp__bottom').isVisible());
  check('scrub bar present', await page.locator('.mp__scrub').isVisible());

  // The stage must fill the viewport — otherwise the control bar floats in
  // the middle of the screen and the menus open off-screen.
  const stage = await page.locator('.mp__stage').boundingBox();
  const viewport = page.viewportSize();
  check('the stage fills the viewport',
    stage && viewport && stage.height > viewport.height * 0.8,
    `stage ${stage?.height} vs viewport ${viewport?.height}`,
  );
  const bar = await page.locator('.mp__bottom').boundingBox();
  check('the control bar sits at the bottom of the screen',
    bar && viewport && Math.abs(bar.y + bar.height - viewport.height) < 4,
    `bar bottom ${bar ? bar.y + bar.height : '?'} vs ${viewport?.height}`,
  );
  check('speed control present', await page.locator('.mp__speed').isVisible());
  check('source menu button present', await page.locator('.mp__btn[title*="More options"]').isVisible());
  check('help button present', await page.locator('.mp__btn[title*="shortcuts"]').isVisible());
  check('cast/info button present', await page.locator('.mp__btn[title*="Cast"]').first().isVisible());
  check('download button present', await page.locator('.mp__btn[title*="Download"]').first().isVisible());
  check('sleep timer button present', await page.locator('.mp__btn[title*="Sleep timer"]').first().isVisible());
  check('share button present', await page.locator('.mp__btn[title*="share link"]').first().isVisible());
  check('every player button has an svg icon',
    (await page.locator('.mp__btn svg').count()) >= 14,
    String(await page.locator('.mp__btn svg').count()),
  );

  // The source menu should list the sources.
  await page.locator('.mp__btn[title*="More options"]').click();
  await page.waitForTimeout(400);
  check('source menu opens', await page.locator('.mp__menu[data-menu=sources]').isVisible());

  // The menu must be fully on-screen — it is positioned from the bottom of
  // the stage, so a collapsed stage pushes it above the viewport.
  const menuBox = await page.locator('.mp__menu[data-menu=sources]').boundingBox();
  const vp = page.viewportSize();
  check('the source menu is fully on-screen',
    menuBox && vp && menuBox.y >= 0 && menuBox.y + menuBox.height <= vp.height + 2,
    `menu y=${menuBox?.y} h=${menuBox?.height} vs ${vp?.height}`,
  );
  // Every control must be reachable from the menu, not just from the bar.
  // textContent is used because the menu scrolls — innerText only returns
  // what is currently visible.
  const menuText = await page.locator('.mp__menu[data-menu=sources]').textContent();
  check('menu exposes the aspect ratio', menuText.includes('Aspect ratio'), menuText.slice(0, 120));
  check('menu exposes the picture filter', menuText.includes('Picture filter'));
  check('menu exposes the volume boost', menuText.includes('Volume boost'));
  check('menu exposes the chapters', menuText.includes('Chapters'));
  check('menu exposes the bookmarks', menuText.includes('Bookmarks'));
  check('menu exposes the sleep timer', menuText.includes('Sleep timer'));
  check('menu exposes the audio track', menuText.includes('Audio track'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // The speed menu.
  await page.locator('.mp__speed').click();
  await page.waitForTimeout(300);
  check('speed menu opens', await page.locator('.mp__menu[data-menu=speed]').isVisible());
  await page.locator('.mp__menu[data-menu=speed] button:has-text("1.5×")').click();
  await page.waitForTimeout(300);
  const speed = await page.locator('.mp__speed').innerText();
  check('speed changes to 1.5x', speed.includes('1.5'), speed);

  // Statistics overlay.
  await page.locator('.mp__btn[title*="Statistics"]').click();
  await page.waitForTimeout(600);
  check('statistics overlay visible', await page.locator('.mp__stats').isVisible());
  check('statistics show the resolution', (await page.locator('.mp__stats').innerText()).includes('Resolution'));

  // Keyboard help.
  await page.locator('.mp__btn[title*="shortcuts"]').click();
  await page.waitForTimeout(300);
  check('keyboard help opens', await page.locator('.mp__help').isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Verify the video element actually received bytes from the range endpoint.
  const playback = await page.evaluate(async () => {
    const video = document.querySelector('.mp video');
    const res = await fetch(video.currentSrc, { headers: { Range: 'bytes=0-1023' } });
    const buf = await res.arrayBuffer();
    return { status: res.status, length: buf.byteLength, range: res.headers.get('content-range') };
  });
  check('player source supports range', playback.status === 206, `status ${playback.status}`);
  check('player received the requested bytes', playback.length === 1024, String(playback.length));
  check('player got a valid content-range', (playback.range || '').startsWith('bytes 0-1023/'), playback.range);

  await page.screenshot({ path: path.join(SHOTS, '05-player.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  check('player closes on Escape', (await page.locator('.mp').count()) === 0);

  // The URL must not keep pointing at a closed player.
  check('closing the player clears the watch URL',
    !page.url().includes('#/watch/'),
    page.url(),
  );

  // The detail sheet must not stay open behind the player.
  await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('.card').filter({ hasText: 'The Matrix' }).first().click();
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.locator('.modal__actions a.btn--accent').click();
  await page.waitForTimeout(1400);
  check('player opens from the detail sheet', (await page.locator('.mp').count()) === 1);
  check('detail sheet is closed behind the player',
    await page.locator('#modal-root').isHidden(),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  check('closing the player leaves no modal behind',
    await page.locator('#modal-root').isHidden(),
  );

  /* --------------------------------------------------------- 7. Admin */
  section('7. Admin panel');
  await page.click('a[data-nav=admin]');
  await page.waitForTimeout(1200);
  check('admin page rendered', await page.locator('.admin').isVisible());
  check('stat cards shown', (await page.locator('.stat').count()) >= 4);
  check('providers table shown', (await page.locator('.panel table').count()) > 0);
  check('local provider shows Ready', (await page.locator('.pill--ok').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '06-admin-storage.png') });

  // Movies tab
  await page.click('.tab:has-text("Movies")');
  await page.waitForTimeout(1200);
  check('movies tab shows the library', (await page.locator('.admin table tbody tr').count()) > 0);
  check('movies tab has a TMDB search box', await page.locator('input[placeholder*="TMDB"]').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '07-admin-movies.png') });

  // Upload tab
  await page.click('.tab:has-text("Upload")');
  await page.waitForTimeout(900);
  check('upload tab shows a dropzone', await page.locator('.dropzone').isVisible());
  check('upload tab has provider select', await page.locator('select').first().isVisible());
  await page.screenshot({ path: path.join(SHOTS, '08-admin-upload.png') });

  // Jobs tab
  await page.click('.tab:has-text("Jobs")');
  await page.waitForTimeout(900);
  check('jobs tab rendered', (await page.locator('.panel').count()) > 0);

  // Users tab
  await page.click('.tab:has-text("Users")');
  await page.waitForTimeout(900);
  check('users tab lists users', (await page.locator('.admin table tbody tr').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '09-admin-users.png') });

  // Security tab
  await page.click('.tab:has-text("Security")');
  await page.waitForTimeout(1200);
  check('security tab shows sessions', (await page.locator('.admin table tbody tr').count()) > 0);
  check('security tab has a ban form', await page.locator('input[placeholder*="203"]').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '12-admin-security.png') });

  // Settings tab
  await page.click('.tab:has-text("Settings")');
  await page.waitForTimeout(900);
  check('settings tab rendered', (await page.locator('.panel').count()) > 0);

  /* ------------------------------------------------------- 7b. Account */
  section('7b. Account page');
  await page.goto(`${BASE}/#/account`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  check('account page rendered', await page.locator('.admin').isVisible());
  check('account shows the 2FA panel', (await page.locator('h3:has-text("Two-factor")').count()) > 0);
  check('account shows the profile panel', (await page.locator('h3:has-text("Profile")').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '13-account.png') });

  /* ------------------------------------------------------- 8. Theme */
  section('8. Theme toggle');
  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  check('theme switched to light', theme === 'light');
  await page.screenshot({ path: path.join(SHOTS, '10-light-theme.png') });
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);

  /* ------------------------------------------------- 9. Mobile view */
  section('9. Responsive layout');
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(BASE, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(1200);
  const navHidden = await mobile.locator('#nav').isHidden();
  check('mobile hides the desktop nav', navHidden);
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 2,
  );
  check('no horizontal overflow on mobile', overflow);
  await mobile.screenshot({ path: path.join(SHOTS, '11-mobile.png') });
  await mobile.close();

  /* ----------------------------------------------- 10. Console health */
  section('10. Console health');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
  );
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Remove the movies this test created so repeat runs stay deterministic.
  for (const id of [movieId, otherMovieId]) {
    await fetch(`${BASE}/api/movies/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  await browser.close();

  console.log(`\n${'='.repeat(44)}`);
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  if (fail) console.log(`  Failing: ${failures.join(', ')}`);
  console.log(`  Screenshots: ${SHOTS}`);
  console.log(`${'='.repeat(44)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUI test crashed:', err);
  process.exit(1);
});
