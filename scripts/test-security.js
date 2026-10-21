/**
 * Security regression tests for the fixes made after the security review.
 * Run: node scripts/test-security.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(20_000) };
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
  const boundary = `----sec${Date.now()}`;
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
  const memberName = `sec_${Date.now()}`;
  const member = await req('POST', '/api/auth/users', {
    token, body: { username: memberName, password: 'member12345', role: 'member' },
  });
  const memberId = member.json?.user?.id;
  const memberToken = (await req('POST', '/api/auth/login', {
    body: { username: memberName, password: 'member12345' },
  })).json?.token;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sec-'));

  /* ---------------------------------------------- C1: HLS path read ---- */
  section('1. HLS path traversal / arbitrary file read');

  // A "secret" file that sits next to the playlist.
  const secretPath = path.join(tmpDir, 'secret.txt');
  fs.writeFileSync(secretPath, 'TOP-SECRET-CONTENT');
  const secretUp = await upload(token, secretPath, { provider: 'local', folder: 'Sec Tests' });
  check('secret file uploaded', secretUp.res.status === 201, JSON.stringify(secretUp.json));

  // An HLS playlist that lives in the same folder.
  const hlsDir = path.join(tmpDir, 'hls');
  fs.mkdirSync(hlsDir, { recursive: true });
  fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(hlsDir, 'seg1.ts'), Buffer.alloc(1000, 1));
  const hlsUp = await upload(token, path.join(hlsDir, 'index.m3u8'), { provider: 'local', folder: 'Sec Tests' });

  const hlsMovie = await req('POST', '/api/movies', { token, body: { title: 'Sec HLS', year: 2024 } });
  const hlsMovieId = hlsMovie.json?.movie?.id;
  const hlsAttach = await req('POST', `/api/movies/${hlsMovieId}/sources`, {
    token, body: { provider: 'local', remotePath: hlsUp.json.remotePath },
  });
  const hlsSourceId = hlsAttach.json?.source?.id;
  check('hls source attached', Boolean(hlsSourceId), hlsAttach.text);

  // A member must not be able to read an arbitrary object of the provider.
  const escape = await req(
    'GET',
    `/api/stream/${hlsSourceId}/hls?path=${encodeURIComponent('Sec Tests/secret.txt')}`,
    { token: memberToken },
  );
  check('sibling file is NOT readable', !escape.text.includes('TOP-SECRET'), escape.text.slice(0, 80));
  check('sibling file request is rejected', escape.res.status >= 400, String(escape.res.status));

  const escape2 = await req(
    'GET',
    `/api/stream/${hlsSourceId}/hls?path=${encodeURIComponent('../secret.txt')}`,
    { token: memberToken },
  );
  check('parent traversal is rejected', escape2.res.status >= 400, String(escape2.res.status));

  const escape3 = await req(
    'GET',
    `/api/stream/${hlsSourceId}/hls?path=${encodeURIComponent('../../etc/passwd')}`,
    { token: memberToken },
  );
  check('deep traversal is rejected', escape3.res.status >= 400, String(escape3.res.status));

  // A crafted playlist that tries to escape with "..".
  const evilPath = path.join(tmpDir, 'evil.m3u8');
  fs.writeFileSync(evilPath, '#EXTM3U\n#EXTINF:4.0,\n../../secret.txt\n#EXT-X-ENDLIST\n');
  const evilUp = await upload(token, evilPath, { provider: 'local', folder: 'Sec Tests' });
  const evilMovie = await req('POST', '/api/movies', { token, body: { title: 'Evil HLS', year: 2024 } });
  const evilSource = await req('POST', `/api/movies/${evilMovie.json?.movie?.id}/sources`, {
    token, body: { provider: 'local', remotePath: evilUp.json.remotePath },
  });
  const evilId = evilSource.json?.source?.id;
  const evilPlaylist = await req('GET', `/api/stream/${evilId}/hls`, { token: memberToken });
  check('escaping playlist is served', evilPlaylist.res.status === 200, String(evilPlaylist.res.status));
  check(
    'escaping URI is rewritten to nothing',
    !evilPlaylist.text.includes('secret.txt'),
    evilPlaylist.text.slice(0, 200),
  );

  /* ------------------------------------------- H1: provider config ---- */
  section('2. Provider editing keeps credentials');

  const created = await req('POST', '/api/admin/providers', {
    token,
    body: { id: 'sectest', type: 'local', name: 'Sec Test Disk', config: { root: path.join(tmpDir, 'lib2') } },
  });
  check('provider created', created.res.status === 201, created.text);
  check('provider response hides the config', created.json?.provider?.config === '{}', created.json?.provider?.config);

  // Editing only the name must not wipe the config.
  const renamed = await req('PATCH', '/api/admin/providers/sectest', {
    token, body: { name: 'Renamed Disk', config: { root: '' } },
  });
  check('provider renamed', renamed.res.status === 200, renamed.text);

  const scanAfter = await req('POST', '/api/admin/scan', { token, body: { provider: 'sectest' } });
  check('provider still works after a rename', scanAfter.res.status === 200, scanAfter.text);

  /* --------------------------------------- H2: disabled provider ----- */
  section('3. Disabled providers are unusable');
  await req('PATCH', '/api/admin/providers/sectest', { token, body: { enabled: false } });
  const disabledUse = await req('GET', '/api/browse/remote?provider=sectest', { token });
  check('disabled provider cannot be browsed', disabledUse.res.status >= 400, disabledUse.text);
  const disabledStatus = await req('GET', '/api/admin/status', { token });
  check(
    'disabled provider shows as disabled',
    disabledStatus.json?.providers?.find((p) => p.id === 'sectest')?.enabled === false,
  );
  await req('DELETE', '/api/admin/providers/sectest', { token });

  /* --------------------------------------- H4: register creates a session */
  section('4. Registration creates a working session');
  const newName = `reg_${Date.now()}`;
  const reg = await req('POST', '/api/auth/register', {
    body: { username: newName, password: 'register123' },
  });
  check('register returns 403 once the first admin exists', reg.res.status === 403, reg.text);

  /* ------------------------------------- M14: rate limit cannot be spoofed */
  section('5. Rate limiting');
  const victim = `ratelimit_${Date.now()}`;
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const attempt = await req('POST', '/api/auth/login', {
      body: { username: victim, password: `wrong-${i}` },
      // A different spoofed IP on every request must not reset the counter.
      headers: { 'x-forwarded-for': `10.0.0.${i % 250}` },
    });
    if (attempt.res.status === 429) {
      limited = true;
      break;
    }
  }
  check('spoofed X-Forwarded-For cannot bypass the limit', limited);

  /* ------------------------------------- M15: provider secrets redacted */
  section('6. Provider credentials are never returned');
  const providers = await req('GET', '/api/admin/providers', { token });
  const r2 = providers.json?.providers?.find((p) => p.id === 'r2');
  check('provider list has no config field', r2 && r2.config === undefined, JSON.stringify(r2));

  /* ------------------------------------- sessions: revocation works --- */
  section('7. Session revocation');
  const sessions = await req('GET', '/api/admin/sessions', { token });
  const memberSession = sessions.json?.sessions?.find((s) => s.user_id === memberId);
  check('member session is listed', Boolean(memberSession), `user id ${memberId}`);

  if (memberSession) {
    await req('DELETE', `/api/admin/sessions/${memberSession.id}`, { token });
    const afterRevoke = await req('GET', '/api/auth/me', { token: memberToken });
    check('revoked session is rejected', afterRevoke.res.status === 401, String(afterRevoke.res.status));
  }

  /* ------------------------------------- image proxy is scoped -------- */
  section('8. Image proxy is scoped to the library');
  const imageAsMember = await req(
    'GET',
    `/api/images?provider=local&path=${encodeURIComponent('Sec Tests/secret.txt')}`,
    { token: memberToken },
  );
  check(
    'member cannot read an unknown image path',
    !imageAsMember.text.includes('TOP-SECRET'),
    imageAsMember.text.slice(0, 80),
  );
  check('unknown image path is rejected', imageAsMember.res.status >= 400, String(imageAsMember.res.status));

  /* ------------------------------------- job token is not in the query */
  section('9. Job token handling');
  // No session token: only a valid job token may open the stream route.
  const badToken = await req('GET', '/api/stream/1/hls?jobToken=wrong-token');
  check('a wrong job token is rejected', badToken.res.status === 401, String(badToken.res.status));

  const noToken = await req('GET', '/api/stream/1/hls');
  check('no token at all is rejected', noToken.res.status === 401, String(noToken.res.status));

  const withSession = await req('GET', '/api/stream/1/hls', { token });
  check(
    'a valid session still works even with a bad job token',
    withSession.res.status !== 401,
    String(withSession.res.status),
  );

  /* ------------------------------------- cleanup --------------------- */
  await req('DELETE', `/api/movies/${hlsMovieId}`, { token });
  await req('DELETE', `/api/movies/${evilMovie.json?.movie?.id}`, { token });
  await req('DELETE', `/api/auth/users/${memberId}`, { token });
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
