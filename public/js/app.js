import { api, setToken, getToken } from './api.js';
import { $$, el, clear, toast, formatBytes } from './dom.js';
import { icon } from './icons.js';
import { renderHome } from './views/home.js';
import { renderLibrary } from './views/library.js';
import { renderContinue } from './views/continue.js';
import { renderAdmin } from './views/admin.js';
import { renderAccount } from './views/account.js';
import { renderLogin } from './views/login.js';
import { openMovie } from './views/detail.js';
import { openPlayer, runPlayerTeardown, invalidatePlayerRoute } from './views/player.js';

export const state = {
  user: null,
  movies: [],
  genres: [],
  providers: [],
  progress: new Map(),
};

const view = () => document.getElementById('view');

/** Fill the static shell with icons (the markup lives in index.html). */
function paintShellIcons() {
  const mark = document.getElementById('brand-mark');
  if (mark) mark.append(icon('play', { size: 17 }));

  const searchIcon = document.getElementById('search-icon');
  if (searchIcon) searchIcon.append(icon('search', { size: 16 }));

  const navIcons = {
    home: 'home',
    library: 'grid',
    continue: 'clock',
    admin: 'sliders',
  };
  for (const link of document.querySelectorAll('#nav a')) {
    const name = navIcons[link.dataset.nav];
    if (!name) continue;
    link.prepend(icon(name, { size: 15 }));
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  applyTheme();
  paintShellIcons();
  bindGlobalEvents();
  // Register the listener before awaiting anything, so a hash change that
  // happens during session restore is not missed.
  window.addEventListener('hashchange', () => {
    onRoute().catch((err) => {
      console.error(err);
      toast(err.message, 'error');
    });
  });
  await refreshSession();
  await onRoute();
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  const root = document.getElementById('view');
  if (root) {
    clear(root);
    root.append(
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'empty__icon' }, icon('ban', { size: 32 })),
        el('h2', {}, 'Could not start the app'),
        el('p', {}, String(err?.message || err)),
      ),
    );
  }
});

async function refreshSession() {
  if (!getToken()) {
    state.user = null;
  } else {
    try {
      const data = await api.get('/api/auth/me');
      state.user = data.user;
    } catch {
      setToken(null);
      state.user = null;
    }
  }
  renderUserBox();
  renderNav();
}

function renderUserBox() {
  const box = document.getElementById('userbox');
  if (!box) return;
  clear(box);
  if (state.user) {
    box.append(
      el('span', { class: 'userbox__name' }, state.user.username),
      el(
        'a',
        { class: 'avatar', href: '#/account', 'data-link': '', title: 'Account settings' },
        (state.user.username || '?')[0].toUpperCase(),
      ),
      el(
        'a',
        { class: 'btn btn--ghost btn--sm userbox__account', href: '#/account', 'data-link': '' },
        icon('user', { size: 14 }),
        'Account',
      ),
      el(
        'button',
        {
          class: 'btn btn--ghost btn--sm userbox__logout',
          title: 'Sign out',
          onClick: async () => {
            try {
              await api.post('/api/auth/logout');
            } catch { /* ignore */ }
            setToken(null);
            state.user = null;
            state.progress.clear();
            renderUserBox();
            renderNav();
            location.hash = '#/login';
          },
        },
        icon('logout', { size: 14, className: 'userbox__logout-icon' }),
        el('span', { class: 'userbox__logout-text' }, 'Sign out'),
      ),
    );
  } else {
    box.append(
      el('a', { class: 'btn btn--accent btn--sm', href: '#/login', 'data-link': '' }, icon('user', { size: 14 }), 'Sign in'),
    );
  }
}

/** Re-sync the header after a login/logout elsewhere in the app. */
export function syncUserUI() {
  renderUserBox();
  renderNav();
}

function renderNav() {
  $$('#nav a').forEach((link) => {
    const key = link.dataset.nav;
    if (key === 'admin' && state.user?.role !== 'admin') {
      link.style.display = 'none';
    } else {
      link.style.display = '';
    }
  });
  const nav = document.getElementById('nav');
  if (nav) nav.style.display = state.user ? '' : 'none';
}

/* --------------------------------------------------------------- routing */

async function onRoute() {
  const hash = location.hash || '#/';
  const [rawPath] = hash.slice(1).split('?');
  const path = rawPath || '/';

  // A player overlay takes over the whole screen.
  if (path.startsWith('/watch/')) {
    // Close the detail sheet first, otherwise it stays behind the player
    // and reappears when the player closes.
    closeModal();
    const id = Number(path.split('/')[2]);
    const params = new URLSearchParams(hash.split('?')[1] || '');
    openPlayer(id, params).catch((err) => {
      console.error('[player] failed to open:', err);
      toast(err.message || 'The player could not be opened', 'error');
    });
    return;
  }

  // Navigating away from the player must also release its listeners.
  invalidatePlayerRoute();
  runPlayerTeardown();
  closePlayer();
  closeModal();

  if (path === '/login') {
    renderLogin(view());
    return;
  }

  if (!state.user) {
    location.hash = '#/login';
    return;
  }

  $$('#nav a').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === `#${path}`);
  });

  try {
    if (path === '/' || path === '/home') {
      await renderHome(view());
    } else if (path === '/library') {
      await renderLibrary(view());
    } else if (path === '/continue') {
      await renderContinue(view());
    } else if (path === '/account') {
      await renderAccount(view());
    } else if (path === '/admin') {
      if (state.user.role !== 'admin') {
        view().append(el('div', { class: 'empty' },
          el('div', { class: 'empty__icon' }, icon('lock', { size: 32 })),
          el('h2', {}, 'Admins only'),
          el('p', {}, 'You need an admin account to open this page.'),
        ));
        return;
      }
      await renderAdmin(view());
    } else {
      view().append(el('div', { class: 'empty' },
        el('div', { class: 'empty__icon' }, icon('search', { size: 32 })),
        el('h2', {}, 'Page not found'),
        el('a', { class: 'btn', href: '#/', 'data-link': '' }, 'Back home'),
      ));
    }
  } catch (err) {
    console.error(err);
    view().append(el('div', { class: 'empty' },
      el('div', { class: 'empty__icon' }, icon('ban', { size: 32 })),
      el('h2', {}, 'Something went wrong'),
      el('p', {}, err.message),
    ));
  }
}

/* ------------------------------------------------------------ global UI */

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-link]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    if (link.getAttribute('href') === location.hash) {
      event.preventDefault();
      onRoute().catch((err) => {
        console.error(err);
        toast(err.message, 'error');
      });
    }
  });

  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  let searchTimer;
  searchForm?.addEventListener('submit', (e) => e.preventDefault());
  searchInput?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (value) location.hash = `#/library?q=${encodeURIComponent(value)}`;
      else if (location.hash.startsWith('#/library')) location.hash = '#/library';
    }, 320);
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ms_theme', next);
    applyTheme();
  });

  document.addEventListener('keydown', (event) => {
    // While the player is open it owns the keyboard — otherwise the search
    // shortcut would steal "/" from the player's help panel.
    if (document.querySelector('.mp')) return;

    if (event.key === 'Escape') {
      closeModal();
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      searchInput?.focus();
    }
  });

  // The topbar gains a shadow once the page is scrolled.
  const topbar = document.getElementById('topbar');
  const onScroll = () => {
    topbar?.classList.toggle('is-scrolled', window.scrollY > 12);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function applyTheme() {
  const saved = localStorage.getItem('ms_theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  clear(btn);
  btn.append(icon(saved === 'light' ? 'sun' : 'moon', { size: 16 }));
}

/* ---------------------------------------------------------------- modal */

export function openModal(content, { onClose } = {}) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  clear(root);
  root.append(content);
  root.hidden = false;
  root._onClose = onClose;
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (!root || root.hidden) return;
  root.hidden = true;
  clear(root);
  const onClose = root._onClose;
  root._onClose = null;
  if (typeof onClose === 'function') onClose();
}

export function closePlayer() {
  // Both the current (.mp) and the legacy (.player-page) markup are removed.
  for (const selector of ['.mp', '.player-page']) {
    const existing = document.querySelector(selector);
    if (!existing) continue;
    const video = existing.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    existing.remove();
  }
  document.body.style.overflow = '';
}
document.addEventListener('click', (event) => {
  const root = document.getElementById('modal-root');
  if (root && !root.hidden && event.target === root) closeModal();
});

/* ------------------------------------------------------------- helpers */

/** Load the shared movie list once and cache it. */
export async function loadMovies(params = {}) {
  const query = new URLSearchParams(params).toString();
  const data = await api.get(`/api/movies${query ? `?${query}` : ''}`);
  state.movies = data.movies || [];
  return state.movies;
}

export async function loadProgress(movieId) {
  try {
    const data = await api.get(`/api/movies/${movieId}/progress`);
    if (data.progress) state.progress.set(movieId, data.progress);
    return data.progress;
  } catch {
    return null;
  }
}

/**
 * Load every watch position for the current user in a single request
 * (instead of one request per movie).
 */
export async function loadAllProgress() {
  try {
    const data = await api.get('/api/movies/progress/bulk');
    state.progress.clear();
    for (const row of data.progress || []) {
      state.progress.set(row.movie_id, row);
    }
  } catch {
    /* ignore */
  }
  updateFooter();
  return state.progress;
}

export function updateFooter() {
  const stats = document.getElementById('footer-stats');
  if (!stats) return;
  const total = state.movies.reduce((sum, m) => sum + (m.totalSize || 0), 0);
  stats.textContent = `${state.movies.length} movies · ${formatBytes(total)}`;
}
