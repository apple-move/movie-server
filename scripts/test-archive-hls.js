/**
 * Tests for the archive (ZIP) and HLS features.
 * Run: node scripts/test-archive-hls.js
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
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(15_000) };
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
  const boundary = `----zip${Date.now()}${Math.random().toString(16).slice(2)}`;
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-zip-'));

  /* ------------------------------------------------------------- ZIP --- */
  section('1. ZIP archive streaming');

  // A stored (uncompressed) entry and a deflated entry.
  const storedPath = path.join(tmpDir, 'stored.bin');
  const storedData = Buffer.alloc(120_000);
  for (let i = 0; i < storedData.length; i++) storedData[i] = i % 251;
  fs.writeFileSync(storedPath, storedData);

  const zipPath = path.join(tmpDir, 'movie-pack.zip');
  // Build a ZIP by hand: one STORED entry + one DEFLATED entry.
  const { zipPathData, deflated } = await buildZip(storedData, 'video/stored.mp4', Buffer.from('hello '.repeat(200)));

  fs.writeFileSync(zipPath, zipPathData);
  console.log(`  built archive: ${fs.statSync(zipPath).size} bytes`);

  const up = await upload(token, zipPath, { provider: 'local', folder: 'Zip Tests' });
  check('archive uploaded', up.res.status === 201, JSON.stringify(up.json));

  // List the entries.
  const entries = await req('GET', `/api/movies/1/archive?provider=local&path=${encodeURIComponent(up.json.remotePath)}`, { token });
  check('archive entries listed', entries.res.status === 200, entries.text);
  check('archive has 2 entries', entries.json?.entries?.length === 2, JSON.stringify(entries.json?.entries?.length));
  check('entry sizes are reported', entries.json?.entries?.[0]?.size > 0);

  // Create a movie and attach the archive.
  const movie = await req('POST', '/api/movies', {
    token,
    body: { title: 'Zip Test Movie', year: 2024, genres: ['Test'] },
  });
  const movieId = movie.json?.movie?.id;
  check('movie created for the archive', Boolean(movieId));

  const attach = await req('POST', `/api/movies/${movieId}/sources`, {
    token,
    body: { provider: 'local', remotePath: up.json.remotePath },
  });
  check('archive attached as a source', attach.res.status === 201, attach.text);
  check('source kind is zip', attach.json?.source?.kind === 'zip', attach.json?.source?.kind);
  const sourceId = attach.json?.source?.id;

  // Stream the stored entry.
  const info = await req('GET', `/api/stream/${sourceId}/info`, { token });
  check('archive info lists the entries', (info.json?.archive?.entries?.length || 0) === 2);
  check('archive info marks video entries', info.json?.archive?.entries?.some((e) => e.isVideo));

  const stored = await req('GET', `/api/stream/${sourceId}?entry=${encodeURIComponent('video/stored.mp4')}`, { token, raw: true });
  check('stored entry streams with 200', stored.res.status === 200, String(stored.res.status));
  check('stored entry has the right length', stored.buf.length === storedData.length, `${stored.buf.length} vs ${storedData.length}`);
  check('stored entry content matches', stored.buf.equals(storedData));

  // Range request inside the stored entry.
  const ranged = await req('GET', `/api/stream/${sourceId}?entry=${encodeURIComponent('video/stored.mp4')}`, {
    token, raw: true, headers: { range: 'bytes=1000-1999' },
  });
  check('stored entry range returns 206', ranged.res.status === 206, String(ranged.res.status));
  check('stored entry range length', ranged.buf.length === 1000, String(ranged.buf.length));
  check('stored entry range bytes match', ranged.buf.equals(storedData.subarray(1000, 2000)));

  // Deflated entry.
  const deflatedStream = await req('GET', `/api/stream/${sourceId}?entry=${encodeURIComponent('notes/readme.txt')}`, { token, raw: true });
  check('deflated entry streams with 200', deflatedStream.res.status === 200, String(deflatedStream.res.status));
  check('deflated entry inflates to the right size', deflatedStream.buf.length === deflated.length, `${deflatedStream.buf.length} vs ${deflated.length}`);
  check('deflated entry content matches', deflatedStream.buf.equals(deflated));

  // Range inside a deflated entry.
  const deflatedRange = await req('GET', `/api/stream/${sourceId}?entry=${encodeURIComponent('notes/readme.txt')}`, {
    token, raw: true, headers: { range: 'bytes=10-109' },
  });
  check('deflated entry range returns 206', deflatedRange.res.status === 206, String(deflatedRange.res.status));
  check('deflated entry range length', deflatedRange.buf.length === 100, String(deflatedRange.buf.length));
  check('deflated entry range bytes match',
    deflatedRange.buf.equals(deflated.subarray(10, 110)),
  );

  /* ------------------------------------------------------------- HLS --- */
  section('2. HLS playlist streaming');

  const hlsDir = path.join(tmpDir, 'hls');
  fs.mkdirSync(hlsDir, { recursive: true });

  // A media playlist referencing two segments and a key.
  const segmentA = Buffer.alloc(50_000, 1);
  const segmentB = Buffer.alloc(60_000, 2);
  fs.writeFileSync(path.join(hlsDir, 'seg1.ts'), segmentA);
  fs.writeFileSync(path.join(hlsDir, 'seg2.ts'), segmentB);
  fs.writeFileSync(path.join(hlsDir, 'key.bin'), Buffer.alloc(16, 9));

  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000',
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXTINF:4.0,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), playlist);

  // A master playlist pointing at the media playlist.
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
    'index.m3u8',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), master);

  const hlsUp = await upload(token, path.join(hlsDir, 'master.m3u8'), {
    provider: 'local',
    folder: 'HLS Tests',
  });
  check('HLS playlist uploaded', hlsUp.res.status === 201, JSON.stringify(hlsUp.json));

  // The media playlist, its segments and the key also have to live in the
  // provider for the rewritten URIs to resolve.
  for (const name of ['index.m3u8', 'seg1.ts', 'seg2.ts', 'key.bin']) {
    const up = await upload(token, path.join(hlsDir, name), {
      provider: 'local',
      folder: 'HLS Tests',
    });
    check(`HLS asset uploaded: ${name}`, up.res.status === 201, JSON.stringify(up.json));
  }

  const hlsMovie = await req('POST', '/api/movies', {
    token, body: { title: 'HLS Test', year: 2024, genres: ['Test'] },
  });
  const hlsMovieId = hlsMovie.json?.movie?.id;
  const hlsAttach = await req('POST', `/api/movies/${hlsMovieId}/sources`, {
    token, body: { provider: 'local', remotePath: hlsUp.json.remotePath },
  });
  check('HLS playlist attached', hlsAttach.res.status === 201, hlsAttach.text);
  check('source kind is hls', hlsAttach.json?.source?.kind === 'hls', hlsAttach.json?.source?.kind);
  const hlsSourceId = hlsAttach.json?.source?.id;

  // Fetch the playlist through the proxy.
  const hlsResp = await req('GET', `/api/stream/${hlsSourceId}/hls`, { token });
  check('HLS playlist served', hlsResp.res.status === 200, String(hlsResp.res.status));
  check(
    'HLS playlist has the right content type',
    (hlsResp.res.headers.get('content-type') || '').includes('mpegurl'),
    hlsResp.res.headers.get('content-type'),
  );
  check('HLS playlist keeps the tag lines', hlsResp.text.includes('#EXTM3U'));
  check('HLS playlist rewrites the child playlist', !hlsResp.text.includes('\nindex.m3u8\n'), hlsResp.text);

  // The rewritten URI must resolve back to the media playlist.
  const childUri = hlsResp.text.split('\n').find((l) => l && !l.startsWith('#'));
  check('HLS child playlist URI is encoded', childUri && childUri.includes('%'), childUri);
  check('HLS child playlist URI points at the API', String(childUri).startsWith('/api/stream/'), childUri);
  const child = await req('GET', `${BASE}${childUri}`, { token });
  check('HLS child playlist served', child.res.status === 200, String(child.res.status));
  check('child playlist keeps EXTINF lines', child.text.includes('#EXTINF'), child.text.slice(0, 200));

  // Fetch a segment with a range request.
  const segUri = child.text.split('\n').find((l) => l && !l.startsWith('#'));
  const seg = await req('GET', `${BASE}${segUri}`, {
    token, raw: true, headers: { range: 'bytes=0-999' },
  });
  check('HLS segment served with 206', seg.res.status === 206, String(seg.res.status));
  check('HLS segment range length', seg.buf.length === 1000, String(seg.buf.length));
  check('HLS segment bytes match', seg.buf.equals(segmentA.subarray(0, 1000)));

  // The encryption key.
  const keyUri = /URI="([^"]+)"/.exec(child.text)?.[1];
  check('HLS key URI rewritten', keyUri && keyUri.includes('%'), keyUri);
  const key = await req('GET', `${BASE}${keyUri}`, { token, raw: true });
  check('HLS key served', key.res.status === 200, String(key.res.status));
  check('HLS key has 16 bytes', key.buf.length === 16, String(key.buf.length));

  // The info endpoint should report the variants.
  const hlsInfo = await req('GET', `/api/stream/${hlsSourceId}/info`, { token });
  check('HLS info reports variants', (hlsInfo.json?.variants?.length || 0) === 2, JSON.stringify(hlsInfo.json?.variants));
  check('HLS variant has a resolution', Boolean(hlsInfo.json?.variants?.[0]?.resolution));

  /* --------------------------------------------------- malformed zips --- */
  section('4. Malformed archives are handled safely');

  // A ZIP whose central directory lies about the extra-field length.
  const evilZip = Buffer.alloc(120);
  evilZip.writeUInt32LE(0x04034b50, 0);      // local header signature
  evilZip.writeUInt16LE(20, 4);
  evilZip.writeUInt16LE(0, 8);
  evilZip.writeUInt32LE(0xffff, 18);          // bogus compressed size
  evilZip.writeUInt32LE(0xffff, 22);
  evilZip.writeUInt16LE(0xffff, 26);          // bogus name length
  evilZip.writeUInt16LE(0xffff, 28);          // bogus extra length
  const evilPath = path.join(tmpDir, 'evil.zip');
  fs.writeFileSync(evilPath, evilZip);

  const evilUp = await upload(token, evilPath, { provider: 'local', folder: 'Zip Tests' });
  check('malformed archive uploads', evilUp.res.status === 201);

  const evilEntries = await req(
    'GET',
    `/api/movies/1/archive?provider=local&path=${encodeURIComponent(evilUp.json.remotePath)}`,
    { token },
  );
  check(
    'malformed archive does not crash the server',
    evilEntries.res.status < 500,
    `${evilEntries.res.status} ${evilEntries.text.slice(0, 80)}`,
  );

  const evilMovie = await req('POST', '/api/movies', { token, body: { title: 'Evil Zip', year: 2024 } });
  const evilSource = await req('POST', `/api/movies/${evilMovie.json?.movie?.id}/sources`, {
    token, body: { provider: 'local', remotePath: evilUp.json.remotePath },
  });
  check(
    'malformed archive is rejected when attached',
    evilSource.res.status >= 400,
    `${evilSource.res.status} ${evilSource.text.slice(0, 80)}`,
  );

  // The server must still be alive and serving.
  const alive = await req('GET', '/api/health');
  check('server survived the malformed archive', alive.res.ok && alive.json.ok);

  // A truncated but valid-looking archive.
  const truncatedPath = path.join(tmpDir, 'truncated.zip');
  fs.writeFileSync(truncatedPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const truncUp = await upload(token, truncatedPath, { provider: 'local', folder: 'Zip Tests' });
  const truncEntries = await req(
    'GET',
    `/api/movies/1/archive?provider=local&path=${encodeURIComponent(truncUp.json.remotePath)}`,
    { token },
  );
  check(
    'truncated archive does not crash the server',
    truncEntries.res.status < 500,
    String(truncEntries.res.status),
  );

  // A file that is not a zip at all.
  const notZipPath = path.join(tmpDir, 'notazip.zip');
  fs.writeFileSync(notZipPath, Buffer.alloc(500, 3));
  const notZipUp = await upload(token, notZipPath, { provider: 'local', folder: 'Zip Tests' });
  const notZipEntries = await req(
    'GET',
    `/api/movies/1/archive?provider=local&path=${encodeURIComponent(notZipUp.json.remotePath)}`,
    { token },
  );
  check('a non-zip file is rejected cleanly', notZipEntries.res.status < 500, String(notZipEntries.res.status));

  const stillAlive = await req('GET', '/api/health');
  check('server still healthy', stillAlive.res.ok);

  await req('DELETE', `/api/movies/${evilMovie.json?.movie?.id}`, { token });

  /* ------------------------------------------------------ providers --- */
  section('5. Multi-instance providers');

  const types = await req('GET', '/api/admin/provider-types', { token });
  check('provider types listed', (types.json?.types?.length || 0) === 5);
  check('R2 fields exposed', (types.json?.fields?.r2?.length || 0) > 0);

  const providers = await req('GET', '/api/admin/providers', { token });
  check('provider instances listed', (providers.json?.providers?.length || 0) >= 1);
  check('local instance is configured', providers.json?.providers?.some((p) => p.id === 'local' && p.configured));

  // Add a second local instance to prove multiple instances work.
  const second = await req('POST', '/api/admin/providers', {
    token,
    body: {
      id: 'local2',
      type: 'local',
      name: 'Second Disk',
      config: { root: path.join(tmpDir, 'library2') },
    },
  });
  check('second provider instance created', second.res.status === 201, second.text);

  const providers2 = await req('GET', '/api/admin/providers', { token });
  check('both instances are listed', (providers2.json?.providers?.length || 0) >= 2);
  check('second instance has its own id', providers2.json?.providers?.some((p) => p.id === 'local2'));

  // The scanner can target either instance.
  const scan2 = await req('POST', '/api/admin/scan', { token, body: { provider: 'local2' } });
  check('second instance can be scanned', scan2.res.status === 200, scan2.text);

  // Deleting is blocked while sources reference it.
  const del = await req('DELETE', '/api/admin/providers/local', { token });
  check('deleting a provider in use is blocked', del.res.status === 400, del.text);

  const del2 = await req('DELETE', '/api/admin/providers/local2', { token });
  check('unused provider can be deleted', del2.res.status === 200, del2.text);

  /* ------------------------------------------------------------ jobs --- */
  section('6. Background jobs and ffmpeg');

  const status = await req('GET', '/api/admin/status', { token });
  check('admin status reports ffmpeg availability', 'ffmpeg' in (status.json || {}));
  check('admin status reports uptime', typeof status.json?.uptime === 'number');

  const jobs = await req('GET', '/api/admin/jobs', { token });
  check('job list endpoint works', jobs.res.status === 200, jobs.text);
  check('job list is an array', Array.isArray(jobs.json?.jobs));

  /* ----------------------------------------------------------- audit --- */
  section('7. Audit log and security');

  const auditLog = await req('GET', '/api/admin/audit', { token });
  check('audit log readable', auditLog.res.status === 200, auditLog.text);
  check('audit log has entries', (auditLog.json?.entries?.length || 0) > 0);
  check(
    'audit log records logins',
    auditLog.json?.entries?.some((e) => e.action === 'auth.login'),
  );

  const bans = await req('GET', '/api/admin/bans', { token });
  check('ban list readable', bans.res.status === 200, bans.text);
  check('ban list is an array', Array.isArray(bans.json?.bans));

  const sessions = await req('GET', '/api/admin/sessions', { token });
  check('session list readable', sessions.res.status === 200, sessions.text);
  check('active session recorded', (sessions.json?.sessions?.length || 0) > 0);

  const settings = await req('GET', '/api/admin/settings', { token });
  check('settings readable', settings.res.status === 200, settings.text);

  const putSettings = await req('PUT', '/api/admin/settings', {
    token, body: { defaultQuality: '1080p', theme: 'dark' },
  });
  check('settings can be updated', putSettings.res.status === 200, putSettings.text);
  check('settings persist', putSettings.json?.settings?.defaultQuality === '1080p');

  // Cleanup
  await req('DELETE', `/api/movies/${movieId}`, { token });
  await req('DELETE', `/api/movies/${hlsMovieId}`, { token });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${'='.repeat(44)}`);
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  if (fail) console.log(`  Failing: ${failures.join(', ')}`);
  console.log(`${'='.repeat(44)}\n`);
  process.exit(fail ? 1 : 0);
}

/**
 * Build a ZIP archive in memory with one STORED and one DEFLATED entry.
 * Returns the archive buffer plus the deflated entry's original bytes.
 */
async function buildZip(storedData, storedName, deflatedData) {
  const { deflateRawSync, crc32 } = await import('node:zlib');

  const chunks = [];
  const central = [];
  let offset = 0;

  const addEntry = (name, data, method) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(Buffer.from(data));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt32LE(0, 36);
    cen.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([cen, nameBuf]));
    offset += local.length + nameBuf.length + compressed.length;
  };

  addEntry(storedName, storedData, 0);
  addEntry('notes/readme.txt', deflatedData, 8);

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { zipPathData: Buffer.concat([...chunks, cd, eocd]), deflated: deflatedData };
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
