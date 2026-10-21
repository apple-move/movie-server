import { Router } from 'express';
import { one } from '../db.js';
import { config } from '../config.js';
import { recordFailure, clearFailures, isBlocked } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { createSession, revokeSession, revokeUserSessions, findSession, listSessions } from '../lib/sessions.js';
import { generateSecret, otpauthUri, totp, verifyTotp, enableTotp, disableTotp, getTotp } from '../lib/totp.js';
import {
  createUser,
  countUsers,
  listUsers,
  signToken,
  verifyPassword,
  requireAuth,
  requireAdmin,
  optionalAuth,
  updateUser,
  deleteUser,
  touchLogin,
  extractToken,
} from '../lib/auth.js';

export const authRouter = Router();

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** 2FA secrets awaiting confirmation, keyed by user id. */
const pendingTotp = new Map();

function setSessionCookie(res, token) {
  res.cookie('ms_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
    secure: config.env === 'production',
  });
}

// Brute-force protection.
//   - per account: 10 failed attempts in 15 minutes
//   - per IP:      50 failed attempts in 15 minutes
// The per-IP limit is deliberately higher so that attacking ONE account from
// one address does not lock every other account out from that address.
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX) || 10;
const LOGIN_IP_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_IP_MAX) || 50;
const REGISTER_MAX_ATTEMPTS = Number(process.env.REGISTER_RATE_MAX) || 20;

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Two independent limits, because the client IP alone is not trustworthy:
  //   - per account: stops one account being brute-forced from many IPs
  //   - per IP:      stops one IP brute-forcing many accounts
  const accountKey = `user:${String(username).toLowerCase()}`;
  const ipKey = `ip:${req.ip || 'unknown'}`;

  for (const key of [accountKey, ipKey]) {
    const existing = isBlocked(key, {
      windowMs: LOGIN_WINDOW_MS,
      max: key === ipKey ? LOGIN_IP_MAX_ATTEMPTS : LOGIN_MAX_ATTEMPTS,
    });
    if (existing.blocked) {
      res.setHeader('Retry-After', String(existing.retryAfter));
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${Math.ceil(existing.retryAfter / 60)} minute(s).`,
        retryAfter: existing.retryAfter,
      });
    }
  }

  const row = one(
    'SELECT id, username, password_hash, role, display_name, totp_secret, totp_enabled FROM users WHERE username = ?',
    username,
  );

  // Always run a hash comparison so the response time does not reveal
  // whether the username exists.
  const ok = await verifyPassword(
    password,
    row?.password_hash || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin',
  );
  if (!row || !ok) {
    // Both counters are incremented so neither limit can be evaded.
    const failure = recordFailure(accountKey, {
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_MAX_ATTEMPTS,
    });
    recordFailure(ipKey, {
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_IP_MAX_ATTEMPTS,
    });
    audit(null, 'auth.login_failed', username, { ip: req.ip }, req.ip);
    return res.status(401).json({
      error: 'Invalid username or password',
      ...(failure.count >= LOGIN_MAX_ATTEMPTS ? { retryAfter: failure.retryAfter } : {}),
    });
  }

  // Two-factor: the password was correct, so ask for the second factor.
  if (row.totp_enabled && row.totp_secret) {
    const code = String(req.body?.totp || '').replace(/\s/g, '');
    if (!code) {
      return res.status(401).json({ error: 'Two-factor code required', requiresTotp: true });
    }
    if (!verifyTotp(row.totp_secret, code)) {
      const failure = recordFailure(accountKey, {
        windowMs: LOGIN_WINDOW_MS,
        max: LOGIN_MAX_ATTEMPTS,
      });
      recordFailure(ipKey, {
        windowMs: LOGIN_WINDOW_MS,
        max: LOGIN_IP_MAX_ATTEMPTS,
      });
      audit(null, 'auth.login_failed', username, { reason: 'bad totp' }, req.ip);
      return res.status(401).json({
        error: 'Invalid two-factor code',
        requiresTotp: true,
        ...(failure.count >= LOGIN_MAX_ATTEMPTS ? { retryAfter: failure.retryAfter } : {}),
      });
    }
  }

  // Success clears the account counter. The per-IP counter is NOT cleared:
  // otherwise an attacker could reset it by logging in successfully.
  clearFailures(accountKey);
  touchLogin(row.id);
  const token = signToken(row);
  createSession({
    userId: row.id,
    token,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  setSessionCookie(res, token);
  audit({ id: row.id, username: row.username }, 'auth.login', row.username, null, req.ip);
  res.json({
    token,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      displayName: row.display_name,
    },
  });
});

authRouter.post('/register', optionalAuth, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Limit registration attempts per IP so the endpoint cannot be used to
  // spam the users table.
  const key = `register|${req.ip || 'unknown'}`;
  const blocked = isBlocked(key, { windowMs: 60 * 60 * 1000, max: REGISTER_MAX_ATTEMPTS });
  if (blocked.blocked) {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return res.status(429).json({
      error: 'Too many registration attempts. Try again later.',
      retryAfter: blocked.retryAfter,
    });
  }

  // The very first account becomes the admin. After that, registration is
  // admin-only (admins create members from the Admin panel).
  const isFirst = countUsers() === 0;
  if (!isFirst && !(req.user && req.user.role === 'admin')) {
    return res.status(403).json({ error: 'Registration is closed. Ask an admin to create your account.' });
  }
  try {
    const user = await createUser({
      username,
      password,
      role: isFirst ? 'admin' : 'member',
      displayName,
    });
    clearFailures(key);
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    // The session row is required: requireAuth rejects a token that has no
    // matching session, so without this the new user could not use the site.
    createSession({
      userId: user.id,
      token,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(res, token);
    audit({ id: user.id, username: user.username }, 'auth.register', user.username, null, req.ip);
    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
    });
  } catch (err) {
    recordFailure(key, { windowMs: 60 * 60 * 1000, max: REGISTER_MAX_ATTEMPTS });
    res.status(400).json({ error: err.message });
  }
});

authRouter.post('/logout', requireAuth, (req, res) => {
  const token = extractToken(req);
  if (token) {
    const session = findSession(token);
    if (session) revokeSession(session.id);
  }
  res.clearCookie('ms_token', { path: '/' });
  audit(req.user, 'auth.logout', req.user?.username, null, req.ip);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      displayName: req.user.display_name,
      totpEnabled: Boolean(req.user.totp_enabled),
    },
  });
});

/* --------------------------------------------------------- two-factor -- */

/**
 * POST /api/auth/2fa/setup
 * Generates a secret and returns the otpauth:// URI to import into an
 * authenticator app. The secret is only stored once the code is confirmed.
 */
authRouter.post('/2fa/setup', requireAuth, (req, res) => {
  const secret = generateSecret();
  // Keep the pending secret in the session-scoped cache until confirmed.
  pendingTotp.set(req.user.id, { secret, at: Date.now() });
  res.json({
    secret,
    uri: otpauthUri(secret, req.user.username),
  });
});

/** POST /api/auth/2fa/enable — confirm the code and switch 2FA on. */
authRouter.post('/2fa/enable', requireAuth, (req, res) => {
  const pending = pendingTotp.get(req.user.id);
  const code = String(req.body?.code || '').replace(/\s/g, '');
  if (!pending) {
    return res.status(400).json({ error: 'Start the setup again' });
  }
  if (Date.now() - pending.at > 10 * 60 * 1000) {
    pendingTotp.delete(req.user.id);
    return res.status(400).json({ error: 'Setup expired, start again' });
  }
  if (!verifyTotp(pending.secret, code)) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  enableTotp(req.user.id, pending.secret);
  pendingTotp.delete(req.user.id);
  audit(req.user, 'auth.2fa_enabled', req.user.username, null, req.ip);
  res.json({ ok: true });
});

/** POST /api/auth/2fa/disable — switch 2FA off (requires the current code). */
authRouter.post('/2fa/disable', requireAuth, (req, res) => {
  const row = getTotp(req.user.id);
  if (!row?.totp_secret) return res.json({ ok: true });
  const code = String(req.body?.code || '').replace(/\s/g, '');
  if (!verifyTotp(row.totp_secret, code)) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  disableTotp(req.user.id);
  audit(req.user, 'auth.2fa_disabled', req.user.username, null, req.ip);
  res.json({ ok: true });
});

/* ----------------------------------------------------------- sessions -- */

/** GET /api/auth/sessions — list this user's (or all) sessions. */
authRouter.get('/sessions', requireAuth, requireAdmin, (req, res) => {
  const sessions = listSessions(req.query.userId ? Number(req.query.userId) : null);
  res.json({ sessions });
});

/** DELETE /api/auth/sessions/:id — revoke a session (sign a device out). */
authRouter.delete('/sessions/:id', requireAuth, requireAdmin, (req, res) => {
  revokeSession(req.params.id);
  audit(req.user, 'session.revoked', req.params.id, null, req.ip);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- users -- */

authRouter.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

authRouter.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const user = await createUser({ username, password, role: role || 'member', displayName });
    audit(req.user, 'auth.user_created', username, { role: user.role }, req.ip);
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.patch('/users/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });

  const isSelf = id === req.user.id;
  const isAdmin = req.user.role === 'admin';

  // A user may edit their own profile; editing anyone else needs admin.
  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { password, role, displayName } = req.body || {};
  if (role && !['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or member' });
  }
  // Only an admin may change a role — and nobody may demote themselves.
  if (role && !isAdmin) {
    return res.status(403).json({ error: 'Only an admin can change roles' });
  }
  if (id === req.user.id && role && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role' });
  }
  const target = one('SELECT username FROM users WHERE id = ?', id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (password && String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const user = await updateUser(id, { password, role, displayName });

  // A password change or a role change invalidates that user's sessions.
  // The current session is kept so the person who just changed their own
  // password is not logged out of the tab they are using.
  if (password || role) {
    revokeUserSessions(id, { except: req.sessionId });
  }

  if (password) audit(req.user, 'auth.password_changed', target.username, null, req.ip);
  if (role) audit(req.user, 'auth.role_changed', target.username, { role }, req.ip);

  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      display_name: user.display_name,
      totpEnabled: Boolean(user.totp_enabled),
    },
  });
});

authRouter.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const target = one('SELECT username FROM users WHERE id = ?', id);
  revokeUserSessions(id);
  deleteUser(id);
  audit(req.user, 'auth.user_deleted', target?.username || id, null, req.ip);
  res.json({ ok: true });
});
