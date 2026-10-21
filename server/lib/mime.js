/**
 * Tiny MIME lookup for common media types — avoids pulling in a dependency.
 */
const TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m3u8: 'application/vnd.apple.mpegurl',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',

  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  sub: 'text/plain',

  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',

  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  json: 'application/json',
};

export function mimeFromName(name = '') {
  const clean = String(name).split('?')[0];
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  return TYPES[ext] || 'application/octet-stream';
}

export function isVideoName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm3u8', 'ogv', '3gp'].includes(ext);
}

export function isSubtitleName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return ['srt', 'vtt', 'ass', 'ssa', 'sub'].includes(ext);
}

export function isImageName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext);
}

/** Archive containers that may hold a movie inside. */
export function isArchiveName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return ['zip', 'rar', '7z'].includes(ext);
}

/** HLS playlists. */
export function isPlaylistName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return ext === 'm3u8' || ext === 'm3u';
}

/** Human readable size, e.g. 1.4 GB */
export function humanSize(bytes = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
