/**
 * API client — thin wrapper around fetch with token handling and error shaping.
 */

let token = localStorage.getItem('ms_token') || null;

export function setToken(value) {
  token = value;
  if (value) localStorage.setItem('ms_token', value);
  else localStorage.removeItem('ms_token');
}

export function getToken() {
  return token;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, options = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(path, { method, headers, body: payload, ...options });

  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && data.error) ||
      (typeof data === 'string' && data.slice(0, 200)) ||
      `Request failed (${res.status})`;

    // An expired session must clear BOTH the stored token and the cookie,
    // otherwise the server keeps authenticating the request via the cookie
    // while the UI thinks the user is signed out.
    if (res.status === 401 && !options.keepSession) {
      setToken(null);
      document.cookie = 'ms_token=; Path=/; Max-Age=0; SameSite=Lax';
    }

    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  upload: (path, formData) => request('POST', path, formData),
};

/** URL for streaming a source in the browser (uses the cookie/token). */
export function streamUrl(sourceId, extra = '') {
  const suffix = extra ? (extra.startsWith('?') ? extra : `?${extra}`) : '';
  return `/api/stream/${sourceId}${suffix}`;
}

export function downloadUrl(sourceId) {
  return `/api/stream/${sourceId}/download`;
}
