import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { mimeFromName } from '../lib/mime.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/**
 * Google Drive provider.
 *
 * Each instance points at one account (service account or OAuth user) and
 * optionally one folder, so you can mix several accounts.
 *
 * `remotePath` is a Drive file ID. The `path` field returned by list() is
 * "<fileId>|<human readable name>" so the library can show real titles.
 */
export function createGoogleDriveProvider(instance = {}) {
  const cfg = instance.config || {};

  const provider = {
    id: instance.id || 'gdrive',
    type: 'gdrive',
    name: instance.name || 'Google Drive',
    description: instance.description || 'Google Drive storage',
    icon: 'folder',
    drive: null,

    isConfigured() {
      const hasServiceAccount = Boolean(cfg.serviceAccountEmail && cfg.serviceAccountPrivateKey);
      const hasOAuth = Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
      return hasServiceAccount || hasOAuth;
    },

    async init() {
      if (!provider.isConfigured()) return;
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive'],
        ...(cfg.serviceAccountEmail && cfg.serviceAccountPrivateKey
          ? {
              credentials: {
                client_email: cfg.serviceAccountEmail,
                private_key: cfg.serviceAccountPrivateKey,
              },
            }
          : {
              clientId: cfg.clientId,
              clientSecret: cfg.clientSecret,
              refreshToken: cfg.refreshToken,
            }),
      });
      provider.drive = google.drive({ version: 'v3', auth });
    },

    encodePath(fileId, name) {
      return `${fileId}|${name ?? ''}`;
    },

    decodePath(remotePath) {
      const raw = String(remotePath || '');
      const idx = raw.indexOf('|');
      if (idx === -1) return { fileId: raw, name: '' };
      return { fileId: raw.slice(0, idx), name: raw.slice(idx + 1) };
    },

    async list(prefix = '') {
      if (!provider.drive) return [];
      const q = ['trashed = false', `mimeType != 'application/vnd.google-apps.folder'`];
      if (cfg.folderId) q.push(`'${cfg.folderId}' in parents`);

      const files = [];
      let pageToken;
      // Drive caps a page at 1000 items — without this loop the scanner
      // would only ever see the first page of a large library.
      do {
        const res = await provider.drive.files.list({
          q: q.join(' and '),
          fields: 'nextPageToken,files(id,name,size,mimeType,modifiedTime,videoMediaMetadata)',
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        files.push(...(res.data.files || []));
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);

      return files
        .map((f) => ({
          path: provider.encodePath(f.id, f.name),
          fileId: f.id,
          name: f.name,
          size: Number(f.size || 0),
          mtime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now(),
          mime: f.mimeType || mimeFromName(f.name),
        }))
        .filter((f) => (prefix ? f.name.startsWith(prefix) : true));
    },

    async stat(remotePath) {
      if (!provider.drive) return null;
      const { fileId, name } = provider.decodePath(remotePath);
      try {
        const res = await provider.drive.files.get({
          fileId,
          fields: 'id,name,size,mimeType,modifiedTime',
          supportsAllDrives: true,
        });
        const data = res.data;
        return {
          path: remotePath,
          fileId,
          name: data.name || name,
          size: Number(data.size || 0),
          mtime: data.modifiedTime ? new Date(data.modifiedTime).getTime() : Date.now(),
          mime: data.mimeType || mimeFromName(data.name),
        };
      } catch {
        return null;
      }
    },

    async createReadStream(remotePath, { start, end } = {}) {
      if (!provider.drive) throw new Error('Google Drive is not configured');
      const { fileId } = provider.decodePath(remotePath);
      const range =
        Number.isFinite(start) && Number.isFinite(end)
          ? `bytes=${start}-${end}`
          : Number.isFinite(start)
            ? `bytes=${start}-`
            : undefined;

      const res = await provider.drive.files.get(
        { fileId, alt: 'media' },
        { headers: range ? { Range: range } : undefined },
      );
      if (typeof res.data === 'string' || Buffer.isBuffer(res.data)) {
        return Readable.from([res.data]);
      }
      if (!res.data) throw new Error('Empty Drive response');
      return res.data;
    },

    async upload(remotePath, source, { size, contentType, name } = {}) {
      if (!provider.drive) throw new Error('Google Drive is not configured');
      const fileName = name || path.basename(String(remotePath).split('|')[1] || remotePath);
      const body =
        typeof source === 'string'
          ? createReadStream(source)
          : Buffer.isBuffer(source)
            ? source
            : source;
      const res = await provider.drive.files.create({
        requestBody: {
          name: fileName,
          ...(cfg.folderId ? { parents: [cfg.folderId] } : {}),
          ...(contentType ? { mimeType: contentType } : {}),
        },
        media: { body, mimeType: contentType || mimeFromName(fileName) },
        fields: 'id,name,size',
        supportsAllDrives: true,
      });
      const stat = await provider.stat(provider.encodePath(res.data.id, res.data.name));
      return {
        path: provider.encodePath(res.data.id, res.data.name),
        size: stat?.size ?? size ?? 0,
      };
    },

    async delete(remotePath) {
      if (!provider.drive) return;
      const { fileId } = provider.decodePath(remotePath);
      await provider.drive.files.delete({ fileId, supportsAllDrives: true });
    },

    async exists(remotePath) {
      return (await provider.stat(remotePath)) !== null;
    },

    /** Total bytes used by the account. */
    async usage() {
      if (!provider.drive) return { bytes: 0, files: 0 };
      let bytes = 0;
      let files = 0;
      let pageToken;
      do {
        const res = await provider.drive.files.list({
          q: 'trashed = false',
          fields: 'nextPageToken,files(id,size)',
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const f of res.data.files || []) {
          bytes += Number(f.size || 0);
          files += 1;
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
      return { bytes, files };
    },
  };

  return provider;
}
