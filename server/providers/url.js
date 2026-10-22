import { Readable } from 'node:stream';
import { safeFetch, validateUrl, fileNameFromUrl } from '../lib/safe-url.js';
import { mimeFromName } from '../lib/mime.js';

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
      cachedSize = Number(response.headers.get('content-length') || 0);
      cachedMime = response.headers.get('content-type') || '';
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

      // fetch() gives a web ReadableStream; the rest of the server works with
      // Node streams, so convert it.
      return Readable.fromWeb(response.body);
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
