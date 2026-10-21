/**
 * Icon system.
 *
 * Every icon is a 24×24 SVG drawn with a 1.75px stroke, so they share one
 * visual weight. The markup is created with the DOM API (never innerHTML), so
 * no user data can ever reach the parser.
 */

const PATHS = {
  // playback
  play: 'M8 5.5v13l11-6.5-11-6.5z',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6 6h12v12H6z',
  skipBack: 'M11 19 3 12l8-7v14zM21 19l-8-7 8-7v14z',
  skipForward: 'M13 5l8 7-8 7V5zM3 5l8 7-8 7V5z',
  stepBack: 'M18 6v12L8 12l10-6zM6 5v14',
  stepForward: 'M6 6v12l10-6L6 6zM18 5v14',
  rewind: 'M3 12a9 9 0 1 1 3 6.7M3 12V6m0 6h6',
  fastForward: 'M21 12a9 9 0 1 1-3-6.7M21 12V6m0 6h-6',
  rotateCcw: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5',
  rotateCw: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',

  // volume
  volumeHigh: 'M11 5 6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  volumeLow: 'M11 5 6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7',
  volumeMute: 'M11 5 6 9H3v6h3l5 4V5zM22 9l-6 6M16 9l6 6',
  volumeBoost: 'M11 5 6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13M4 4l16 16',

  // media
  subtitles: 'M3 5h18v14H3zM7 15h4M13 15h4M7 11h2M12 11h5',
  closedCaptions: 'M3 5h18v14H3zM9 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3',
  pictureInPicture: 'M3 4h18v16H3zM12 13h7v5h-7z',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  fullscreenExit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  theatre: 'M3 4h18v16H3zM7 8h10v8H7z',
  picture: 'M3 4h18v16H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 16l-5-5-9 9',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2M14 4v4M8 10v4M14 16v4',
  camera: 'M4 7h3l1.5-2h7L17 7h3v12H4zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  bookmark: 'M6 3h12v18l-6-4.5L6 21V3z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M19 10h.01M7 14h10',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  share: 'M14 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM14 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.2 10.8l6.6-3.6M8.2 13.2l6.6 3.6',
  cast: 'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 15.5a3.5 3.5 0 0 0 0 3M13 15.5a3.5 3.5 0 0 1 0 3',
  tag: 'M3 12V4h8l9 9-8 8-9-9zM7.5 7.5h.01',

  // interface
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-9.5z',
  film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM17 5l3-1 4 15-3 1z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  shield: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8',
  logout: 'M9 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4M16 8l4 4-4 4M20 12H9',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'm4.5 12.5 5 5 10-11',
  chevronLeft: 'm15 6-6 6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.4 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.2 6.2A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.2-.9',
  cloud: 'M6.5 19a4.5 4.5 0 0 1-.3-9 6.5 6.5 0 0 1 12.5-1.7A4 4 0 0 1 18 19h-11.5z',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  folder: 'M3 6h6l2 2h10v11H3z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  upload: 'M12 17V5M7 10l5-5 5 5M4 20h16',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  refresh: 'M20 11a8 8 0 1 0-1.6 5.5M20 5v6h-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  key: 'M14.5 10.5a4 4 0 1 1-2.8 6.8L3 21v-4l1-1v-2l2-2h2l3.5-3.5a4 4 0 0 1 4 4zM16.5 7.5h.01',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM20 5v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5M20 12c0 1.7-3.6 3-8 3s-8-1.3-8-3',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  star: 'm12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z',
  sparkles: 'm12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2zM5 2l.6 1.5L7 4l-1.4.5L5 6l-.6-1.5L3 4l1.4-.5L5 2z',
  externalLink: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  send: 'M21 3 3 10.5l7 2.5-7 2.5L3 21l4-7.5L21 3zM7 12h8',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  smartphone: 'M7 2h10v20H7zM11 18.5h2',
  monitorPlay: 'M3 4h18v12H3zM10 8.5l4 2.5-4 2.5v-5zM8 20h8',
  castScreen: 'M2 4h20v12H2zM8 20h8M12 16v4M7 7h4M7 10h6',
};

/** Names of every available icon. */
export const ICON_NAMES = Object.keys(PATHS);

/**
 * Build an icon element.
 * @param {string} name   icon name
 * @param {object} [opts]
 * @param {number} [opts.size]   pixel size (default 20)
 * @param {string} [opts.className]
 * @param {number} [opts.strokeWidth]
 */
export function icon(name, { size = 20, className = '', strokeWidth = 1.75 } = {}) {
  const path = PATHS[name];
  if (!path && typeof console !== 'undefined') {
    // A typo in an icon name would silently render an empty box.
    console.warn(`[icons] unknown icon "${name}"`);
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  if (path) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
  }
  return svg;
}

/** Icon names for a provider type (used in the admin panel). */
export const PROVIDER_ICONS = {
  local: 'server',
  r2: 'cloud',
  gdrive: 'folder',
  mega: 'database',
  telegram: 'send',
};
