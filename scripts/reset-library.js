// Remove leftover test data so a fresh run starts clean.
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json();
if (!login.token) {
  console.error('Could not log in.');
  process.exit(1);
}
const h = { authorization: `Bearer ${login.token}` };

const movies = await (await fetch(`${BASE}/api/movies?limit=500`, { headers: h })).json();
for (const m of movies.movies || []) {
  await fetch(`${BASE}/api/movies/${m.id}`, { method: 'DELETE', headers: h });
  console.log('removed movie:', m.title);
}

const providers = await (await fetch(`${BASE}/api/admin/providers`, { headers: h })).json();
for (const p of providers.providers || []) {
  if (!['local', 'r2', 'gdrive', 'mega', 'telegram'].includes(p.id)) {
    await fetch(`${BASE}/api/admin/providers/${p.id}`, { method: 'DELETE', headers: h });
    console.log('removed provider:', p.id);
  }
}
console.log('done');
