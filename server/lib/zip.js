/**
 * ZIP archive reader built on top of HTTP range requests.
 *
 * This lets the site play a video that lives *inside* a .zip stored on any
 * provider (R2, Drive, MEGA, Telegram, local disk) without downloading the
 * whole archive first:
 *
 *  1. Read the last 64 KB and locate the End Of Central Directory record.
 *  2. Read the central directory and pick the entry you want.
 *  3. Read only that entry's local header + data.
 *     - STORED entries can be range-read directly (perfect seeking).
 *     - DEFLATED entries are inflated on the fly; seeking needs the stream
 *       to start at the beginning of the entry, so the leading bytes are
 *       inflated and discarded.
 */
import { createInflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Maximum bytes read when hunting for the end-of-central-directory record. */
const TAIL_SIZE = 64 * 1024;

/** Refuse to load a central directory larger than this into memory. */
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

/**
 * Read a byte range from a provider-backed file.
 * @param {{createReadStream: Function, stat: Function}} provider
 */
async function readRange(provider, remotePath, start, end) {
  const stream = await provider.createReadStream(remotePath, { start, end });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * List the entries of a ZIP archive.
 * @returns {Promise<Array<{name, size, compressedSize, method, offset, isDir}>>}
 */
export async function listZipEntries(provider, remotePath) {
  const stat = await provider.stat(remotePath);
  if (!stat) throw new Error('Archive not found');

  const size = stat.size;
  if (size < 22) throw new Error('File is too small to be a ZIP archive');

  // 1. Find the EOCD record in the tail of the file.
  const tailStart = Math.max(0, size - TAIL_SIZE);
  const tail = await readRange(provider, remotePath, tailStart, size - 1);

  let eocdOffset = -1;
  let fallbackOffset = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    // The comment length must match the bytes that follow the record,
    // otherwise a "PK\x05\x06" sequence inside the comment is a false
    // positive and the real archive would parse as empty.
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLen === tail.length) {
      eocdOffset = i;
      break;
    }
    if (fallbackOffset === -1) fallbackOffset = i;
  }
  if (eocdOffset === -1) eocdOffset = fallbackOffset;
  if (eocdOffset === -1) throw new Error('Not a valid ZIP archive (no EOCD record)');

  const eocdAbsolute = tailStart + eocdOffset;
  const commentLength = tail.readUInt16LE(eocdOffset + 20);

  let entryCount = tail.readUInt16LE(eocdOffset + 10);
  let cdSize = tail.readUInt32LE(eocdOffset + 12);
  let cdOffset = tail.readUInt32LE(eocdOffset + 16);

  // 2. ZIP64 — the 32-bit fields are saturated and the real values live in
  //    the ZIP64 end-of-central-directory record.
  if (
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    // The ZIP64 EOCD locator sits immediately before the EOCD record.
    const locPos = eocdOffset - 20;
    if (locPos < 0 || tail.readUInt32LE(locPos) !== EOCD64_LOC_SIG) {
      throw new Error('ZIP64 archive without a locator — the archive is truncated');
    }
    const eocd64Pos = Number(tail.readBigUInt64LE(locPos + 8));
    if (!Number.isFinite(eocd64Pos) || eocd64Pos < 0 || eocd64Pos >= size) {
      throw new Error('Invalid ZIP64 end-of-central-directory record');
    }
    const header = await readRange(provider, remotePath, eocd64Pos, eocd64Pos + 55);
    if (header.length < 56 || header.readUInt32LE(0) !== EOCD64_SIG) {
      throw new Error('Invalid ZIP64 end-of-central-directory record');
    }
    entryCount = Number(header.readBigUInt64LE(32));
    cdSize = Number(header.readBigUInt64LE(40));
    cdOffset = Number(header.readBigUInt64LE(48));
  }

  // The central directory ends exactly where the EOCD record begins. When the
  // recorded offset does not line up (a prepended payload shifts everything)
  // the real position can be recovered from that relationship.
  const expectedCdEnd = eocdAbsolute;
  if (cdOffset + cdSize !== expectedCdEnd && expectedCdEnd - cdSize >= 0) {
    cdOffset = expectedCdEnd - cdSize;
  }

  if (
    !Number.isFinite(cdOffset) ||
    !Number.isFinite(cdSize) ||
    cdOffset < 0 ||
    cdSize < 0 ||
    cdOffset + cdSize > size
  ) {
    throw new Error('Invalid central directory bounds');
  }
  if (cdSize > MAX_CENTRAL_DIRECTORY) {
    throw new Error('Central directory is too large to read');
  }

  // 3. Read the central directory.
  const cd = await readRange(provider, remotePath, cdOffset, cdOffset + cdSize - 1);

  const entries = [];
  let pos = 0;
  while (pos + 46 <= cd.length && entryCount > 0) {
    if (cd.readUInt32LE(pos) !== CEN_SIG) break;

    const method = cd.readUInt16LE(pos + 10);
    let compressedSize = cd.readUInt32LE(pos + 20);
    let uncompressedSize = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    let localOffset = cd.readUInt32LE(pos + 42);

    // A truncated or lying entry must not make us read past the buffer.
    const entryEnd = pos + 46 + nameLen + extraLen + commentLen;
    if (entryEnd > cd.length) break;

    const name = cd.toString('utf8', pos + 46, pos + 46 + nameLen);

    // ZIP64 extended information overrides the saturated fields.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      const extraStart = pos + 46 + nameLen;
      // The walk is bounded by BOTH the declared length and the buffer.
      const extraEnd = Math.min(extraStart + extraLen, cd.length);
      let ep = extraStart;
      while (ep + 4 <= extraEnd) {
        const headerId = cd.readUInt16LE(ep);
        const dataSize = cd.readUInt16LE(ep + 2);
        if (ep + 4 + dataSize > cd.length) break;
        if (headerId === 0x0001) {
          let zp = ep + 4;
          if (uncompressedSize === 0xffffffff && zp + 8 <= cd.length) {
            uncompressedSize = Number(cd.readBigUInt64LE(zp));
            zp += 8;
          }
          if (compressedSize === 0xffffffff && zp + 8 <= cd.length) {
            compressedSize = Number(cd.readBigUInt64LE(zp));
            zp += 8;
          }
          if (localOffset === 0xffffffff && zp + 8 <= cd.length) {
            localOffset = Number(cd.readBigUInt64LE(zp));
          }
          break;
        }
        ep += 4 + dataSize;
      }
    }

    entries.push({
      name,
      size: uncompressedSize,
      compressedSize,
      method,
      offset: localOffset,
      isDir: name.endsWith('/'),
    });

    pos = entryEnd;
    entryCount -= 1;
  }

  return entries;
}

/**
 * Locate the compressed data of an entry.
 * The local header repeats the name/extra lengths, so the data starts after
 * them — the central directory lengths are not always identical.
 */
async function findDataOffset(provider, remotePath, entry) {
  const header = await readRange(provider, remotePath, entry.offset, entry.offset + 29);
  if (header.length < 30 || header.readUInt32LE(0) !== LOC_SIG) {
    throw new Error(`Corrupt ZIP entry header for "${entry.name}"`);
  }
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  return entry.offset + 30 + nameLen + extraLen;
}

/**
 * Open a readable stream for one entry inside a ZIP.
 *
 * @param {object} provider  storage provider
 * @param {string} remotePath path of the .zip file
 * @param {object} entry     entry descriptor from listZipEntries()
 * @param {object} [range]   { start, end } over the *uncompressed* data
 * @returns {Promise<{stream: Readable, size: number}>}
 */
export async function openZipEntryStream(provider, remotePath, entry, { start, end } = {}) {
  const dataOffset = await findDataOffset(provider, remotePath, entry);
  const size = entry.size;

  if (entry.method === METHOD_STORE) {
    // Stored entries map 1:1 onto the file, so a plain range read works.
    // The start offset ALWAYS has to include the data offset, otherwise the
    // ZIP header itself would be streamed.
    const opts = {
      start: dataOffset + (Number.isFinite(start) ? start : 0),
    };
    if (Number.isFinite(end)) opts.end = dataOffset + end;
    const stream = await provider.createReadStream(remotePath, opts);
    return { stream, size };
  }

  if (entry.method !== METHOD_DEFLATE) {
    throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  }

  // Deflated entries must be inflated sequentially, so the stream always
  // starts at the beginning of the entry and the leading bytes are dropped
  // when a range is requested.
  const raw = await provider.createReadStream(remotePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });

  const inflater = createInflateRaw();
  raw.on('error', (err) => inflater.destroy(err));
  raw.pipe(inflater);

  let output = inflater;
  if (Number.isFinite(start) && start > 0) {
    output = dropLeading(inflater, start);
  }
  if (Number.isFinite(end)) {
    output = takeAtMost(output, end - (Number.isFinite(start) ? start : 0) + 1);
  }

  return { stream: output, size };
}

/** Discard the first `count` bytes of a stream. */
function dropLeading(source, count) {
  let seen = 0;
  const passthrough = new Transform({
    transform(chunk, _enc, cb) {
      if (seen >= count) {
        cb(null, chunk);
        return;
      }
      const drop = Math.min(count - seen, chunk.length);
      seen += drop;
      if (drop >= chunk.length) {
        cb();
        return;
      }
      cb(null, chunk.subarray(drop));
    },
  });
  source.on('error', (err) => passthrough.destroy(err));
  return source.pipe(passthrough);
}

/** Stop a stream after `max` bytes. */
function takeAtMost(source, max) {
  let sent = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      const remaining = max - sent;
      if (remaining <= 0) {
        cb();
        return;
      }
      let buf = chunk;
      if (buf.length > remaining) {
        buf = buf.subarray(0, remaining);
        sent = max;
      } else {
        sent += buf.length;
      }
      cb(null, buf);
    },
  });
  source.on('error', (err) => limiter.destroy(err));
  limiter.on('error', () => {});
  return source.pipe(limiter);
}

/** Convenience: the first playable video inside the archive. */
export function pickVideoEntry(entries) {
  const videos = entries.filter(
    (e) => !e.isDir && /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m3u8)$/i.test(e.name),
  );
  if (!videos.length) return null;
  // Prefer the largest file — that is normally the feature presentation.
  return videos.sort((a, b) => b.size - a.size)[0];
}
