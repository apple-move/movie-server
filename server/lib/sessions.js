import crypto from 'node:crypto';
import { q, one, run } from '../db.js';

/**
 * Server-side sessions.
 *
 * The JWT is still the credential, but a matching row in the `sessions` table
 * lets an admin revoke a session (sign out a device) and see who is online.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hash a token so the database never holds a usable credential. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Format a date the same way SQLite's `datetime('now')` does, so the
 * expiry can be compared in SQL.
 */
function sqlTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function createSession({ userId, token, userAgent, ip, ttlMs = SESSION_TTL_MS }) {
  const id = crypto.randomUUID();
  const expiresAt = sqlTimestamp(new Date(Date.now() + ttlMs));
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?,?,?,?,?,?)`,
    id,
    userId,
    hashToken(token),
    (userAgent || '').slice(0, 300),
    ip || '',
    expiresAt,
  );
  return one('SELECT * FROM sessions WHERE id = ?', id);
}

export function findSession(token) {
  if (!token) return null;
  const row = one('SELECT * FROM sessions WHERE token_hash = ?', hashToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at) {
    // `expires_at` is stored in SQLite's datetime format, so it can be
    // compared directly.
    if (new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() < Date.now()) {
      return null;
    }
  }
  return row;
}

export function touchSession(id) {
  run("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?", id);
}

export function revokeSession(id) {
  run("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?", id);
}

export function revokeUserSessions(userId, { except = null } = {}) {
  if (except) {
    run(
      'UPDATE sessions SET revoked_at = datetime(\'now\') WHERE user_id = ? AND id != ? AND revoked_at IS NULL',
      userId,
      except,
    );
  } else {
    run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      userId,
    );
  }
}

export function listSessions(userId = null) {
  if (userId) {
    return q(
      `SELECT id, user_id, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at
         FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 200`,
      userId,
    );
  }
  return q(
    `SELECT s.id, s.user_id, u.username, s.user_agent, s.ip, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.last_seen_at DESC LIMIT 200`,
  );
}

export function purgeExpiredSessions() {
  const res = run(
    "DELETE FROM sessions WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')",
  );
  return res.changes;
}
