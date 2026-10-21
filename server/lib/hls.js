/**
 * HLS playlist helpers.
 *
 * A `.m3u8` file references its segments with relative or absolute URIs.
 * When the playlist is served through this server, every URI has to be
 * rewritten to point back at the server so the browser fetches the segments
 * through the same authenticated route.
 *
 * The rewritten form is:
 *   /api/stream/<sourceId>/hls?path=<url-encoded absolute path>
 *
 * Security: a URI that resolves outside the playlist's own directory is
 * rejected rather than clamped, so a crafted playlist can never be used to
 * read arbitrary objects out of a storage provider.
 */

const PLAYLIST_MIME = 'application/vnd.apple.mpegurl';

/** Split "path?query" into its two parts. */
export function splitUri(uri) {
  const raw = String(uri || '');
  const index = raw.indexOf('?');
  if (index === -1) return { path: raw, query: '' };
  return { path: raw.slice(0, index), query: raw.slice(index) };
}

/** Is this an absolute URL (http://, https://, //host/...)? */
export function isAbsoluteUri(uri) {
  return /^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//');
}

/**
 * Resolve a playlist-relative URI against the playlist's own directory.
 *
 * @returns {string|null} the resolved path, or null when the URI escapes
 *   the playlist's directory (which must be rejected, not clamped).
 */
export function resolveUri(uri, playlistPath) {
  if (!uri) return null;
  if (isAbsoluteUri(uri)) return uri;

  const { path: bare, query } = splitUri(uri);
  if (bare.startsWith('/')) {
    // Root-relative inside the provider — keep it, it is already absolute.
    return bare + query;
  }

  const base = playlistPath.includes('/')
    ? playlistPath.slice(0, playlistPath.lastIndexOf('/'))
    : '';
  const joined = base ? `${base}/${bare}` : bare;

  const parts = [];
  for (const segment of joined.split('/')) {
    // Windows separators must be normalised so "..\\..\\x" cannot escape.
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      // Escaping above the playlist's own directory is not allowed.
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/') + query;
}

/**
 * Rewrite every URI in a playlist so it points back at this server.
 *
 * @param {string} text         raw playlist content
 * @param {string} playlistPath path of the playlist inside the provider
 * @param {string} baseUrl      e.g. "/api/stream/12/hls?path="
 * @param {string} [query]      extra query string to append (e.g. a job token)
 * @returns {{text: string, rejected: string[]}}
 */
export function rewritePlaylist(text, playlistPath, baseUrl, query = '') {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  const rejected = [];

  const toServerUrl = (uri) => {
    // Absolute URLs are passed through untouched — the browser fetches them
    // directly and the server never sees them.
    if (isAbsoluteUri(uri)) return uri;

    const resolved = resolveUri(uri, playlistPath);
    if (resolved === null) {
      rejected.push(uri);
      return null;
    }
    return `${baseUrl}${encodeURIComponent(resolved)}${query}`;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      continue;
    }

    // URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP).
    if (trimmed.includes('URI="')) {
      const rewritten = trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const url = toServerUrl(uri);
        return url === null ? 'URI=""' : `URI="${url}"`;
      });
      out.push(rewritten);
      continue;
    }

    // A bare URI line: either a segment or a child playlist.
    if (!trimmed.startsWith('#')) {
      const url = toServerUrl(trimmed);
      out.push(url === null ? '' : url);
      continue;
    }

    out.push(line);
  }

  return { text: out.join('\n'), rejected };
}

/**
 * Extract the variant playlists referenced by a master playlist.
 * Returns the resolved paths, so the UI can offer quality options.
 */
export function listVariants(text, playlistPath) {
  const variants = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = (lines[i + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    const resolved = resolveUri(next, playlistPath);
    if (!resolved) continue;
    const bandwidth = /BANDWIDTH=(\d+)/i.exec(line);
    const resolution = /RESOLUTION=(\d+x\d+)/i.exec(line);
    variants.push({
      path: resolved,
      bandwidth: bandwidth ? Number(bandwidth[1]) : null,
      resolution: resolution ? resolution[1] : null,
    });
  }
  return variants;
}

/** Parse `#EXT-X-MEDIA` subtitle renditions from a master playlist. */
export function listSubtitles(text, playlistPath) {
  const tracks = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#EXT-X-MEDIA:')) continue;
    if (!/TYPE=SUBTITLES/i.test(trimmed)) continue;
    const uri = /URI="([^"]+)"/i.exec(trimmed);
    if (!uri) continue;
    const resolved = resolveUri(uri[1], playlistPath);
    if (!resolved) continue;
    const name = /NAME="([^"]*)"/i.exec(trimmed);
    const lang = /LANGUAGE="([^"]*)"/i.exec(trimmed);
    tracks.push({
      path: resolved,
      name: name ? name[1] : 'Subtitles',
      language: lang ? lang[1] : 'und',
    });
  }
  return tracks;
}

export { PLAYLIST_MIME };
