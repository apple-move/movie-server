import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { mimeFromName } from '../lib/mime.js';

/**
 * Local disk provider.
 *
 * Files live under `root` and are addressed with a POSIX-style relative path.
 * Each configured local disk becomes its own instance, so you can mount
 * several drives.
 */
export function createLocalProvider(instance = {}) {
  const root = path.resolve(instance.root || './data/library');

  const provider = {
    id: instance.id || 'local',
    type: 'local',
    name: instance.name || 'Local Disk',
    description: instance.description || `Files on ${root}`,
    icon: 'server',
    root,

    isConfigured() {
      return true;
    },

    async init() {
      await fsPromises.mkdir(root, { recursive: true });
    },

    /** Absolute path for a relative library path, guarding against traversal. */
    resolve(remotePath) {
      const rel = String(remotePath || '').replace(/^[/\\]+/, '');
      const abs = path.resolve(root, rel);
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (abs !== root && !abs.startsWith(rootWithSep)) {
        const err = new Error('Path escapes library root');
        err.status = 400;
        throw err;
      }
      return abs;
    },

    async list(prefix = '') {
      const base = provider.resolve(prefix);
      const out = [];
      const walk = async (dir) => {
        let entries;
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(abs);
          } else if (entry.isFile()) {
            const stat = await fsPromises.stat(abs);
            out.push({
              path: path.relative(root, abs).split(path.sep).join('/'),
              name: entry.name,
              size: stat.size,
              mtime: stat.mtimeMs,
              mime: mimeFromName(entry.name),
            });
          }
        }
      };
      await walk(base);
      return out;
    },

    async stat(remotePath) {
      try {
        const abs = provider.resolve(remotePath);
        const stat = await fsPromises.stat(abs);
        if (!stat.isFile()) return null;
        return {
          path: remotePath,
          name: path.basename(abs),
          size: stat.size,
          mtime: stat.mtimeMs,
          mime: mimeFromName(abs),
        };
      } catch {
        return null;
      }
    },

    async createReadStream(remotePath, { start, end } = {}) {
      const abs = provider.resolve(remotePath);
      const opts = {};
      if (Number.isFinite(start)) opts.start = start;
      if (Number.isFinite(end)) opts.end = end;
      return createReadStream(abs, opts);
    },

    async upload(remotePath, source) {
      const abs = provider.resolve(remotePath);
      await fsPromises.mkdir(path.dirname(abs), { recursive: true });
      // `source` may be a Buffer, a stream, or a path to a temp file on disk.
      const input = Buffer.isBuffer(source)
        ? Readable.from(source)
        : typeof source === 'string'
          ? createReadStream(source)
          : source;
      // Write to a temp name first so a failed upload never leaves a
      // half-written file where the library expects a complete one.
      const tmp = `${abs}.part`;
      try {
        await pipeline(input, createWriteStream(tmp));
        await fsPromises.rename(tmp, abs);
      } catch (err) {
        await fsPromises.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      const stat = await fsPromises.stat(abs);
      return { path: remotePath, size: stat.size };
    },

    async delete(remotePath) {
      await fsPromises.rm(provider.resolve(remotePath), { force: true });
    },

    async exists(remotePath) {
      return (await provider.stat(remotePath)) !== null;
    },

    /** Disk usage of the whole library root. */
    async usage() {
      let bytes = 0;
      let files = 0;
      const walk = async (dir) => {
        let entries;
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(abs);
          else if (entry.isFile()) {
            try {
              const stat = await fsPromises.stat(abs);
              bytes += stat.size;
              files += 1;
            } catch { /* ignore */ }
          }
        }
      };
      await walk(root);
      return { bytes, files };
    },
  };

  return provider;
}
