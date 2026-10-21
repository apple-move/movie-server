/**
 * End-to-end API smoke test.
 * Run: node scripts/test-api.js
 */
const BASE = process.env.BASE || 'http://localhost:3000';

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

async function req(method, path, { token, body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  if (raw) {
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, text };
}

/** Multipart upload without extra dependencies. */
async function upload(token, filePath, fields = {}) {
  const fs = await import('node:fs');
  const buf = fs.readFileSync(filePath);
  const boundary = `----ms${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
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
  console.log(`\nTesting ${BASE}`);

  /* ---------------------------------------------------------- 1. Auth */
  section('1. Auth');
  const health = await req('GET', '/api/health');
  check('health endpoint responds', health.res.ok && health.json.ok);

  // Ensure an admin exists (register if the DB is fresh).
  let login = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  if (!login.res.ok) {
    const reg = await req('POST', '/api/auth/register', {
      body: { username: 'admin', password: 'admin123', displayName: 'Admin' },
    });
    check('register first admin succeeds', reg.res.ok, reg.text);
    login = await req('POST', '/api/auth/login', {
      body: { username: 'admin', password: 'admin123' },
    });
  }
  check('login succeeds', login.res.ok, login.text);
  const token = login.json?.token;
  check('login returns a token', typeof token === 'string' && token.length > 20);
  check('login returns admin role', login.json?.user?.role === 'admin');

  const me = await req('GET', '/api/auth/me', { token });
  check('GET /api/auth/me works', me.res.ok && me.json.user.username === 'admin');

  const noAuth = await req('GET', '/api/auth/me');
  check('unauthenticated /me returns 401', noAuth.res.status === 401);

  const badPass = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'wrongpassword' },
  });
  check('wrong password rejected', badPass.res.status === 401);

  // Two logins in the same second must produce DIFFERENT tokens, otherwise
  // revoking one session would not revoke the other.
  const loginA = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const loginB = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  check('two logins produce different tokens',
    Boolean(loginA.json?.token) && Boolean(loginB.json?.token) &&
      loginA.json.token !== loginB.json.token,
    'both tokens are identical — sessions cannot be revoked individually',
  );

  /* -------------------------------------------------------- 2. Movies */
  section('2. Movies CRUD');
  // Remove leftovers from an interrupted earlier run so counts are exact.
  const staleMovies = (await req('GET', '/api/movies?limit=500', { token })).json?.movies || [];
  for (const stale of staleMovies) {
    if (stale.title === 'Inception') {
      await req('DELETE', `/api/movies/${stale.id}`, { token });
    }
  }

  const created = await req('POST', '/api/movies', {
    token,
    body: {
      title: 'Inception',
      year: 2010,
      overview: 'A thief who steals corporate secrets through dream-sharing technology.',
      genres: ['Action', 'Sci-Fi'],
      runtime: 148,
      rating: 8.8,
    },
  });
  check('create movie', created.res.status === 201, created.text);
  const movieId = created.json?.movie?.id;
  check('movie id assigned', Number.isInteger(movieId) && movieId > 0);
  check('genres stored as array', Array.isArray(created.json?.movie?.genres));

  const patched = await req('PATCH', `/api/movies/${movieId}`, {
    token,
    body: { featured: true, tagline: 'Your mind is the scene of the crime' },
  });
  check('patch movie sets featured', patched.json?.movie?.featured === true);
  check('patch movie sets tagline', patched.json?.movie?.tagline === 'Your mind is the scene of the crime');

  const listed = await req('GET', '/api/movies?limit=50', { token });
  check('list movies', (listed.json?.movies?.length || 0) >= 1);

  // The `kind` column tells the frontend whether a source is a plain file,
  // an archive entry or an HLS playlist. Without it the player cannot play
  // HLS or ZIP sources at all.
  check('sources expose their kind',
    listed.json?.movies?.every((m) => m.sources.every((s) => 'kind' in s)) !== false,
    JSON.stringify(listed.json?.movies?.[0]?.sources?.[0]),
  );

  const searched = await req('GET', '/api/movies?q=Incept', { token });
  check('search by title', searched.json?.movies?.length === 1);

  const byGenre = await req('GET', '/api/movies?genre=Sci-Fi', { token });
  check('filter by genre', (byGenre.json?.movies?.length || 0) >= 1);

  const sorted = await req('GET', '/api/movies?sort=title', { token });
  check('sort by title works', sorted.res.ok);

  const genres = await req('GET', '/api/movies/meta/genres', { token });
  check('genres meta endpoint', genres.json?.genres?.includes('Sci-Fi'));

  const providers = await req('GET', '/api/movies/meta/providers', { token });
  check('providers meta endpoint lists every instance', (providers.json?.providers?.length || 0) >= 5);
  check(
    'every provider type has a slot',
    ['local', 'r2', 'gdrive', 'mega', 'telegram'].every((id) =>
      providers.json?.providers?.some((p) => p.id === id),
    ),
    (providers.json?.providers || []).map((p) => p.id).join(','),
  );
  check(
    'local provider is always ready',
    providers.json?.providers?.find((p) => p.id === 'local')?.configured === true,
  );

  // The library must not be readable without a token.
  const anonList = await req('GET', '/api/movies');
  check('movie list requires auth', anonList.res.status === 401);
  const anonOne = await req('GET', `/api/movies/${movieId}`);
  check('movie detail requires auth', anonOne.res.status === 401);
  const anonGenres = await req('GET', '/api/movies/meta/genres');
  check('genres endpoint requires auth', anonGenres.res.status === 401);

  // Bad pagination must not 500.
  const badLimit = await req('GET', '/api/movies?limit=abc&offset=xyz', { token });
  check('invalid pagination does not 500', badLimit.res.status === 200, badLimit.text);
  const arrayLimit = await req('GET', '/api/movies?limit=1&limit=2', { token });
  check('repeated pagination params do not 500', arrayLimit.res.status === 200, arrayLimit.text);

  // A LIKE wildcard in the search term must be escaped, not matched literally.
  const wildcard = await req('GET', '/api/movies?q=%25', { token });
  check('search escapes LIKE wildcards', wildcard.res.status === 200, wildcard.text);
  check('wildcard search matches nothing extra', (wildcard.json?.movies?.length || 0) <= 1);

  const related = await req('GET', `/api/movies/${movieId}/related`, { token });
  check('related endpoint responds', related.res.ok);

  /* --------------------------------------------------- 3. Upload */
  section('3. Upload');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-test-'));
  const samplePath = path.join(tmpDir, 'sample.mp4');
  const sampleBytes = Buffer.alloc(300000);
  for (let i = 0; i < sampleBytes.length; i++) sampleBytes[i] = i % 251;
  fs.writeFileSync(samplePath, sampleBytes);

  const up = await upload(token, samplePath, {
    provider: 'local',
    folder: 'Movies/Inception (2010)',
    movieId: String(movieId),
  });
  check('upload returns 201', up.res.status === 201, JSON.stringify(up.json));
  check('upload reports size', up.json?.size === 300000, JSON.stringify(up.json?.size));
  check(
    'upload path is correct',
    up.json?.remotePath === 'Movies/Inception (2010)/sample.mp4',
    up.json?.remotePath,
  );
  const sourceId = up.json?.source?.id;
  check('upload attaches source to movie', Number.isInteger(sourceId) && sourceId > 0);

  const info = await req('GET', `/api/stream/${sourceId}/info`, { token });
  check('stream info endpoint', info.json?.source?.size === 300000);

  /* ---------------------------------------------- 4. Range requests */
  section('4. Range requests (seek support)');
  const full = await req('GET', `/api/stream/${sourceId}`, { token, raw: true });
  check('full stream returns 200', full.res.status === 200);
  check('full stream sets Accept-Ranges', full.res.headers.get('accept-ranges') === 'bytes');
  check('full stream length correct', full.buf.length === 300000, String(full.buf.length));
  check('full stream content-type set', (full.res.headers.get('content-type') || '').includes('video'));

  const mid = await req('GET', `/api/stream/${sourceId}`, {
    token, raw: true, headers: { range: 'bytes=1000-1999' },
  });
  check('range request returns 206', mid.res.status === 206);
  check(
    'range content-range header correct',
    mid.res.headers.get('content-range') === 'bytes 1000-1999/300000',
    mid.res.headers.get('content-range'),
  );
  check('range returns exactly 1000 bytes', mid.buf.length === 1000, String(mid.buf.length));
  check(
    'range bytes match the source data',
    mid.buf.equals(sampleBytes.subarray(1000, 2000)),
  );

  const open = await req('GET', `/api/stream/${sourceId}`, {
    token, raw: true, headers: { range: 'bytes=299000-' },
  });
  check('open-ended range returns 206', open.res.status === 206);
  check('open-ended range length', open.buf.length === 1000, String(open.buf.length));

  const suffix = await req('GET', `/api/stream/${sourceId}`, {
    token, raw: true, headers: { range: 'bytes=-500' },
  });
  check('suffix range returns 206', suffix.res.status === 206);
  check('suffix range length', suffix.buf.length === 500, String(suffix.buf.length));

  const tail = await req('GET', `/api/stream/${sourceId}`, {
    token, raw: true, headers: { range: 'bytes=0-0' },
  });
  check('single byte range length', tail.buf.length === 1);

  const bad = await req('GET', `/api/stream/${sourceId}`, {
    token, headers: { range: 'bytes=999999-' },
  });
  check('unsatisfiable range returns 416', bad.res.status === 416);

  /* --------------------------------------------------- 5. Download */
  section('5. Download');
  const dl = await req('GET', `/api/stream/${sourceId}/download`, { token, raw: true });
  check('download returns 200', dl.res.status === 200);
  check(
    'download sets attachment disposition',
    (dl.res.headers.get('content-disposition') || '').startsWith('attachment'),
    dl.res.headers.get('content-disposition'),
  );
  check('download returns full length', dl.buf.length === 300000, String(dl.buf.length));

  /* --------------------------------------------- 6. Watch progress */
  section('6. Watch progress');
  await req('POST', `/api/movies/${movieId}/progress`, {
    token, body: { position: 42.5, duration: 148, sourceId },
  });
  const prog = await req('GET', `/api/movies/${movieId}/progress`, { token });
  check('progress position saved', prog.json?.progress?.position_sec === 42.5);
  check('progress duration saved', prog.json?.progress?.duration_sec === 148);

  /* ----------------------------------------------------- 7. Users */
  section('7. Users and roles');
  const memberName = `member_${Date.now()}`;
  const createdUser = await req('POST', '/api/auth/users', {
    token, body: { username: memberName, password: 'member123', role: 'member' },
  });
  check('admin can create a user', createdUser.res.status === 201, createdUser.text);
  check('new user has member role', createdUser.json?.user?.role === 'member');
  const memberId = createdUser.json?.user?.id;

  const dup = await req('POST', '/api/auth/users', {
    token, body: { username: memberName, password: 'member123' },
  });
  check('duplicate username rejected', dup.res.status === 400);

  const memberLogin = await req('POST', '/api/auth/login', {
    body: { username: memberName, password: 'member123' },
  });
  check('member can log in', memberLogin.res.ok, memberLogin.text);
  const memberToken = memberLogin.json?.token;

  const memberAdmin = await req('GET', '/api/admin/status', { token: memberToken });
  check('member blocked from admin routes (403)', memberAdmin.res.status === 403);

  const memberCreate = await req('POST', '/api/movies', {
    token: memberToken, body: { title: 'Should not work' },
  });
  check('member blocked from creating movies (403)', memberCreate.res.status === 403);

  // A member must be able to edit their OWN profile — the account page
  // depends on it.
  const selfPatch = await req('PATCH', `/api/auth/users/${memberId}`, {
    token: memberToken, body: { displayName: 'My Name' },
  });
  check('member can edit their own display name',
    selfPatch.res.status === 200 &&
      (selfPatch.json?.user?.displayName === 'My Name' ||
        selfPatch.json?.user?.display_name === 'My Name'),
    `${selfPatch.res.status} ${selfPatch.text.slice(0, 90)}`,
  );

  const selfPromote = await req('PATCH', `/api/auth/users/${memberId}`, {
    token: memberToken, body: { role: 'admin' },
  });
  check('member cannot promote themselves to admin (403)', selfPromote.res.status === 403, String(selfPromote.res.status));

  const otherPatch = await req('PATCH', '/api/auth/users/1', {
    token: memberToken, body: { displayName: 'Hacked' },
  });
  check('member cannot edit another user (403)', otherPatch.res.status === 403, String(otherPatch.res.status));

  const memberStream = await req('GET', `/api/stream/${sourceId}`, { token: memberToken, raw: true });
  check('member CAN stream', memberStream.res.status === 200);
  check('member stream has full length', memberStream.buf.length === 300000);

  const users = await req('GET', '/api/auth/users', { token });
  check('admin can list users', (users.json?.users?.length || 0) >= 2);

  /* -------------------------------------------- 8. Scan and admin */
  section('8. Scan and admin');
  const scan = await req('POST', '/api/admin/scan', {
    token, body: { provider: 'local' },
  });
  check('scan local provider succeeds', scan.res.ok, scan.text);
  check('scan found at least one file', (scan.json?.stats?.scanned || 0) >= 1);
  check('scan found the video', (scan.json?.stats?.videos || 0) >= 1);

  const status = await req('GET', '/api/admin/status', { token });
  check('admin status movies', status.json?.movies >= 1);
  check('admin status sources', status.json?.sources >= 1);
  check('admin status totalSize', status.json?.totalSize >= 300000);

  const probe = await req('GET', '/api/admin/providers/local/probe', { token });
  check('provider probe succeeds', probe.json?.ok === true, probe.text);

  const browse = await req('GET', '/api/browse/remote?provider=local', { token });
  check('browse remote files', (browse.json?.files?.length || 0) >= 1);
  check('browse marks video files', browse.json?.files?.some((f) => f.isVideo));

  /* -------------------------------------------------- 9. Subtitles */
  section('9. Subtitles');
  const srtPath = path.join(tmpDir, 'sample.en.srt');
  fs.writeFileSync(
    srtPath,
    '1\r\n00:00:01,000 --> 00:00:04,000\r\nHello world\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nSecond line\r\n',
  );
  await upload(token, srtPath, { provider: 'local', folder: 'Movies/Inception (2010)' });

  const attach = await req('POST', '/api/upload/subtitle', {
    token,
    body: {
      sourceId,
      provider: 'local',
      remotePath: 'Movies/Inception (2010)/sample.en.srt',
      language: 'en',
    },
  });
  check('subtitle attached to source', attach.res.status === 201, attach.text);

  const foundSubs = await req('GET', `/api/upload/subtitles?provider=local&movieId=${movieId}`, { token });
  check('subtitle auto-detected in folder', (foundSubs.json?.subtitles?.length || 0) >= 1);

  const movieWithSubs = await req('GET', `/api/movies/${movieId}`, { token });
  check('movie exposes subtitle list', (movieWithSubs.json?.movie?.subtitles?.length || 0) >= 1);
  const subId = movieWithSubs.json?.movie?.subtitles?.[0]?.id;
  const vtt = await req('GET', `/api/stream/${sourceId}/subtitle/${subId}`, { token });
  check('subtitle served as vtt', (vtt.res.headers.get('content-type') || '').includes('text/vtt'));
  check('srt converted to vtt header', vtt.text.startsWith('WEBVTT'), vtt.text.slice(0, 30));
  check('vtt contains the cue text', vtt.text.includes('Hello world'));

  /* ------------------------------------------- 10. SPA and routing */
  section('10. SPA and routing');
  const shell = await req('GET', '/');
  check('SPA shell served', shell.res.status === 200);
  check('SPA has the app root', shell.text.includes('id="app"'));
  check('SPA references the stylesheet', shell.text.includes('/css/styles.css'));

  const deep = await req('GET', '/some/deep/route');
  check('SPA fallback works on deep routes', deep.res.status === 200);
  check('SPA fallback serves the shell', deep.text.includes('id="app"'));

  const css = await req('GET', '/css/styles.css');
  check('stylesheet served', css.res.status === 200);
  const js = await req('GET', '/js/app.js');
  check('app js served', js.res.status === 200);

  const notFound = await req('GET', '/api/nope');
  check('unknown API route returns 404', notFound.res.status === 404);

  const unauthStream = await req('GET', `/api/stream/${sourceId}`);
  check('stream requires auth (401)', unauthStream.res.status === 401);

  const unauthDownload = await req('GET', `/api/stream/${sourceId}/download`);
  check('download requires auth (401)', unauthDownload.res.status === 401);

  /* ------------------------------------------------ 11. Path safety */
  section('11. Path traversal safety');
  const traversal = await req('POST', `/api/movies/${movieId}/sources`, {
    token, body: { provider: 'local', remotePath: '../../../etc/passwd' },
  });
  check('path traversal is rejected', traversal.res.status >= 400, traversal.text);

  /* ------------------------------------------ 12. Cleanup + final */
  section('12. Cleanup');
  if (memberId) {
    const delMember = await req('DELETE', `/api/auth/users/${memberId}`, { token });
    check('delete member works', delMember.res.ok, delMember.text);
  }
  const del = await req('DELETE', `/api/movies/${movieId}`, { token });
  check('delete movie works', del.res.ok);
  const after = await req('GET', `/api/movies/${movieId}`, { token });
  check('deleted movie is gone', after.res.status === 404);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  /* ------------------------------------------- 13. Rate limiting */
  // Runs last: the limiter blocks further logins for that key.
  section('13. Rate limiting');
  const victim = `ratelimit_${Date.now()}`;
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const attempt = await req('POST', '/api/auth/login', {
      body: { username: victim, password: `wrong-${i}` },
    });
    if (attempt.res.status === 429) {
      limited = true;
      break;
    }
  }
  check('login is rate limited after repeated failures', limited);

  const limitedRes = await req('POST', '/api/auth/login', {
    body: { username: victim, password: 'admin123' },
  });
  check(
    'rate limiter returns 429 with a retry hint',
    limitedRes.res.status === 429 && limitedRes.json?.retryAfter > 0,
    limitedRes.text,
  );

  // A different account is unaffected — the limit is per IP+username.
  const otherLogin = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  check('rate limit does not affect other accounts', otherLogin.res.ok, otherLogin.text);

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
