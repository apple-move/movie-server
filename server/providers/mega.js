import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Storage } from 'megajs';
import { mimeFromName } from '../lib/mime.js';

/**
 * MEGA provider (megajs v1.x).
 *
 * Each instance is one MEGA account, so you can use several accounts
 * side by side (20 GB free each) and pick which one to read from.
 *
 * `remotePath` is the absolute MEGA path, e.g. "/Movies/Inception (2010)/file.mkv".
 * MEGA supports byte-range downloads natively, which lets the browser seek
 * without downloading the whole file first.
 */
export function createMegaProvider(instance = {}) {
  const cfg = instance.config || {};

  const provider = {
    id: instance.id || 'mega',
    type: 'mega',
    name: instance.name || 'MEGA',
    description: instance.description || 'MEGA cloud storage',
    icon: 'database',
    storage: null,

    isConfigured() {
      return Boolean(cfg.email && cfg.password);
    },

    async init() {
      if (!provider.isConfigured()) return;
      provider.storage = new Storage({
        email: cfg.email,
        password: cfg.password,
        userAgent: 'MovieServer/1.0',
      });
      await provider.storage.login();
    },

    /** Absolute path of a node, built by walking up to the root. */
    nodePath(node) {
      const parts = [];
      let current = node;
      let guard = 0;
      while (current && guard++ < 64) {
        if (current.name && current !== provider.storage?.root) parts.unshift(current.name);
        current = current.parent;
      }
      return `/${parts.join('/')}`;
    },

    /** Find a node by its absolute path. */
    findNode(remotePath) {
      if (!provider.storage) return null;
      const target = String(remotePath || '').replace(/\/+$/, '');
      const segments = target.split('/').filter(Boolean);
      if (!segments.length) return provider.storage.root;

      let node = provider.storage.root;
      for (const segment of segments) {
        const children = node.children || [];
        const match = children.find((child) => child.name === segment);
        if (!match) return null;
        node = match;
      }
      return node;
    },

    /** Find a directory node by path. */
    findDirectory(dirPath) {
      if (!provider.storage) return null;
      const segments = String(dirPath || '').split('/').filter(Boolean);
      if (!segments.length) return provider.storage.root;
      let node = provider.storage.root;
      for (const segment of segments) {
        const children = node.children || [];
        const match = children.find((child) => child.name === segment && child.directory);
        if (!match) return null;
        node = match;
      }
      return node;
    },

    async list(prefix = '') {
      if (!provider.storage) return [];
      const root = cfg.rootFolder
        ? provider.findDirectory(cfg.rootFolder) || provider.storage.root
        : provider.storage.root;

      const out = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.directory) {
            walk(child);
          } else {
            out.push({
              path: provider.nodePath(child),
              nodeId: child.nodeId,
              name: child.name,
              size: Number(child.size || 0),
              mtime: Number(child.timestamp || 0) * 1000,
              mime: mimeFromName(child.name),
            });
          }
        }
      };
      walk(root);
      return out.filter((f) => (prefix ? f.name.startsWith(prefix) : true));
    },

    async stat(remotePath) {
      const node = provider.findNode(remotePath);
      if (!node || node.directory) return null;
      return {
        path: remotePath,
        name: node.name,
        size: Number(node.size || 0),
        mtime: Number(child_timestamp(node)),
        mime: mimeFromName(node.name),
      };
    },

    async createReadStream(remotePath, { start, end } = {}) {
      const node = provider.findNode(remotePath);
      if (!node) throw new Error(`MEGA file not found: ${remotePath}`);
      const opts = {};
      if (Number.isFinite(start)) opts.start = start;
      if (Number.isFinite(end)) opts.end = end;
      return node.download(opts);
    },

    async upload(remotePath, source, { size, contentType, name } = {}) {
      if (!provider.storage) throw new Error('MEGA is not configured');
      const fileName = name || path.basename(remotePath);
      const dirPath = path.dirname(remotePath).replace(/\\/g, '/');

      let dir = provider.storage.root;
      if (dirPath && dirPath !== '/') {
        dir = provider.findDirectory(dirPath);
        if (!dir) {
          // Create the missing folder chain one level at a time.
          const segments = dirPath.split('/').filter(Boolean);
          let current = provider.storage.root;
          for (const segment of segments) {
            const existing = (current.children || []).find(
              (child) => child.name === segment && child.directory,
            );
            current = existing || (await current.mkdir(segment));
          }
          dir = current;
        }
      }

      // Stream the file — reading a multi-GB upload into a Buffer would OOM.
      const body = Buffer.isBuffer(source)
        ? source
        : typeof source === 'string'
          ? createReadStream(source)
          : source;
      const upload = dir.upload({
        name: fileName,
        size: Number(size) || undefined,
        ...(contentType ? { mimeType: contentType } : {}),
      });

      // `pipe` does not forward errors — without this an unreadable temp file
      // would emit an unhandled 'error' event and kill the process.
      if (body && typeof body.pipe === 'function') {
        body.on('error', (err) => upload.destroy(err));
        body.pipe(upload);
      } else {
        upload.end(body);
      }

      const file = await upload.complete;
      return { path: provider.nodePath(file), size: Number(file.size || size || 0) };
    },

    async delete(remotePath) {
      const node = provider.findNode(remotePath);
      if (node) await node.delete(true);
    },

    async exists(remotePath) {
      return (await provider.stat(remotePath)) !== null;
    },

    async usage() {
      if (!provider.storage) return { bytes: 0, files: 0 };
      let bytes = 0;
      let files = 0;
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.directory) walk(child);
          else {
            bytes += Number(child.size || 0);
            files += 1;
          }
        }
      };
      walk(provider.storage.root);
      return { bytes, files };
    },
  };

  return provider;
}

function child_timestamp(node) {
  return Number(node?.timestamp || 0) * 1000;
}
