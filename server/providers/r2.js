import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mimeFromName } from '../lib/mime.js';

/**
 * Cloudflare R2 (S3-compatible) provider.
 *
 * Each instance points at one bucket, so you can run several R2 buckets
 * (personal, 4K archive, friends' shares…) side by side.
 *
 * Streams are proxied through this server by default so auth stays central,
 * but a presigned direct URL can be used to offload bandwidth.
 */
export function createR2Provider(instance = {}) {
  const cfg = instance.config || {};
  const bucket = cfg.bucket || 'movies';
  const endpoint =
    cfg.endpoint ||
    (cfg.accountId ? `https://${cfg.accountId}.r2.cloudflarestorage.com` : '');

  const provider = {
    id: instance.id || 'r2',
    type: 'r2',
    name: instance.name || 'Cloudflare R2',
    description: instance.description || `R2 bucket "${bucket}"`,
    icon: 'cloud',
    bucket,
    client: null,

    isConfigured() {
      return Boolean(cfg.accessKeyId && cfg.secretAccessKey && bucket && endpoint);
    },

    async init() {
      if (!provider.isConfigured()) return;
      provider.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
      });
    },

    key(remotePath) {
      return String(remotePath || '').replace(/^[/\\]+/, '');
    },

    async list(prefix = '') {
      if (!provider.client) return [];
      const out = [];
      let token;
      do {
        const res = await provider.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: provider.key(prefix),
            ContinuationToken: token,
          }),
        );
        for (const obj of res.Contents || []) {
          if (obj.Key.endsWith('/')) continue;
          out.push({
            path: obj.Key,
            name: path.basename(obj.Key),
            size: obj.Size || 0,
            mtime: obj.LastModified ? new Date(obj.LastModified).getTime() : Date.now(),
            mime: mimeFromName(obj.Key),
          });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },

    async stat(remotePath) {
      if (!provider.client) return null;
      try {
        const res = await provider.client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: provider.key(remotePath) }),
        );
        return {
          path: remotePath,
          name: path.basename(provider.key(remotePath)),
          size: res.ContentLength || 0,
          mtime: res.LastModified ? new Date(res.LastModified).getTime() : Date.now(),
          mime: res.ContentType || mimeFromName(remotePath),
        };
      } catch {
        return null;
      }
    },

    async createReadStream(remotePath, { start, end } = {}) {
      const range =
        Number.isFinite(start) && Number.isFinite(end)
          ? `bytes=${start}-${end}`
          : Number.isFinite(start)
            ? `bytes=${start}-`
            : undefined;
      const res = await provider.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: provider.key(remotePath), Range: range }),
      );
      if (!res.Body) throw new Error('Empty R2 response body');
      return res.Body;
    },

    /** Presigned URL that lets the browser pull bytes straight from R2. */
    async getDirectUrl(remotePath, expiresIn = 3600) {
      if (!provider.client) return null;
      return getSignedUrl(
        provider.client,
        new GetObjectCommand({ Bucket: bucket, Key: provider.key(remotePath) }),
        { expiresIn },
      );
    },

    async upload(remotePath, source, { size, contentType } = {}) {
      if (!provider.client) throw new Error('R2 is not configured');
      const body =
        typeof source === 'string'
          ? createReadStream(source)
          : Buffer.isBuffer(source)
            ? source
            : source;
      await provider.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: provider.key(remotePath),
          Body: body,
          ContentLength: size,
          ContentType: contentType || mimeFromName(remotePath),
        }),
      );
      const stat = await provider.stat(remotePath);
      return { path: remotePath, size: stat?.size ?? size ?? 0 };
    },

    async delete(remotePath) {
      if (!provider.client) return;
      await provider.client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: provider.key(remotePath) }),
      );
    },

    async exists(remotePath) {
      return (await provider.stat(remotePath)) !== null;
    },

    /** Total bytes stored in this bucket. */
    async usage() {
      if (!provider.client) return { bytes: 0, files: 0 };
      let bytes = 0;
      let files = 0;
      let token;
      do {
        const res = await provider.client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        );
        for (const obj of res.Contents || []) {
          bytes += obj.Size || 0;
          files += 1;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return { bytes, files };
    },
  };

  return provider;
}
