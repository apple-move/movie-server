import { api, streamUrl } from '../api.js';
import { el, clear, formatDuration, formatBytes, toast } from '../dom.js';
import { icon } from '../icons.js';
import { loadProgress, closePlayer } from '../app.js';

/**
 * Master player.
 *
 * A VLC-style player for the browser:
 *   - variable speed, frame stepping, picture-in-picture
 *   - aspect ratio, brightness/contrast filters, volume boost
 *   - subtitle tracks with font size, colour and sync offset
 *   - A–B loop, chapter markers, bookmarks
 *   - live statistics (resolution, bitrate, buffer, dropped frames)
 *   - source / quality switching, archive entry switching
 *   - snapshots straight to disk
 */

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

const SUBTITLE_STYLES = [
  { name: 'Default', size: '100%', color: '#ffffff', bg: 'rgba(0,0,0,0.62)' },
  { name: 'Large', size: '165%', color: '#ffffff', bg: 'rgba(0,0,0,0.78)' },
  { name: 'Small', size: '72%', color: '#ffffff', bg: 'rgba(0,0,0,0.5)' },
  { name: 'Amber', size: '115%', color: '#ffd166', bg: 'rgba(0,0,0,0.68)' },
  { name: 'Aqua', size: '115%', color: '#67e8f9', bg: 'rgba(0,0,0,0.68)' },
  { name: 'Rose', size: '115%', color: '#fda4af', bg: 'rgba(0,0,0,0.68)' },
];

const ASPECTS = [
  { value: 'auto', label: 'Fit to screen' },
  { value: '16:9', label: '16 : 9' },
  { value: '4:3', label: '4 : 3' },
  { value: '21:9', label: '21 : 9' },
  { value: '1:1', label: '1 : 1' },
];

const FILTERS = [
  { value: 'none', label: 'Off' },
  { value: 'bright', label: 'Brighter' },
  { value: 'dim', label: 'Dimmer' },
  { value: 'contrast', label: 'High contrast' },
  { value: 'sepia', label: 'Warm' },
];

/** Teardown hook for the open player — see app.js closePlayer(). */
let teardown = null;

/**
 * A token that identifies the current route. If the user navigates away
 * while the player is still loading, the token changes and the pending
 * player is discarded instead of opening over the new view.
 */
let routeToken = 0;

export function invalidatePlayerRoute() {
  routeToken += 1;
}

export function runPlayerTeardown() {
  if (teardown) {
    try {
      teardown();
    } catch (err) {
      console.error('Player teardown failed:', err);
    }
    teardown = null;
  }
}

/** Load the HLS player library on demand (it is only needed for HLS). */
let hlsLibraryPromise = null;
function loadHlsLibrary() {
  if (hlsLibraryPromise) return hlsLibraryPromise;
  hlsLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/hls.min.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the HLS player library'));
    document.head.append(script);
  }).catch((err) => {
    hlsLibraryPromise = null;
    throw err;
  });
  return hlsLibraryPromise;
}

export async function openPlayer(movieId, params = new URLSearchParams()) {
  runPlayerTeardown();
  closePlayer();

  const myToken = ++routeToken;

  let data;
  try {
    data = await api.get(`/api/movies/${movieId}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (myToken !== routeToken) return;

  const movie = data.movie;
  const sources = movie.sources || [];
  if (!sources.length) {
    toast('This movie has no playable source yet.', 'error');
    return;
  }

  const requestedId = Number(params.get('source'));
  let activeSource = sources.find((s) => s.id === requestedId) || sources[0];
  let activeEntry = params.get('entry') || null;

  const progress = await loadProgress(movieId).catch(() => null);
  if (myToken !== routeToken) return;
  /* ---------------------------------------------------------- markup */
  const page = el('div', { class: 'mp' });
  const video = el('video', { playsinline: '', preload: 'metadata' });
  video.className = 'mp__video';

  const stage = el('div', { class: 'mp__stage' }, video);
  page.append(stage);

  const flash = el('div', { class: 'mp__flash' });
  stage.append(flash);

  const overlay = el('div', { class: 'mp__overlay', hidden: true });
  stage.append(overlay);

  const statsPanel = el('div', { class: 'mp__stats', hidden: true });
  stage.append(statsPanel);

  const boostBadge = el('div', { class: 'mp__boost', hidden: true },
    icon('volumeBoost', { size: 13 }), '200%');
  stage.append(boostBadge);

  // A spinner while the player is buffering.
  const spinner = el('div', { class: 'mp__spinner', hidden: true },
    el('span', { class: 'mp__spinner-ring' }));
  stage.append(spinner);

  const playerToast = el('div', { class: 'mp__toast' });
  stage.append(playerToast);

  const played = el('span', { class: 'mp__played' });
  const buffered = el('span', { class: 'mp__buffered' });
  const knob = el('span', { class: 'mp__knob' });
  const loopRegion = el('div', { class: 'mp__loop' });
  const chapterMarks = el('div', { class: 'mp__chapters' });
  const hoverPreview = el('div', { class: 'mp__preview' });
  const scrub = el(
    'div',
    { class: 'mp__scrub' },
    el('div', { class: 'mp__scrub-track' }, buffered, played),
    loopRegion,
    chapterMarks,
    knob,
    hoverPreview,
  );

  /** An icon button with a tooltip. */
  const btn = (name, title, onClick, extra = {}) =>
    el(
      'button',
      { class: `mp__btn ${extra.className || ''}`, title, onClick },
      icon(name, { size: extra.size || 19 }),
    );

  const playBtn = btn('play', 'Play / pause (Space)', () => togglePlay());
  const muteBtn = btn('volumeHigh', 'Mute (M)', () => toggleMute());
  const backBtn = btn('skipBack', 'Back 10 seconds (←)', () => seekBy(-10));
  const fwdBtn = btn('skipForward', 'Forward 10 seconds (→)', () => seekBy(10));
  const frameBack = btn('stepBack', 'Frame back (,)', () => stepFrame(-1));
  const frameFwd = btn('stepForward', 'Frame forward (.)', () => stepFrame(1));
  const speedBtn = el('button', { class: 'mp__speed', title: 'Playback speed' }, '1×');
  const timeLabel = el('span', { class: 'mp__time' }, '0:00 / 0:00');
  const volumeInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '1' });
  const subBtn = btn('subtitles', 'Subtitles (C)', () => openMenu('subtitles'));
  const statsBtn = btn('chart', 'Statistics (I)', () => toggleStats());
  const loopBtn = btn('rotateCcw', 'A–B loop (L)', () => toggleLoop());
  const bookmarkBtn = btn('bookmark', 'Bookmark (B)', () => addBookmark());
  const pipBtn = btn('pictureInPicture', 'Picture in picture (P)', () => togglePip());
  const snapBtn = btn('camera', 'Snapshot (S)', () => takeSnapshot());
  const castBtn = btn('cast', 'Cast & info', () => openMenu('info'));
  const castTopBtn = btn('cast', 'Cast & info', () => openMenu('info'));
  const shareBtn = btn('share', 'Copy a share link', () => shareLink());
  const sleepBtn = btn('clock', 'Sleep timer', () => openMenu('sleep'));  const downloadBtn = btn('download', 'Download', () => {
    window.location.href = `/api/stream/${activeSource.id}/download`;
  });
  const menuBtn = btn('sliders', 'More options', () => openMenu('sources'));
  const helpBtn = btn('keyboard', 'Keyboard shortcuts (?)', () => toggleHelp());
  const fullBtn = btn('fullscreen', 'Fullscreen (F)', () => toggleFullscreen());
  const theatreBtn = btn('theatre', 'Theatre mode (T)', () => toggleTheatre());
  const prevBtn = btn('chevronLeft', 'Previous movie', () => goRelative(-1), {
    className: 'mp__btn--optional',
  });
  const nextBtn = btn('chevronRight', 'Next movie', () => goRelative(1), {
    className: 'mp__btn--optional',
  });

  const topTitle = el('strong', {}, movie.title);
  const topSub = el('span', {}, '');

  const topBar = el(
    'div',
    { class: 'mp__top' },
    el('button', { class: 'mp__back', title: 'Back (Esc)', onClick: () => leave() }, icon('chevronLeft', { size: 20 })),
    el('div', { class: 'mp__title' }, topTitle, topSub),
    el('div', { class: 'mp__top-actions' }, castTopBtn, statsBtn, theatreBtn, helpBtn),
  );

  const bottomBar = el(
    'div',
    { class: 'mp__bottom' },
    scrub,
    el(
      'div',
      { class: 'mp__row' },
      playBtn,
      frameBack,
      frameFwd,
      backBtn,
      fwdBtn,
      timeLabel,
      el('span', { class: 'mp__spacer' }),
      speedBtn,
      el('div', { class: 'mp__volume' }, muteBtn, volumeInput),
      subBtn,
      loopBtn,
      bookmarkBtn,
      pipBtn,
      snapBtn,
      sleepBtn,
      shareBtn,
      downloadBtn,
      castBtn,
      menuBtn,
      prevBtn,
      nextBtn,
      fullBtn,
    ),
  );

  const chrome = el('div', { class: 'mp__chrome' }, topBar, bottomBar);
  stage.append(chrome);

  document.body.append(page);
  document.body.style.overflow = 'hidden';

  /* ------------------------------------------------------- settings */
  const settings = {
    speed: 1,
    aspect: 'auto',
    filter: 'none',
    subtitleIndex: -1,
    subtitleStyle: SUBTITLE_STYLES[0],
    subtitleOffset: 0,
    boost: false,
    loopA: null,
    loopB: null,
    showStats: false,
    theatre: false,
    autoQuality: true,
  };

  const docListeners = [];
  const onDocument = (event, handler) => {
    document.addEventListener(event, handler);
    docListeners.push([event, handler]);
  };

  let idleTimer;
  let menuOpen = null;
  let hlsInstance = null;
  let hasResumed = false;

  function showToast(message, ms = 1600) {
    playerToast.textContent = message;
    playerToast.classList.add('is-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => playerToast.classList.remove('is-visible'), ms);
  }

  function showFlash(name) {
    clear(flash);
    flash.append(icon(name, { size: 30 }));
    flash.classList.remove('is-visible');
    void flash.offsetWidth;
    flash.classList.add('is-visible');
  }

  /* ------------------------------------------------------ source load */
  function destroyHls() {
    if (hlsInstance) {
      try {
        hlsInstance.destroy();
      } catch { /* ignore */ }
      hlsInstance = null;
    }
  }

  function sourceUrl() {
    if (activeSource.kind === 'hls') return `/api/stream/${activeSource.id}/hls`;
    if (activeSource.kind === 'zip' && activeEntry) {
      return `${streamUrl(activeSource.id)}?entry=${encodeURIComponent(activeEntry)}`;
    }
    return streamUrl(activeSource.id);
  }

  /**
   * Attach a source to the video element. HLS needs hls.js in Chrome and
   * Firefox; Safari plays it natively.
   */
  function attachSource() {
    destroyHls();
    const url = sourceUrl();

    if (activeSource.kind !== 'hls') {
      video.src = url;
      video.load();
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
      video.src = url;
      video.load();
      return;
    }

    if (typeof window.Hls === 'undefined') {
      showOverlay('cast', 'HLS not supported',
        'This browser cannot play HLS streams and the player library could not be loaded.', true);
      return;
    }

    hlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60,
    });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
    hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        hlsInstance.startLoad();
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hlsInstance.recoverMediaError();
      } else {
        destroyHls();
        showOverlay('ban', 'Playback error', 'The HLS stream could not be played.', true);
      }
    });
  }

  function loadSource(keepPosition = true) {
    const wasTime = video.currentTime;
    const wasPlaying = !video.paused && !video.ended;
    attachSource();
    topSub.textContent =
      activeSource.label ||
      activeSource.file_name ||
      (activeEntry ? `Archive: ${activeEntry}` : 'Source');
    if (keepPosition && wasTime > 0) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          if (wasTime < video.duration) video.currentTime = wasTime;
          // Keep playing across a source switch instead of dropping to paused.
          if (wasPlaying) video.play()?.catch(() => {});
        },
        { once: true },
      );
    }
  }

  /**
   * Switch to another source of the same movie.
   *
   * The source has its own info (quality variants, archive entries, HLS
   * subtitle renditions), so the info is reloaded and the menus rebuilt.
   */
  async function switchSource(source) {
    activeSource = source;
    activeEntry = null;
    subtitles = allSubtitles.filter((s) => !s.source_id || s.source_id === source.id);

    try {
      info = await api.get(`/api/stream/${source.id}/info`);
    } catch {
      info = null;
    }
    hlsSubtitles = info?.hlsSubtitles || [];

    loadSource();
    buildSubtitleTracks();
    const totalTracks = subtitles.length + hlsSubtitles.length;
    setSubtitle(settings.subtitleIndex < totalTracks ? settings.subtitleIndex : -1);
    // The menus must follow the new source.
    buildMenus();
    closeMenus();
  }

  /* --------------------------------------------------------- playback */
  function togglePlay() {
    if (video.paused) {
      video.play()?.catch(() => {});
      showFlash('play');
    } else {
      video.pause();
      showFlash('pause');
    }
  }

  function setSpeed(value) {
    settings.speed = value;
    video.playbackRate = value;
    speedBtn.textContent = `${value}×`;
    showToast(`Speed ${value}×`);
  }

  function seekBy(delta) {
    if (!video.duration) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
  }

  function stepFrame(direction) {
    seekBy(direction * 0.04);
  }

  function toggleMute() {
    video.muted = !video.muted;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else page.requestFullscreen?.();
  }

  function toggleTheatre() {
    settings.theatre = !settings.theatre;
    page.classList.toggle('mp--theatre', settings.theatre);
    theatreBtn.classList.toggle('is-active', settings.theatre);
    showToast(settings.theatre ? 'Theatre mode on' : 'Theatre mode off');
  }

  function setAspect(value) {
    settings.aspect = value;
    if (value === 'auto') {
      video.style.objectFit = 'contain';
      video.style.transform = '';
    } else {
      const [w, h] = value.split(':').map(Number);
      video.style.objectFit = 'contain';
      video.style.transform = `scale(${(w / h) / (16 / 9) || 1})`;
    }
  }

  function setFilter(value) {
    settings.filter = value;
    if (value === 'none') video.removeAttribute('data-filter');
    else video.setAttribute('data-filter', value);
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      } else {
        showToast('Picture-in-picture is not supported in this browser');
      }
    } catch {
      showToast('Picture-in-picture failed');
    }
  }

  function takeSnapshot() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1920;
      canvas.height = video.videoHeight || 1080;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = el('a', {
          href: url,
          download: `${movie.title.replace(/[^\w-]+/g, '_')}_${Math.floor(video.currentTime)}.png`,
        });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('Snapshot saved');
      }, 'image/png');
    } catch {
      showToast('Snapshot failed');
    }
  }

  /* -------------------------------------------------------- subtitles */
  const allSubtitles = movie.subtitles || [];
  let subtitles = allSubtitles.filter((s) => !s.source_id || s.source_id === activeSource.id);
  /**
   * HLS subtitle renditions advertised by the playlist.
   * Filled in once the source info has loaded (see the init section).
   */
  let hlsSubtitles = [];
  /** The <track> elements we created, so they can be addressed by reference. */
  let subtitleTrackEls = [];

  function applySubtitleStyle() {
    const style = settings.subtitleStyle;
    let cue = document.getElementById('mp-cue-style');
    if (!cue) {
      cue = document.createElement('style');
      cue.id = 'mp-cue-style';
      document.head.append(cue);
    }
    cue.textContent = `
      .mp__video::cue {
        color: ${style.color};
        background: ${style.bg};
        font-size: ${style.size};
      }
    `;
  }

  function setSubtitle(index) {
    settings.subtitleIndex = index;
    // Address OUR tracks by reference. `video.textTracks` can also contain
    // tracks that hls.js created with addTextTrack(), so indexing by
    // position would enable the wrong one.
    for (const track of subtitleTrackEls) {
      if (track.track) track.track.mode = 'disabled';
    }
    const chosen = subtitleTrackEls[index];
    if (chosen?.track) {
      chosen.track.mode = 'showing';
    }
    applySubtitleStyle();
    applySubtitleOffset();
  }

  /**
   * Apply the sync offset to the cues. The ORIGINAL times are remembered, so
   * dragging the offset slider recomputes them instead of adding the offset
   * again and again.
   */
  function applySubtitleOffset() {
    const track = subtitleTrackEls[settings.subtitleIndex]?.track;
    if (!track?.cues) return;
    const cues = [...track.cues];
    for (const cue of cues) {
      if (cue.originalStartTime === undefined) {
        cue.originalStartTime = cue.startTime;
        cue.originalEndTime = cue.endTime;
      }
    }
    for (const cue of cues) {
      const start = cue.originalStartTime + settings.subtitleOffset;
      const end = cue.originalEndTime + settings.subtitleOffset;
      try {
        cue.startTime = Math.max(0, start);
        cue.endTime = Math.max(cue.startTime + 0.1, end);
      } catch { /* not writable in every browser */ }
    }
  }

  function buildSubtitleTracks() {
    for (const track of [...video.querySelectorAll('track')]) track.remove();
    subtitleTrackEls = [];
    for (const sub of subtitles) {
      const element = el('track', {
        kind: 'subtitles',
        srclang: sub.language,
        label: sub.label || sub.language,
        src: `/api/stream/${activeSource.id}/subtitle/${sub.id}`,
      });
      subtitleTrackEls.push(element);
      video.append(element);
    }
    // HLS playlists can advertise their own subtitle renditions.
    for (const sub of hlsSubtitles) {
      const element = el('track', {
        kind: 'subtitles',
        srclang: sub.language || 'und',
        label: sub.name || 'Subtitles',
        src: `/api/stream/${activeSource.id}/hls?path=${encodeURIComponent(sub.path)}`,
      });
      subtitleTrackEls.push(element);
      video.append(element);
    }
  }

  /* ------------------------------------------------------------ menus */
  function closeMenus() {
    for (const menu of page.querySelectorAll('.mp__menu')) menu.hidden = true;
    menuOpen = null;
  }

  function openMenu(name) {
    if (menuOpen === name) {
      closeMenus();
      return;
    }
    closeMenus();
    const menu = page.querySelector(`[data-menu="${name}"]`);
    if (!menu) return;
    menu.hidden = false;
    menuOpen = name;
    // Position-dependent labels are refreshed when the menu opens.
    refreshBookmarkLabel?.();
  }

  function menuButton(label, value, onClick, active = false) {
    return el(
      'button',
      { class: active ? 'is-active' : '', onClick },
      el('span', {}, label),
      value ? el('small', {}, value) : null,
    );
  }

  function menuSection(title) {
    return el('div', { class: 'mp__menu-title' }, title);
  }

  function buildMenus() {
    // Rebuilding must not leave the previous menus behind.
    for (const old of page.querySelectorAll('.mp__menu')) old.remove();
    menuOpen = null;

    const menu = (name) => el('div', { class: 'mp__menu', 'data-menu': name, hidden: true });

    /* ------------------------------------------------- sources & quality */
    const sourceMenu = menu('sources');
    sourceMenu.append(menuSection('Sources'));
    for (const source of sources) {
      sourceMenu.append(
        menuButton(
          source.label || source.file_name || `Source ${source.id}`,
          formatBytes(source.size),
          () => {
            activeSource = source;
            activeEntry = null;
            subtitles = allSubtitles.filter((s) => !s.source_id || s.source_id === source.id);
            switchSource(source);
          },
          source.id === activeSource.id,
        ),
      );
    }

    if (activeSource.kind === 'zip' && info?.archive?.entries?.length) {
      sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
      sourceMenu.append(menuSection('Inside the archive'));
      for (const entry of info.archive.entries) {
        sourceMenu.append(
          menuButton(
            entry.name,
            formatBytes(entry.size),
            () => {
              activeEntry = entry.name;
              loadSource();
              closeMenus();
            },
            entry.name === activeEntry,
          ),
        );
      }
    }

    if (info?.variants?.length) {
      sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
      sourceMenu.append(menuSection('Quality'));
      for (const variant of info.variants) {
        sourceMenu.append(
          menuButton(
            variant.resolution || 'Variant',
            variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : '',
            () => {
              showToast('Switching quality…');
              closeMenus();
            },
          ),
        );
      }
    }

    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(
      menuButton('Download this file', '', () => {
        window.location.href = `/api/stream/${activeSource.id}/download`;
        closeMenus();
      }),
    );
    sourceMenu.append(
      menuButton('Sleep timer', '', () => openMenu('sleep')),
    );
    sourceMenu.append(
      menuButton('Audio track', '', () => openMenu('audio-tracks')),
    );

    /* ------------------------------------------------------------ speed */
    const speedMenu = menu('speed');
    speedMenu.append(menuSection('Playback speed'));
    for (const speed of SPEEDS) {
      speedMenu.append(
        menuButton(
          `${speed}×`,
          speed === 1 ? 'Normal' : '',
          () => {
            setSpeed(speed);
            closeMenus();
          },
          settings.speed === speed,
        ),
      );
    }

    /* ------------------------------------------------------- subtitles */
    const subMenu = menu('subtitles');
    subMenu.append(menuSection('Subtitles'));
    const allTracks = [
      ...subtitles.map((s) => ({ label: s.label || s.language, code: s.language })),
      ...hlsSubtitles.map((s) => ({ label: s.name, code: s.language })),
    ];
    if (!allTracks.length) {
      subMenu.append(el('div', { class: 'mp__menu-title' }, 'No subtitles for this source'));
    } else {
      subMenu.append(
        menuButton('Off', '', () => {
          setSubtitle(-1);
          closeMenus();
        }, settings.subtitleIndex === -1),
      );
      allTracks.forEach((sub, i) => {
        subMenu.append(
          menuButton(
            sub.label,
            String(sub.code || '').toUpperCase(),
            () => {
              setSubtitle(i);
              closeMenus();
            },
            settings.subtitleIndex === i,
          ),
        );
      });
      subMenu.append(el('div', { class: 'mp__menu-sep' }));
      subMenu.append(menuSection('Style'));
      for (const style of SUBTITLE_STYLES) {
        subMenu.append(
          menuButton(
            style.name,
            style.size,
            () => {
              settings.subtitleStyle = style;
              applySubtitleStyle();
              closeMenus();
            },
            settings.subtitleStyle.name === style.name,
          ),
        );
      }
      subMenu.append(el('div', { class: 'mp__menu-sep' }));
      const offsetWrap = el('div', { class: 'mp__menu-range' });
      const offsetValue = el('span', {}, `${settings.subtitleOffset.toFixed(1)}s`);
      const offsetInput = el('input', {
        type: 'range', min: '-10', max: '10', step: '0.1', value: String(settings.subtitleOffset),
      });
      offsetInput.addEventListener('input', () => {
        settings.subtitleOffset = Number(offsetInput.value);
        offsetValue.textContent = `${settings.subtitleOffset.toFixed(1)}s`;
        applySubtitleOffset();
      });
      offsetWrap.append(el('label', {}, el('span', {}, 'Sync offset'), offsetValue), offsetInput);
      subMenu.append(offsetWrap);
    }

    /* ---------------------------------------------------------- video */
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(menuSection('Aspect ratio'));
    for (const aspect of ASPECTS) {
      sourceMenu.append(
        menuButton(
          aspect.label,
          aspect.value === 'auto' ? '' : aspect.value,
          () => {
            setAspect(aspect.value);
            closeMenus();
          },
          settings.aspect === aspect.value,
        ),
      );
    }
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(menuSection('Picture filter'));
    for (const filter of FILTERS) {
      sourceMenu.append(
        menuButton(
          filter.label,
          '',
          () => {
            setFilter(filter.value);
            closeMenus();
          },
          settings.filter === filter.value,
        ),
      );
    }
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(
      menuButton('Theatre mode', '', () => {
        toggleTheatre();
        closeMenus();
      }, settings.theatre),
    );

    /* ----------------------------------------------------------- audio */
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(menuSection('Volume'));
    const volWrap = el('div', { class: 'mp__menu-range' });
    const volValue = el('span', {}, `${Math.round(video.volume * 100)}%`);
    const volSlider = el('input', {
      type: 'range', min: '0', max: '1', step: '0.01', value: String(video.volume),
    });
    volSlider.addEventListener('input', () => {
      video.volume = Number(volSlider.value);
      volValue.textContent = `${Math.round(video.volume * 100)}%`;
    });
    volWrap.append(el('label', {}, el('span', {}, 'Volume'), volValue), volSlider);
    sourceMenu.append(volWrap);
    sourceMenu.append(
      menuButton('Volume boost (200%)', settings.boost ? 'On' : 'Off', async () => {
        const wanted = !settings.boost;
        const applied = await setVolumeBoost(wanted);
        if (applied) showToast(settings.boost ? 'Volume boost on (200%)' : 'Volume boost off');
        closeMenus();
      }, settings.boost),
    );
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(
      menuButton('Auto quality', settings.autoQuality ? 'On' : 'Off', () => {
        settings.autoQuality = !settings.autoQuality;
        showToast(settings.autoQuality ? 'Auto quality on' : 'Auto quality off');
        closeMenus();
      }, settings.autoQuality),
    );

    /* ------------------------------------------------------- chapters */
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(menuSection('Chapters'));
    if (!chapters.length) {
      sourceMenu.append(el('div', { class: 'mp__menu-title' }, 'No chapters found'));
    } else {
      for (const chapter of chapters) {
        sourceMenu.append(
          menuButton(
            chapter.title,
            formatDuration(chapter.start),
            () => {
              video.currentTime = chapter.start;
              closeMenus();
            },
          ),
        );
      }
    }

    /* ------------------------------------------------------- bookmarks */
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    sourceMenu.append(menuSection('Bookmarks'));
    const bookmarkList = el('div', { class: 'mp__bookmarks' });
    sourceMenu.append(bookmarkList);
    const renderBookmarks = (items) => {
      clear(bookmarkList);
      if (!items.length) {
        bookmarkList.append(el('div', { class: 'mp__menu-title' }, 'No bookmarks yet — press B'));
        return;
      }
      for (const item of items) {
        bookmarkList.append(
          el(
            'div',
            { style: { display: 'flex', alignItems: 'center' } },
            el(
              'button',
              {
                class: 'mp__bookmark',
                onClick: () => {
                  video.currentTime = item.position;
                  closeMenus();
                },
              },
              el('time', {}, formatDuration(item.position)),
              el('span', {}, item.label || 'Bookmark'),
            ),
            el(
              'button',
              {
                class: 'mp__btn mp__bookmark-del',
                title: 'Delete',
                onClick: async (e) => {
                  e.stopPropagation();
                  await api.del(`/api/movies/${movieId}/bookmarks/${item.id}`).catch(() => {});
                  bookmarks = bookmarks.filter((b) => b.id !== item.id);
                  renderBookmarks(bookmarks);
                },
              },
              icon('trash', { size: 14 }),
            ),
          ),
        );
      }
    };
    // Expose the renderer so the toolbar button and the B key can refresh it.
    refreshBookmarks = renderBookmarks;
    renderBookmarks(bookmarks);
    sourceMenu.append(el('div', { class: 'mp__menu-sep' }));
    const addBookmarkBtn = menuButton('Add bookmark here', formatDuration(video.currentTime || 0), async () => {
      await addBookmark();
      closeMenus();
    });
    // The label shows the current position, so it has to be refreshed each
    // time the menu opens — otherwise it stays at 0:00.
    refreshBookmarkLabel = () => {
      const small = addBookmarkBtn.querySelector('small');
      if (small) small.textContent = formatDuration(video.currentTime || 0);
    };
    sourceMenu.append(addBookmarkBtn);

    /* ------------------------------------------------------------ info */
    const infoMenu = menu('info');
    infoMenu.append(menuSection('About this movie'));
    const infoRows = [
      ['Title', movie.title],
      ['Year', movie.year || '—'],
      ['Runtime', movie.runtime ? `${movie.runtime} min` : '—'],
      ['Rating', movie.rating ? `${Number(movie.rating).toFixed(1)} / 10` : '—'],
      ['Genres', (movie.genres || []).join(', ') || '—'],
      ['Source', activeSource.label || activeSource.file_name || '—'],
      ['Size', formatBytes(activeSource.size || 0)],
      ['Format', (activeSource.mime || '—').replace('video/', '').toUpperCase()],
    ];
    for (const [key, value] of infoRows) {
      infoMenu.append(
        el('div', { class: 'mp__info-row' }, el('span', {}, key), el('b', {}, String(value))),
      );
    }
    if (movie.cast?.length) {
      infoMenu.append(el('div', { class: 'mp__menu-sep' }));
      infoMenu.append(menuSection('Cast'));
      for (const person of movie.cast.slice(0, 8)) {
        infoMenu.append(
          el('div', { class: 'mp__info-row' }, el('span', {}, person.name), el('small', {}, person.character || '')),
        );
      }
    }

    if (movie.keywords?.length) {
      infoMenu.append(el('div', { class: 'mp__menu-sep' }));
      infoMenu.append(menuSection('Keywords'));
      infoMenu.append(
        el('div', { class: 'mp__keywords' },
          movie.keywords.slice(0, 10).map((k) => el('span', { class: 'mp__keyword' }, k)),
        ),
      );
    }

    if (movie.trailer_url) {
      infoMenu.append(el('div', { class: 'mp__menu-sep' }));
      infoMenu.append(
        el('a', {
          class: 'mp__menu-link',
          href: movie.trailer_url,
          target: '_blank',
          rel: 'noopener',
        }, icon('externalLink', { size: 14 }), 'Watch the trailer'),
      );
    }

    /* ------------------------------------------------------- sleep timer */
    const sleepMenu = menu('sleep');
    sleepMenu.append(menuSection('Sleep timer'));
    for (const minutes of [5, 10, 15, 30, 45, 60]) {
      sleepMenu.append(
        menuButton(`${minutes} minutes`, '', () => {
          setSleepTimer(minutes);
          closeMenus();
        }),
      );
    }
    sleepMenu.append(el('div', { class: 'mp__menu-sep' }));
    sleepMenu.append(
      menuButton('Off', '', () => {
        setSleepTimer(0);
        closeMenus();
      }),
    );

    /* ------------------------------------------------------- audio tracks */
    const audioTrackMenu = menu('audio-tracks');
    audioTrackMenu.append(menuSection('Audio track'));
    const tracks = audioTracks();
    if (!tracks.length) {
      audioTrackMenu.append(el('div', { class: 'mp__menu-title' }, 'Only one audio track'));
    } else {
      for (const track of tracks) {
        audioTrackMenu.append(
          menuButton(
            track.label,
            '',
            () => {
              try {
                video.audioTracks[track.index].enabled = true;
              } catch { /* not supported */ }
              closeMenus();
            },
            video.audioTracks?.[track.index]?.enabled === true,
          ),
        );
      }
    }

    for (const m of [
      sourceMenu, speedMenu, subMenu, infoMenu, sleepMenu, audioTrackMenu,
    ]) {
      stage.append(m);
    }
  }

  /* --------------------------------------------------------- extras */
  /**
   * Volume boost.
   *
   * The browser caps `video.volume` at 1.0, so a 200% boost needs a Web
   * Audio gain node. The graph is created lazily — some browsers refuse to
   * start an AudioContext before a user gesture.
   */
  let audioCtx = null;
  let gainNode = null;
  let audioSource = null;

  async function ensureAudioGraph() {
    if (audioCtx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      audioCtx = new Ctx();
      audioSource = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      gainNode.gain.value = settings.boost ? 2 : 1;
      audioSource.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      return true;
    } catch (err) {
      console.warn('[player] volume boost unavailable:', err.message);
      audioCtx = null;
      gainNode = null;
      return false;
    }
  }

  async function setVolumeBoost(enabled) {
    settings.boost = enabled;
    boostBadge.hidden = !enabled;
    if (!enabled) {
      if (gainNode) gainNode.gain.value = 1;
      return true;
    }
    const ok = await ensureAudioGraph();
    if (!ok) {
      settings.boost = false;
      boostBadge.hidden = true;
      showToast('Volume boost is not supported in this browser');
      return false;
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    gainNode.gain.value = 2;
    return true;
  }

  /** Sleep timer: pause the video after N minutes. */
  let sleepTimer = null;
  function setSleepTimer(minutes) {
    clearInterval(sleepTimer);
    sleepTimer = null;
    if (!minutes) {
      showToast('Sleep timer off');
      return;
    }
    showToast(`Sleep timer set for ${minutes} minutes`);
    const endAt = Date.now() + minutes * 60_000;
    sleepTimer = setInterval(() => {
      if (Date.now() >= endAt) {
        clearInterval(sleepTimer);
        sleepTimer = null;
        video.pause();
        showToast('Sleep timer reached — playback paused');
      }
    }, 1000);
  }

  /** Copy a link back to this movie. */
  async function shareLink() {
    const url = `${location.origin}/#/watch/${movieId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to the clipboard');
    } catch {
      // Clipboard access can be blocked — fall back to selecting the URL.
      window.prompt('Copy this link:', url);
    }
  }

  /** Jump to the previous or next movie in the library. */
  async function goRelative(direction) {
    try {
      const list = await api.get('/api/movies?limit=500&sort=title');
      const movies = list.movies || [];
      const index = movies.findIndex((m) => m.id === movieId);
      if (index === -1) return showToast('No other movies to jump to');
      const next = movies[index + direction];
      if (!next) return showToast(direction > 0 ? 'This is the last movie' : 'This is the first movie');
      location.hash = `#/watch/${next.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /** Audio tracks exposed by the browser (usually only the default one). */
  function audioTracks() {
    const tracks = video.audioTracks || [];
    const out = [];
    for (let i = 0; i < tracks.length; i++) {
      out.push({ index: i, label: tracks[i].label || tracks[i].language || `Track ${i + 1}` });
    }
    return out;
  }

  /* --------------------------------------------------------- chapters */
  const chapters = [];
  async function loadChapters() {
    try {
      const track = [...(video.textTracks || [])].find((t) => t.kind === 'chapters');
      if (track?.cues) {
        chapters.length = 0;
        for (const cue of track.cues) chapters.push({ start: cue.startTime, title: cue.text });
        renderChapterMarks();
      }
    } catch { /* not supported */ }
  }

  function renderChapterMarks() {
    clear(chapterMarks);
    if (!video.duration) return;
    for (const chapter of chapters) {
      chapterMarks.append(
        el('div', {
          class: 'mp__chapter',
          style: { left: `${(chapter.start / video.duration) * 100}%` },
          title: chapter.title,
        }),
      );
    }
  }

  /* --------------------------------------------------------- bookmarks */
  let bookmarks = [];
  /** Re-renders the bookmark list in the menu (set once the menu exists). */
  let refreshBookmarks = null;
  /** Updates the "Add bookmark here" position label. */
  let refreshBookmarkLabel = null;

  async function loadBookmarks() {
    try {
      const data = await api.get(`/api/movies/${movieId}/bookmarks`);
      bookmarks = data.bookmarks || [];
    } catch {
      bookmarks = [];
    }
    return bookmarks;
  }

  async function addBookmark() {
    try {
      await api.post(`/api/movies/${movieId}/bookmarks`, {
        position: video.currentTime,
        sourceId: activeSource.id,
        label: `At ${formatDuration(video.currentTime)}`,
      });
      bookmarks = await loadBookmarks();
      // The menu has to be refreshed too, otherwise it keeps claiming there
      // are no bookmarks.
      refreshBookmarks?.(bookmarks);
      showToast('Bookmark added');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------------------------------------ stats */
  let statsTimer;
  function updateStats() {
    if (!settings.showStats) return;
    const quality = video.getVideoPlaybackQuality?.();
    const bufferedAhead =
      video.buffered.length > 0
        ? video.buffered.end(video.buffered.length - 1) - video.currentTime
        : 0;
    const rows = [
      ['Resolution', `${video.videoWidth}×${video.videoHeight}`],
      ['Buffer', `${bufferedAhead.toFixed(1)}s`],
      ['Speed', `${video.playbackRate}×`],
      ['Dropped', String(quality?.droppedVideoFrames ?? 0)],
      ['Volume', `${Math.round(video.volume * 100)}%`],
    ];
    if (settings.aspect !== 'auto') rows.push(['Aspect', settings.aspect]);
    if (settings.filter !== 'none') rows.push(['Filter', settings.filter]);
    if (settings.subtitleOffset) rows.push(['Sub sync', `${settings.subtitleOffset.toFixed(1)}s`]);
    if (settings.loopA !== null) {
      rows.push(['Loop', `${formatDuration(settings.loopA)}–${formatDuration(settings.loopB)}`]);
    }
    clear(statsPanel);
    for (const [key, value] of rows) {
      statsPanel.append(el('div', { class: 'row' }, el('span', {}, key), el('b', {}, value)));
    }
  }

  function toggleStats() {
    settings.showStats = !settings.showStats;
    statsPanel.hidden = !settings.showStats;
    statsBtn.classList.toggle('is-active', settings.showStats);
    updateStats();
  }

  /* ------------------------------------------------------------- loop */
  function toggleLoop() {
    if (settings.loopA === null) {
      settings.loopA = video.currentTime;
      showToast(`Loop start at ${formatDuration(settings.loopA)}`);
      loopRegion.style.display = 'block';
      updateLoopRegion();
    } else if (settings.loopB === null) {
      settings.loopB = Math.max(video.currentTime, settings.loopA + 1);
      showToast(`Loop end at ${formatDuration(settings.loopB)}`);
      loopRegion.style.display = 'block';
      loopBtn.classList.add('is-active');
      updateLoopRegion();
    } else {
      settings.loopA = null;
      settings.loopB = null;
      loopRegion.style.display = 'none';
      loopBtn.classList.remove('is-active');
      showToast('Loop cleared');
    }
  }

  function updateLoopRegion() {
    if (settings.loopA === null || !video.duration) return;
    const left = (settings.loopA / video.duration) * 100;
    const width = ((settings.loopB - settings.loopA) / video.duration) * 100;
    loopRegion.style.left = `${left}%`;
    loopRegion.style.width = `${Math.max(0, width)}%`;
  }

  /* --------------------------------------------------------- controls */
  // The buttons were already wired when they were created with btn(), so
  // they must NOT be wired a second time here — a double listener would
  // toggle every action twice (and cancel it out).
  speedBtn.addEventListener('click', () => openMenu('speed'));
  volumeInput.addEventListener('input', () => {
    video.volume = Number(volumeInput.value);
    video.muted = video.volume === 0;
  });

  /* ---------------------------------------------------------- keyboard */
  function onKey(e) {
    if (!document.body.contains(page)) {
      leave();
      return;
    }
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

    switch (e.key) {
      case 'Escape':
        if (menuOpen) closeMenus();
        else if (!helpPanel.hidden) helpPanel.hidden = true;
        else leave();
        break;
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); seekBy(10); break;
      case 'ArrowLeft': e.preventDefault(); seekBy(-10); break;
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
      case 'f': toggleFullscreen(); break;
      case 'm': toggleMute(); break;
      case 't': toggleTheatre(); break;
      case 'l': toggleLoop(); break;
      case 'b': addBookmark(); break;
      case 'p': togglePip(); break;
      case 'i': toggleStats(); break;
      case 's': takeSnapshot(); break;
      case 'c': openMenu('subtitles'); break;
      case ',': stepFrame(-1); break;
      case '.': stepFrame(1); break;
      case '+': case '=': {
        const i = SPEEDS.indexOf(settings.speed);
        if (i >= 0 && i < SPEEDS.length - 1) setSpeed(SPEEDS[i + 1]);
        break;
      }
      case '-': {
        const i = SPEEDS.indexOf(settings.speed);
        if (i > 0) setSpeed(SPEEDS[i - 1]);
        break;
      }
      case '?': case '/': toggleHelp(); break;
      default: break;
    }
  }
  onDocument('keydown', onKey);

  /* ------------------------------------------------------------- help */
  const helpPanel = el('div', { class: 'mp__help', hidden: true });
  helpPanel.append(el('h3', {}, 'Keyboard shortcuts'));
  const helpGrid = el('div', { class: 'mp__help-grid' });
  const shortcuts = [
    ['Play / pause', 'Space or K'],
    ['Seek ±10 seconds', '← / →'],
    ['Volume', '↑ / ↓'],
    ['Mute', 'M'],
    ['Fullscreen', 'F'],
    ['Theatre mode', 'T'],
    ['Frame step', ', / .'],
    ['Speed up / down', '+ / -'],
    ['A–B loop', 'L'],
    ['Bookmark', 'B'],
    ['Picture in picture', 'P'],
    ['Statistics', 'I'],
    ['Snapshot', 'S'],
    ['Subtitles', 'C'],
    ['Close', 'Esc'],
  ];
  for (const [label, keys] of shortcuts) {
    helpGrid.append(el('div', {}, el('span', {}, label), el('kbd', {}, keys)));
  }
  helpPanel.append(helpGrid);
  helpPanel.append(
    el('button', { class: 'btn btn--soft', style: { marginTop: '24px' }, onClick: () => { helpPanel.hidden = true; } }, 'Close'),
  );
  stage.append(helpPanel);

  function toggleHelp() {
    helpPanel.hidden = !helpPanel.hidden;
  }

  /* --------------------------------------------------------- scrubbing */
  let scrubbing = false;
  function seekFromEvent(e) {
    const rect = scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = ratio * video.duration;
  }
  scrub.addEventListener('mousedown', (e) => {
    e.preventDefault();
    scrubbing = true;
    seekFromEvent(e);
  });
  onDocument('mousemove', (e) => {
    if (scrubbing) seekFromEvent(e);
  });
  onDocument('mouseup', () => { scrubbing = false; });

  // Hover preview on the scrub bar.
  scrub.addEventListener('mousemove', (e) => {
    if (!video.duration) return;
    const rect = scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    hoverPreview.textContent = formatDuration(ratio * video.duration);
    hoverPreview.style.left = `${ratio * 100}%`;
    hoverPreview.classList.add('is-visible');
  });
  scrub.addEventListener('mouseleave', () => hoverPreview.classList.remove('is-visible'));

  /* --------------------------------------------------------- idle mode */
  function wake() {
    page.classList.remove('mp--idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !menuOpen) page.classList.add('mp--idle');
    }, 2800);
  }
  stage.addEventListener('mousemove', wake);
  stage.addEventListener('click', (e) => {
    if (e.target === video) togglePlay();
  });

  /* ------------------------------------------------------ video events */
  video.addEventListener('play', () => {
    playBtn.replaceChildren(icon('pause', { size: 19 }));
    wake();
  });
  video.addEventListener('pause', () => {
    playBtn.replaceChildren(icon('play', { size: 19 }));
    page.classList.remove('mp--idle');
  });
  video.addEventListener('volumechange', () => {
    const silent = video.muted || video.volume === 0;
    muteBtn.replaceChildren(icon(silent ? 'volumeMute' : 'volumeHigh', { size: 19 }));
    volumeInput.value = String(video.muted ? 0 : video.volume);
  });
  video.addEventListener('loadedmetadata', () => {
    renderChapterMarks();
    loadChapters();
    // The resume position is applied once, on the first load. After a source
    // switch the saved position must not override the current one.
    if (!hasResumed) {
      hasResumed = true;
      if (progress && progress.position_sec > 10 &&
          progress.position_sec < (video.duration || 0) - 30) {
        video.currentTime = progress.position_sec;
        showToast(`Resumed at ${formatDuration(progress.position_sec)}`);
      }
    }
  });
  video.addEventListener('timeupdate', () => {
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    const pct = duration ? (current / duration) * 100 : 0;
    played.style.width = `${pct}%`;
    knob.style.left = `${pct}%`;
    timeLabel.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
    updateLoopRegion();

    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      buffered.style.width = `${duration ? (end / duration) * 100 : 0}%`;
    }

    if (settings.loopA !== null && settings.loopB !== null && current >= settings.loopB) {
      video.currentTime = settings.loopA;
    }
  });
  video.addEventListener('error', () => {
    const code = video.error?.code;
    const messages = {
      1: 'Playback was aborted.',
      2: 'Network error while loading the video.',
      3: 'The file could not be decoded.',
      4: 'This container/codec is not supported by your browser. MP4 (H.264) and WebM work best — remux it from the Admin panel or use the download button.',
    };
    showOverlay('ban', 'Playback error', messages[code] || 'Unknown playback error.', true);
  });
  video.addEventListener('waiting', () => {
    spinner.hidden = false;
    if (!video.paused) showOverlay('activity', 'Buffering', 'Fetching data from the storage provider.', false);
  });
  video.addEventListener('playing', () => {
    spinner.hidden = true;
    hideOverlay();
  });
  video.addEventListener('canplay', () => { spinner.hidden = true; });
  video.addEventListener('seeking', () => { spinner.hidden = false; });
  video.addEventListener('seeked', () => { spinner.hidden = true; });

  function showOverlay(iconName, title, message, permanent) {
    clear(overlay);
    overlay.append(
      el(
        'div',
        { class: 'mp__overlay-inner' },
        el('div', { class: 'mp__overlay-icon' }, icon(iconName, { size: 44 })),
        el('h2', {}, title),
        el('p', {}, message),
        permanent
          ? el('button', {
              class: 'btn btn--soft',
              onClick: () => { window.location.href = `/api/stream/${activeSource.id}/download`; },
            }, icon('download', { size: 15 }), 'Download instead')
          : null,
      ),
    );
    overlay.hidden = false;
    overlay.dataset.permanent = permanent ? '1' : '';
  }
  function hideOverlay() {
    if (overlay.dataset.permanent === '1') return;
    overlay.hidden = true;
  }

  /* ----------------------------------------------------- progress save */
  let lastSavedAt = 0;
  const SAVE_INTERVAL = 4000;

  function writeProgress() {
    if (!video.duration || !Number.isFinite(video.currentTime)) return;
    api.post(`/api/movies/${movieId}/progress`, {
      position: video.currentTime,
      duration: video.duration,
      sourceId: activeSource.id,
    }).catch(() => {});
  }

  function saveProgress() {
    const now = Date.now();
    if (now - lastSavedAt < SAVE_INTERVAL) return;
    lastSavedAt = now;
    writeProgress();
  }

  video.addEventListener('timeupdate', saveProgress);
  video.addEventListener('pause', writeProgress);
  video.addEventListener('ended', writeProgress);
  onDocument('pagehide', writeProgress);

  /* -------------------------------------------------------------- init */
  let info = null;
  try {
    info = await api.get(`/api/stream/${activeSource.id}/info`);
  } catch { /* the source may still work without the info */ }
  // The user navigated away while the info was loading — release everything
  // this player registered, otherwise the listeners leak into the next one.
  if (myToken !== routeToken) {
    leave();
    return;
  }

  // hls.js is only fetched when an HLS stream is actually played.
  if (activeSource.kind === 'hls' && typeof window.Hls === 'undefined') {
    await loadHlsLibrary().catch(() => {});
    if (myToken !== routeToken) {
      leave();
      return;
    }
  }

  // Bookmarks have to be loaded BEFORE the menus are built, otherwise the
  // bookmark list is rendered empty.
  await loadBookmarks();

  // The source info may advertise HLS subtitle renditions.
  hlsSubtitles = info?.hlsSubtitles || [];

  buildMenus();
  loadSource(false);
  buildSubtitleTracks();
  if (subtitles.length) setSubtitle(0);
  else setSubtitle(-1);
  setSpeed(1);
  setAspect('auto');
  applySubtitleStyle();

  statsTimer = setInterval(updateStats, 500);

  video.play()?.catch(() => {
    // Autoplay may be blocked; the user can press play.
  });
  wake();

  function leave() {
    releaseResources();
    teardown = null;
    // Remove THIS player's element only — closePlayer() would remove
    // whichever player happens to be open, which could be a newer one.
    page.remove();
    document.body.style.overflow = '';
    // The player is an overlay — the URL must not keep pointing at it, or a
    // reload would re-open it. Only do this when the URL still points at
    // THIS movie, so a newer navigation is never clobbered.
    const hashMovieId = Number((location.hash.match(/^#\/watch\/(\d+)/) || [])[1]);
    if (Number.isFinite(hashMovieId) && hashMovieId === movieId) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    }
  }

  /**
   * Release every timer, interval and listener this player registered.
   * Called both when the player closes and when it is abandoned mid-load.
   */
  function releaseResources() {
    for (const [event, handler] of docListeners) {
      document.removeEventListener(event, handler);
    }
    docListeners.length = 0;
    clearInterval(statsTimer);
    clearInterval(sleepTimer);
    sleepTimer = null;
    clearTimeout(idleTimer);
    clearTimeout(showToast._t);
    destroyHls();
    // Release the Web Audio graph used for the volume boost.
    if (audioSource) {
      try { audioSource.disconnect(); } catch { /* ignore */ }
      audioSource = null;
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch { /* ignore */ }
      gainNode = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch { /* ignore */ }
      audioCtx = null;
    }
  }

  teardown = leave;
}
