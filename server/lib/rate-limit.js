/**
 * Minimal in-memory failure tracker — no external dependency.
 *
 * Counts *failed* attempts per key inside a fixed window. Successful logins
 * never count against the limit, so a legitimate user who fumbles their
 * password a couple of times is never locked out.
 *
 * The key is built by the caller and normally combines the account name
 * with the client IP. Note that the client IP is only trustworthy when the
 * server sits behind a proxy it actually trusts — see `TRUST_PROXY`.
 */

const buckets = new Map();

/** Hard cap so a spray of random keys cannot exhaust memory. */
const MAX_BUCKETS = 10_000;

let lastSweep = 0;

/** Remove expired buckets so the map does not grow without bound. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Record a failed attempt.
 * @returns {{ blocked: boolean, retryAfter: number, count: number }}
 */
export function recordFailure(key, { windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    sweep(now);
    lastSweep = now;
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
    // Evict the oldest entry when the map grows too large.
    if (buckets.size > MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
  }

  bucket.count += 1;

  const blocked = bucket.count >= max;
  return {
    blocked,
    retryAfter: blocked ? Math.ceil((bucket.resetAt - now) / 1000) : 0,
    count: bucket.count,
  };
}

/** Clear the counter for a key — call this after a successful login. */
export function clearFailures(key) {
  buckets.delete(key);
}

/** Whether the key is currently blocked (without recording a new failure). */
export function isBlocked(key, { windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    sweep(now);
    lastSweep = now;
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return { blocked: false, retryAfter: 0 };
  if (bucket.count < max) return { blocked: false, retryAfter: 0 };
  return {
    blocked: true,
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Clear all tracked counters. */
export function resetAll() {
  buckets.clear();
}
