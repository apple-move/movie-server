import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

/**
 * Safe fetching of user-supplied URLs.
 *
 * A movie server that fetches an arbitrary URL on the server's behalf is an
 * SSRF primitive: it could reach cloud metadata endpoints, internal services
 * or the loopback interface. Every URL is therefore validated before it is
 * fetched, and the resolved address is checked again on every redirect.
 */

/** Ranges that must never be reached from a user-supplied URL. */
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;             // 0.0.0.0/8
    if (a === 10) return true;            // 10.0.0.0/8
    if (a === 127) return true;           // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;            // multicast + reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true;   // link-local
    if (lower.startsWith('::ffff:')) {
      return isPrivateAddress(lower.slice(7));
    }
    return false;
  }

  return true;
}

/**
 * Validate a user-supplied URL.
 * @returns {Promise<{url: URL, host: string}>}
 */
export async function validateUrl(raw, { allowPrivate = config.allowPrivateUrls } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('That is not a valid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }

  if (url.username || url.password) {
    throw new Error('URLs with credentials are not allowed');
  }

  if (allowPrivate) return { url, host: url.hostname };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve "${host}"`);
  }
  if (!addresses.length) throw new Error(`Could not resolve "${host}"`);

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(
        `"${host}" points to a private or reserved address, which is not allowed`,
      );
    }
  }

  return { url, host };
}

/**
 * Fetch a URL, validating the host and every redirect hop.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.maxRedirects]
 */
export async function safeFetch(raw, { headers = {}, maxRedirects = 5, allowPrivate = config.allowPrivateUrls, ...init } = {}) {
  let current = String(raw);
  let response = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url } = await validateUrl(current, { allowPrivate });
    response = await fetch(url, {
      ...init,
      headers: { ...headers, 'user-agent': 'MovieServer/1.0', ...(init.headers || {}) },
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }
    return response;
  }

  throw new Error('Too many redirects');
}

/**
 * The file name a URL points at.
 */
export function fileNameFromUrl(raw) {
  try {
    const url = new URL(String(raw));
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return name || 'remote-file';
  } catch {
    return 'remote-file';
  }
}
