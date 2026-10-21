import { q, one, run } from '../db.js';

/**
 * IP ban list.
 *
 * Blocked addresses are rejected before any route runs, so a banned client
 * cannot even reach the login form.
 */

export function isBanned(ip) {
  if (!ip) return false;
  return Boolean(one('SELECT ip FROM ip_bans WHERE ip = ?', ip));
}

export function listBans() {
  return q('SELECT ip, reason, created_at FROM ip_bans ORDER BY created_at DESC');
}

export function banIp(ip, reason = null) {
  if (!ip) return false;
  run(
    'INSERT INTO ip_bans (ip, reason) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason',
    ip,
    reason,
  );
  return true;
}

export function unbanIp(ip) {
  const res = run('DELETE FROM ip_bans WHERE ip = ?', ip);
  return res.changes > 0;
}
