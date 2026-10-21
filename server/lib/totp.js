import crypto from 'node:crypto';
import { one, run, q } from '../db.js';

/**
 * TOTP (RFC 6238) two-factor authentication.
 *
 * Implemented with Node's built-in crypto so there is no extra dependency.
 * Compatible with Google Authenticator, Authy, Aegis and friends.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

/** Generate a base32 secret (shown to the user as a QR-less string). */
export function generateSecret(bytes = 20) {
  const buffer = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret) {
  const clean = String(secret || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HOTP: one time password for a given counter. */
export function hotp(secret, counter, digits = DEFAULT_DIGITS) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, '0');
}

/** TOTP: the code for the current time window. */
export function totp(secret, timestamp = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS) {
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(secret, counter, digits);
}

/**
 * Verify a submitted code, allowing for a small clock drift.
 */
export function verifyTotp(secret, code, { window = 1, timestamp = Date.now() } = {}) {
  const submitted = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(submitted)) return false;

  const period = DEFAULT_PERIOD;
  const counter = Math.floor(timestamp / 1000 / period);
  for (let i = -window; i <= window; i++) {
    if (hotp(secret, counter + i) === submitted) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app can scan or import manually. */
export function otpauthUri(secret, account, issuer = 'Movie Server') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DEFAULT_DIGITS}&period=${DEFAULT_PERIOD}`;
}

/* --------------------------------------------------------- user binding */

export function enableTotp(userId, secret) {
  run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', secret, userId);
}

export function disableTotp(userId) {
  run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', userId);
}

export function getTotp(userId) {
  return one('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', userId);
}

/** True when the user still has 2FA switched on. */
export function totpEnabled(userId) {
  const row = getTotp(userId);
  return Boolean(row?.totp_enabled && row.totp_secret);
}
