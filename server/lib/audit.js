import { q, run } from '../db.js';

/**
 * Audit trail.
 *
 * Every meaningful action is recorded so an admin can see who did what,
 * when, and from where.
 */

export const AUDIT_ACTIONS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.register': 'Registered',
  'auth.password_changed': 'Changed a password',
  'auth.role_changed': 'Changed a user role',
  'auth.user_created': 'Created a user',
  'auth.user_deleted': 'Deleted a user',
  'auth.2fa_enabled': 'Enabled two-factor auth',
  'auth.2fa_disabled': 'Disabled two-factor auth',
  'session.revoked': 'Revoked a session',
  'movie.created': 'Added a movie',
  'movie.updated': 'Updated a movie',
  'movie.deleted': 'Deleted a movie',
  'source.attached': 'Attached a source',
  'source.removed': 'Removed a source',
  'provider.created': 'Added a storage provider',
  'provider.updated': 'Updated a storage provider',
  'provider.deleted': 'Deleted a storage provider',
  'provider.scanned': 'Scanned a storage provider',
  'file.uploaded': 'Uploaded a file',
  'file.deleted': 'Deleted a file',
  'job.created': 'Started a job',
  'job.cancelled': 'Cancelled a job',
  'settings.updated': 'Changed server settings',
  'ip.banned': 'Banned an IP',
  'ip.unbanned': 'Unbanned an IP',
};

/**
 * Record an action.
 * @param {object} entry
 * @param {object} [entry.user]   the acting user (may be null)
 * @param {string} entry.action   key from AUDIT_ACTIONS
 * @param {string} [entry.target] what was acted on
 * @param {any}    [entry.details] extra context
 * @param {string} [entry.ip]
 */
export function audit(user, action, target = null, details = null, ip = null) {
  try {
    run(
      `INSERT INTO audit_log (user_id, username, action, target, details, ip)
       VALUES (?,?,?,?,?,?)`,
      user?.id ?? null,
      user?.username ?? null,
      action,
      target ? String(target).slice(0, 300) : null,
      details === null || details === undefined ? null : JSON.stringify(details).slice(0, 2000),
      ip || null,
    );
  } catch (err) {
    // Auditing must never break the request it is recording.
    console.error('[audit] failed to record:', err.message);
  }
}

export function listAuditLog({ limit = 200, action = null, userId = null } = {}) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  const sql = `SELECT * FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT ?`;
  return q(sql, ...params, Math.min(1000, Math.max(1, Number(limit) || 200)));
}

export function purgeAuditLog(olderThanDays = 90) {
  const res = run(
    `DELETE FROM audit_log WHERE created_at < datetime('now', ?)`,
    `-${Math.max(1, Number(olderThanDays) || 90)} days`,
  );
  return res.changes;
}
