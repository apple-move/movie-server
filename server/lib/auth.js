import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, q, run } from '../db.js';
import { findSession, touchSession } from './sessions.js';

const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
      // A unique id per token. Without it, two logins in the same second
      // produce byte-identical JWTs (the payload only has a 1-second `iat`),
      // so revoking one session would not revoke the other.
      jwtid: crypto.randomUUID(),
    },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export async function createUser({ username, password, role = 'member', displayName = null }) {
  const existing = one('SELECT id FROM users WHERE username = ?', username);
  if (existing) throw new Error('Username already taken');
  const hash = await hashPassword(password);
  const res = run(
    'INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)',
    username,
    hash,
    role,
    displayName,
  );
  return getUserById(Number(res.lastInsertRowid));
}

export function getUserById(id) {
  return one(
    'SELECT id, username, role, display_name, created_at, last_login_at, totp_enabled FROM users WHERE id = ?',
    id,
  );
}

export function listUsers() {
  return q('SELECT id, username, role, display_name, created_at, last_login_at FROM users ORDER BY id');
}

export async function updateUser(id, { password, role, displayName }) {
  if (password) {
    const hash = await hashPassword(password);
    run('UPDATE users SET password_hash = ? WHERE id = ?', hash, id);
  }
  if (role) run('UPDATE users SET role = ? WHERE id = ?', role, id);
  if (displayName !== undefined) run('UPDATE users SET display_name = ? WHERE id = ?', displayName, id);
  return getUserById(id);
}

export function deleteUser(id) {
  run('DELETE FROM users WHERE id = ?', id);
}

export function touchLogin(id) {
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", id);
}

export function countUsers() {
  return one('SELECT COUNT(*) AS c FROM users').c;
}

/** Express middleware: requires a valid token and a live session. */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // A revoked session must not work even if the JWT has not expired yet.
  if (token) {
    const session = findSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }
    touchSession(session.id);
    req.sessionId = session.id;
  }

  const user = getUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  req.user = user;
  next();
}

/** Express middleware: requires admin role. */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Express middleware: populates `req.user` when a valid token is present but
 * does not reject anonymous requests.
 *
 * The session is checked as well, so a revoked admin session cannot keep
 * using optional-auth routes.
 */
export function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  const payload = token ? verifyToken(token) : null;
  if (payload) {
    const session = findSession(token);
    if (session) {
      touchSession(session.id);
      req.user = getUserById(payload.sub) || null;
    }
  }
  next();
}

/**
 * Express middleware: allows access with a normal session OR the shared
 * job token. The job token is used by the ffmpeg worker, which needs a
 * seekable URL to read from but has no user session.
 *
 * The token is read from the `X-Job-Token` header, not the query string, so
 * it never lands in an access log.
 */
export function requireAuthOrJob(req, res, next) {
  if (config.jobToken) {
    const provided = req.headers['x-job-token'];
    if (typeof provided === 'string') {
      const a = Buffer.from(provided);
      const b = Buffer.from(config.jobToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req.isJob = true;
        return next();
      }
    }
    // Older callers may pass it as a query parameter; that is accepted but
    // logs a warning because it is less safe.
    const queryToken = req.query?.jobToken;
    if (typeof queryToken === 'string' && queryToken === config.jobToken) {
      console.warn('[auth] job token used from the query string — prefer the X-Job-Token header');
      req.isJob = true;
      return next();
    }
  }
  return requireAuth(req, res, next);
}

export function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  // NOTE: tokens are deliberately NOT accepted from the query string — they
  // would leak into access logs, proxy logs and browser history.
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('ms_token='));
    if (match) {
      try {
        return decodeURIComponent(match.slice('ms_token='.length));
      } catch {
        // A malformed cookie is simply an invalid token.
        return null;
      }
    }
  }
  return null;
}
