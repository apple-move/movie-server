import { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { mimeFromName } from '../lib/mime.js';

const API = 'https://api.telegram.org';

/**
 * Telegram provider — uses a bot as a file store.
 *
 * Caveats imposed by the Bot API:
 *  - `sendDocument` max 50 MB
 *  - `getFile` download max 20 MB
 * Telegram is therefore best used for trailers, short clips, subtitle files
 * or a low-priority backup tier — not for full 1080p feature files.
 *
 * Each instance is one bot + chat, so you can run several.
 */
export function createTelegramProvider(instance = {}) {
  const cfg = instance.config || {};
  const botToken = cfg.botToken || '';
  const chatId = cfg.chatId || '';
  const maxUpload = 50 * 1024 * 1024;
  const maxDownload = 20 * 1024 * 1024;

  const provider = {
    id: instance.id || 'telegram',
    type: 'telegram',
    name: instance.name || 'Telegram',
    description: instance.description || 'Bot file store (50MB up / 20MB down)',
    icon: 'send',

    isConfigured() {
      return Boolean(botToken && chatId);
    },

    async init() {
      /* Nothing to initialise eagerly; auth happens per request. */
    },

    async call(method, payload) {
      const res = await fetch(`${API}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) {
        throw new Error(json.description || `Telegram ${method} failed`);
      }
      return json.result;
    },

    async list(prefix = '') {
      if (!provider.isConfigured()) return [];
      // Telegram has no folder listing; we track files via message history.
      const out = [];
      let offset = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const updates = await provider.call('getUpdates', { offset, limit: 100, timeout: 0 }).catch(() => []);
        if (!updates || updates.length === 0) break;
        for (const update of updates) {
          const msg = update.message || update.channel_post;
          const doc = msg?.document || msg?.video;
          if (!doc) continue;
          out.push({
            path: `${doc.file_id}|${doc.file_name || 'file'}`,
            fileId: doc.file_id,
            name: doc.file_name || 'file',
            size: doc.file_size || 0,
            mtime: (msg.date || 0) * 1000,
            mime: doc.mime_type || mimeFromName(doc.file_name || ''),
          });
        }
        offset = updates[updates.length - 1].update_id + 1;
        if (updates.length < 100) break;
      }
      return out.filter((f) => (prefix ? f.name.startsWith(prefix) : true));
    },

    async stat(remotePath) {
      if (!provider.isConfigured()) return null;
      const [fileId, name] = String(remotePath).split('|');
      try {
        const file = await provider.call('getFile', { file_id: fileId });
        return {
          path: remotePath,
          fileId,
          name: name || file.file_path?.split('/').pop() || 'file',
          size: file.file_size || 0,
          mtime: Date.now(),
          mime: mimeFromName(name || ''),
        };
      } catch {
        return null;
      }
    },

    async createReadStream(remotePath, { start, end } = {}) {
      if (!provider.isConfigured()) throw new Error('Telegram is not configured');
      const [fileId] = String(remotePath).split('|');
      const file = await provider.call('getFile', { file_id: fileId });
      const url = `${API}/file/bot${botToken}/${file.file_path}`;
      const range =
        Number.isFinite(start) && Number.isFinite(end)
          ? `bytes=${start}-${end}`
          : Number.isFinite(start)
            ? `bytes=${start}-`
            : undefined;
      const res = await fetch(url, { headers: range ? { Range: range } : undefined });
      if (!res.ok) {
        throw new Error(`Telegram download failed: ${res.status}`);
      }
      if (!res.body) throw new Error('Empty Telegram response body');
      return Readable.fromWeb(res.body);
    },

    async upload(remotePath, source, { size, contentType, name } = {}) {
      if (!provider.isConfigured()) throw new Error('Telegram is not configured');
      const fileName = name || 'file';

      // Check the size BEFORE reading anything, otherwise a 5 GB upload is
      // fully buffered into RAM and then rejected.
      let byteLength = Number(size) || 0;
      if (!byteLength && typeof source === 'string') {
        try {
          byteLength = (await stat(source)).size;
        } catch {
          byteLength = 0;
        }
      }
      if (byteLength > maxUpload) {
        throw new Error(
          `Telegram Bot API limit is 50MB per upload (got ${(byteLength / 1024 / 1024).toFixed(1)}MB). Use R2 or Drive for large files.`,
        );
      }

      const blob =
        typeof source === 'string'
          ? await readFile(source)
          : Buffer.isBuffer(source)
            ? source
            : Buffer.from(await collect(source));

      if (blob.length > maxUpload) {
        throw new Error(
          `Telegram Bot API limit is 50MB per upload (got ${(blob.length / 1024 / 1024).toFixed(1)}MB). Use R2 or Drive for large files.`,
        );
      }

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([blob], { type: contentType || 'application/octet-stream' }), fileName);
      const res = await fetch(`${API}/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.description || 'Telegram upload failed');
      const doc = json.result.document;
      return { path: `${doc.file_id}|${doc.file_name || fileName}`, size: doc.file_size || blob.length };
    },

    async delete(remotePath) {
      /* Telegram has no file delete API; the message is left in place. */
    },

    async exists(remotePath) {
      return (await provider.stat(remotePath)) !== null;
    },

    async usage() {
      if (!provider.isConfigured()) return { bytes: 0, files: 0 };
      const files = await provider.list('');
      return { bytes: files.reduce((sum, f) => sum + (f.size || 0), 0), files: files.length };
    },
  };

  return provider;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
