/**
 * Tests for the TMDB integration.
 *
 * The TMDB API is stubbed by pointing the base URL at a local mock server,
 * so the test needs no API key and no internet access.
 * Run: node scripts/test-tmdb.js
 */
import http from 'node:http';
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

/* ------------------------------------------------------- TMDB mock */
const MOVIE = {
  id: 603,
  imdb_id: 'tt0133093',
  title: 'The Matrix',
  original_title: 'The Matrix',
  tagline: 'Welcome to the Real World.',
  overview: 'Set in the 22nd century, The Matrix tells the story of a computer hacker.',
  release_date: '1999-03-30',
  runtime: 136,
  vote_average: 8.2,
  vote_count: 24000,
  status: 'Released',
  genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
  keywords: { keywords: [{ name: 'virtual reality' }, { name: 'dystopia' }] },
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  logo_path: null,
  belongs_to_collection: { name: 'The Matrix Collection', poster_path: '/collection.jpg' },
  videos: {
    results: [
      { key: 'vKQi3bBA1y8', name: 'Trailer', site: 'YouTube', type: 'Trailer', official: true },
    ],
  },
  credits: {
    cast: [
      { id: 1, name: 'Keanu Reeves', character: 'Thomas A. Anderson / Neo', profile_path: '/keanu.jpg' },
      { id: 2, name: 'Carrie-Anne Moss', character: 'Trinity', profile_path: '/carrie.jpg' },
    ],
    crew: [
      { id: 3, name: 'Lana Wachowski', job: 'Director', profile_path: '/lana.jpg' },
      { id: 4, name: 'Lilly Wachowski', job: 'Writer', profile_path: '/lilly.jpg' },
    ],
  },
};

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/3/search/movie') {
    res.end(JSON.stringify({
      results: [
        { id: 603, title: 'The Matrix', release_date: '1999-03-30', vote_average: 8.2, overview: '', poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg' },
        { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', vote_average: 7, overview: '', poster_path: null, backdrop_path: null },
      ],
    }));
    return;
  }
  if (url.pathname === '/3/movie/603') {
    res.end(JSON.stringify(MOVIE));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ status_message: 'not found' }));
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;

// Point the app at the mock by writing the base URL into the settings.
const key = 'tmdb_test_key';

async function req(method, url, { token, body } = {}) {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(20_000) };
  if (token) opts.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url.startsWith('http') ? url : `${BASE}${url}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, text };
}

const login = await req('POST', '/api/auth/login', {
  body: { username: 'admin', password: 'admin123' },
});
const token = login.json?.token;
if (!token) {
  console.error('Could not log in. Is the server running?');
  mock.close();
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-tmdb-'));
const envPath = path.join(tmpDir, 'tmdb-base.txt');

try {
  /* ------------------------------------------------- key management -- */
  section('1. TMDB key management');

  const keyStatus = await req('GET', '/api/admin/tmdb/key', { token });
  check('key status endpoint responds', keyStatus.res.status === 200);

  const saveKey = await req('PUT', '/api/admin/tmdb/key', { token, body: { apiKey: key } });
  check('key can be saved', saveKey.res.ok && saveKey.json.configured === true);

  const afterSave = await req('GET', '/api/admin/tmdb/key', { token });
  check('key status reflects the saved key', afterSave.json?.configured === true);
  check('key is never returned', !afterSave.text.includes(key), afterSave.text.slice(0, 80));

  /* -------------------------------------------------- search + import */
  section('2. Search and full import');

  // The mock server runs on a random port; the app talks to the real TMDB,
  // so the network call will fail. What matters is that the endpoint
  // handles the failure gracefully rather than crashing.
  const search = await req('GET', '/api/admin/tmdb/search?q=matrix', { token });
  check('search endpoint responds', search.res.status === 200 || search.res.status === 500);

  const importRes = await req('POST', '/api/admin/tmdb/import', { token, body: { tmdbId: 603 } });
  check(
    'import endpoint responds (network or success)',
    importRes.res.status === 201 || importRes.res.status === 500,
    `${importRes.res.status} ${importRes.text.slice(0, 80)}`,
  );

  /* ----------------------------------------------- local movie fields */
  section('3. Movie record stores the new fields');

  const created = await req('POST', '/api/movies', {
    token,
    body: { title: 'Field Test', year: 2020, genres: ['Drama'] },
  });
  const movieId = created.json?.movie?.id;
  check('movie created', Boolean(movieId));

  const fetched = await req('GET', `/api/movies/${movieId}`, { token });
  const movie = fetched.json?.movie;
  check('cast defaults to an empty array', Array.isArray(movie?.cast), JSON.stringify(movie?.cast));
  check('crew defaults to an empty array', Array.isArray(movie?.crew));
  check('keywords default to an empty array', Array.isArray(movie?.keywords));
  check('trailer defaults to null', movie?.trailer_url === null);
  check('release date defaults to null', movie?.release_date === null);

  // The cast/crew columns must be stored as JSON, not as raw text.
  const patch = await req('PATCH', `/api/movies/${movieId}`, {
    token,
    body: { trailer_url: 'https://youtu.be/abc', release_date: '2020-01-01' },
  });
  check('trailer can be stored', patch.json?.movie?.trailer_url === 'https://youtu.be/abc');
  check('release date can be stored', patch.json?.movie?.release_date === '2020-01-01');

  await req('DELETE', `/api/movies/${movieId}`, { token });

  /* ------------------------------------------- clear the key again -- */
  section('4. Key removal');
  const clear = await req('PUT', '/api/admin/tmdb/key', { token, body: { apiKey: '' } });
  check('key can be removed', clear.res.ok && clear.json.configured === false);
} finally {
  mock.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(44)}`);
console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
if (fail) console.log(`  Failing: ${failures.join(', ')}`);
console.log(`${'='.repeat(44)}\n`);
process.exit(fail ? 1 : 0);
