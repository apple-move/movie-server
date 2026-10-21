// Final smoke test: server boots, the SPA loads, the API answers.
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${ok ? '' : `  ${detail}`}`);
}

const health = await (await fetch(`${BASE}/api/health`)).json();
check('health endpoint', health.ok === true);

const shell = await (await fetch(`${BASE}/`)).text();
check('SPA shell served', shell.includes('id="app"'));
check('player stylesheet linked', shell.includes('/css/player.css'));

for (const path of ['/css/styles.css', '/css/player.css', '/js/app.js', '/js/views/player.js', '/js/views/admin.js', '/js/vendor/hls.min.js']) {
  const res = await fetch(`${BASE}${path}`);
  check(`asset ${path}`, res.ok, String(res.status));
}

const anon = await fetch(`${BASE}/api/movies`);
check('library requires auth', anon.status === 401, String(anon.status));

const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json();
check('login works', Boolean(login.token));

const headers = { authorization: `Bearer ${login.token}` };
const movies = await (await fetch(`${BASE}/api/movies`, { headers })).json();
check('movie list responds', Array.isArray(movies.movies));

const providers = await (await fetch(`${BASE}/api/movies/meta/providers`, { headers })).json();
check('provider instances listed', (providers.providers?.length || 0) >= 5);
check('no provider exposes its config', providers.providers.every((p) => p.config === undefined));

const csp = (await fetch(`${BASE}/`)).headers.get('content-security-policy');
check('CSP is set', Boolean(csp));
check('CSP allows the hls.js worker', (csp || '').includes('worker-src'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
