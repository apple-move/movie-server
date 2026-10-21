import {  Transform } from 'node:stream';

/**
 * Parse an HTTP `Range` header against a known resource size.
 * Returns:
 *   null      -> no range requested (send 200 with the whole body)
 *   { invalid: true } -> malformed or unsatisfiable range (send 416)
 *   { start, end }     -> inclusive byte range
 */
export function parseRange(header, size) {
  if (!header) return null;
  if (!Number.isFinite(size) || size <= 0) {
    // Nothing to range over — any range request is unsatisfiable.
    return { invalid: true };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };

  let start;
  let end;

  if (rawStart === '') {
    // Suffix range: "bytes=-500" means the last 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (start > end) return { invalid: true };
    if (start >= size) return { invalid: true };
    if (end >= size) end = size - 1;
  }

  if (start > end || start < 0) return { invalid: true };

  return { start, end };
}

/**
 * Build the standard `Content-Range` response header value.
 */
export function contentRange(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}

/**
 * Limit a stream to at most `maxBytes`.
 *
 * Providers that ignore the Range header return the whole file with a 200
 * status. Piping through this guarantees the client receives exactly the
 * byte window it asked for, so the response stays a consistent 206.
 */
export function limitStream(source, maxBytes) {
  if (!Number.isFinite(maxBytes)) return source;
  let sent = 0;

  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      const remaining = maxBytes - sent;
      if (remaining <= 0) {
        cb();
        return;
      }
      let buf = chunk;
      if (buf.length > remaining) {
        buf = buf.subarray(0, remaining);
        sent = maxBytes;
      } else {
        sent += buf.length;
      }
      cb(null, buf);
    },
    flush(cb) {
      source.destroy?.();
      cb();
    },
  });

  source.on('error', (err) => limiter.destroy(err));
  // The consumer attaches its own error handler; this keeps a destroy(err)
  // from turning into an unhandled 'error' event on the limiter itself.
  limiter.on('error', () => {});
  return source.pipe(limiter);
}
