import { Readable } from 'node:stream';
import { safeFetch, validateUrl, fileNameFromUrl } from '../lib/safe-url.js';
import { mimeFromName } from '../lib/mime.js';

/**
 * Pick the bytes `start..end` out of a stream.
 *
 * Used when the remote server ignores the Range header and answers with the
 * whole file: the requested window has to be cut out here, otherwise the
 * viewer receives the wrong part of the file (and more bytes than the
 * Content-Length promises).
 */
function sliceBytes(source, start = 0, end) {
  return Readable.from(
    (async function* () {
      let toSkip = start;
      let remaining = Number.isFinite(end) ? end - start + 1 : Infinity;

      for await (const chunk of source) {
        if (remaining <= 0) break;

        let buf = chunk;
        if (toSkip > 0) {
          const drop = Math.min(toSkip, buf.length);
          toSkip -= drop;
          buf = buf.subarray(drop);
          if (!buf.length) continue;
        }

        if (buf.length > remaining) buf = buf.subarray(0, remaining);
        remaining -= buf.length;
        yield buf;
      }
    })(),
  );
}

/**
 * A storage provider backed by a single remote URL.
 *
 * It implements the same interface as the other providers, so the ZIP
 * reader, the range handling and the download route all work with it
 * unchanged.
 *
 * Used for "add a movie by URL" — a direct video URL, or a ZIP URL whose
 * entries can then be picked in the player.
 */
export function createUrlProvider(instance = {}) {
  // The registry passes the stored settings as `config`.
  const settings = instance.config || instance;
  const rawUrl = String(settings.url || instance.url || '');
  const name = settings.name || instance.name || fileNameFromUrl(rawUrl);

  /** The remote file size, looked up once and then remembered. */
  let cachedSize = Number(instance.size) || 0;
  let cachedMime = '';

  async function head() {
    if (cachedSize) return { size: cachedSize, mime: cachedMime };
    try {
      const response = await safeFetch(rawUrl, { method: 'HEAD' });
      if (!response.ok && response.status !== 206) {
        // A failure is not remembered — the admin may fix the URL and retry.
        return { size: 0, mime: cachedMime };
      }
      cachedSize = Number(response.headers.get('content-length') || 0);
      const type = response.headers.get('content-type') || '';
      // Only trust a real media type; a captive portal's text/html is not.
      if (type.startsWith('video/') || type.startsWith('audio/')) {
        cachedMime = type;
      }
    } catch (err) {
      console.error('[url] HEAD failed:', err.message);
    }
    return { size: cachedSize, mime: cachedMime };
  }

  const provider = {
    id: instance.id || 'url',
    type: 'url',
    name: instance.name || name,
    description: instance.description || `Remote file: ${rawUrl}`,
    icon: 'link',
    url: rawUrl,

    isConfigured() {
      return Boolean(rawUrl);
    },

    async init() {
      if (!rawUrl) return;
      // Fail early with a clear message if the URL is unreachable.
      try {
        await validateUrl(rawUrl);
      } catch (err) {
        throw new Error(err.message);
      }
    },

    async list() {
      if (!rawUrl) return [];
      const { size } = await head();
      return [
        {
          path: rawUrl,
          name,
          size,
          mtime: Date.now(),
          mime: mimeFromName(name),
        },
      ];
    },

    async stat(remotePath) {
      if (!rawUrl) return null;
      const target = String(remotePath || rawUrl);
      if (target !== rawUrl) return null;
      const { size, mime } = await head();
      return {
        path: rawUrl,
        name,
        size,
        mtime: Date.now(),
        mime: mime || mimeFromName(name),
      };
    },

    /**
     * Stream the remote file, honouring the Range header.
     */
    async createReadStream(remotePath, { start, end } = {}) {
      const target = String(remotePath || rawUrl);
      if (target !== rawUrl) {
        throw new Error('Only the original URL can be read');
      }

      const headers = {};
      if (Number.isFinite(start)) {
        headers.Range = Number.isFinite(end)
          ? `bytes=${start}-${end}`
          : `bytes=${start}-`;
      }

      const response = await safeFetch(rawUrl, { headers });
      if (!response.ok && response.status !== 206) {
        throw new Error(`The remote server answered ${response.status}`);
      }
      if (!response.body) throw new Error('The remote server sent no data');

      const stream = Readable.fromWeb(response.body);

      // Some servers ignore the Range header and answer with the whole file.
      // The bytes for the requested window then have to be picked out here —
      // otherwise the viewer would get the wrong part of the file.
      if (Number.isFinite(start) && response.status === 200) {
        return sliceBytes(stream, start, end);
      }
      return stream;
    },

    async delete() {
      /* A remote file cannot be deleted from here. */
    },

    async exists() {
      return Boolean(rawUrl);
    },

    async usage() {
      return { bytes: 0, files: 1 };
    },
  };

  return provider;
}

/**
 * A provider that reads a remote ZIP archive.
 *
 * The ZIP reader only needs `stat` and `createReadStream` with byte ranges,
 * so the same implementation works for a remote archive.
 */
export function createUrlArchiveProvider(instance = {}) {
  const base = createUrlProvider(instance);
  const name = base.name;

  return {
    ...base,
    type: 'url-archive',
    name: instance.name || name,
    description: instance.description || `Remote archive: ${base.url}`,
    icon: '📦',
  };
}
