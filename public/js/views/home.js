import { el, clear, formatBytes } from '../dom.js';
import { icon } from '../icons.js';
import { state, loadMovies, loadAllProgress, updateFooter } from '../app.js';
import { movieRow, backdropUrl, emptyState } from './cards.js';

/** Home page — hero banner + curated rows. */
export async function renderHome(root) {
  clear(root);
  const movies = await loadMovies({ sort: 'recent', limit: '300' });
  updateFooter();

  if (!movies.length) {
    root.append(
      emptyState(
        'film',
        'Your library is empty',
        'Scan a storage provider from the Admin page, or upload a movie file to get started.',
        state.user?.role === 'admin'
          ? el('a', { class: 'btn btn--accent', href: '#/admin', 'data-link': '' }, 'Open Admin')
          : null,
      ),
    );
    return;
  }

  await loadAllProgress();

  const featured = movies.find((m) => m.featured) || movies[0];
  root.append(buildHero(featured));

  const rows = el('div', { class: 'rows' });

  const recent = [...movies]
    .sort((a, b) => parseSqlDate(b.created_at) - parseSqlDate(a.created_at))
    .slice(0, 24);
  rows.append(movieRow('Recently Added', recent));

  const inProgress = movies.filter((m) => {
    const p = state.progress.get(m.id);
    return p && p.duration_sec && p.position_sec / p.duration_sec > 0.02 && p.position_sec / p.duration_sec < 0.97;
  });
  if (inProgress.length) {
    const row = movieRow('Continue Watching', inProgress);
    if (row) rows.append(row);
  }

  const topRated = [...movies]
    .filter((m) => m.rating)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 24);
  if (topRated.length) rows.append(movieRow('Top Rated', topRated));

  const byGenre = new Map();
  for (const movie of movies) {
    for (const genre of movie.genres || []) {
      if (!byGenre.has(genre)) byGenre.set(genre, []);
      byGenre.get(genre).push(movie);
    }
  }
  const sortedGenres = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  for (const [genre, list] of sortedGenres) {
    const row = movieRow(genre, list.slice(0, 24));
    if (row) rows.append(row);
  }

  const withSources = movies.filter((m) => m.sources?.length);
  const withoutSources = movies.filter((m) => !m.sources?.length);
  if (withoutSources.length) {
    const row = movieRow('Awaiting Files', withoutSources);
    if (row) rows.append(row);
  }
  if (withSources.length) {
    const row = movieRow('All Titles', withSources);
    if (row) rows.append(row);
  }

  root.append(rows);
}

/**
 * SQLite returns `YYYY-MM-DD HH:MM:SS` in UTC. `new Date()` would parse
 * that as local time, so the 'Z' is added explicitly.
 */
function parseSqlDate(value) {
  if (!value) return 0;
  const iso = String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function buildHero(movie) {
  const bg = backdropUrl(movie);
  const progress = state.progress.get(movie.id);
  const resuming =
    progress && progress.duration_sec && progress.position_sec / progress.duration_sec > 0.02;

  return el(
    'section',
    { class: 'hero' },
    bg ? el('img', { class: 'hero__bg', src: bg, alt: '', fetchpriority: 'high' }) : null,
    el(
      'div',
      { class: 'hero__content' },
      el(
        'div',
        { class: 'hero__kicker' },
        icon(movie.featured ? 'sparkles' : 'zap', { size: 13 }),
        movie.featured ? 'Featured' : 'Now playing',
      ),
      el('h1', { class: 'hero__title' }, movie.title),
      el(
        'div',
        { class: 'hero__meta' },
        movie.year ? el('span', { class: 'pill' }, String(movie.year)) : null,
        movie.rating
          ? el('span', { class: 'pill' }, icon('star', { size: 12 }), Number(movie.rating).toFixed(1))
          : null,
        movie.runtime ? el('span', { class: 'pill' }, `${movie.runtime} min`) : null,
        (movie.genres || []).slice(0, 3).map((g) => el('span', { class: 'pill' }, g)),
        movie.sources?.length
          ? el('span', { class: 'pill' }, formatBytes(movie.totalSize))
          : null,
      ),
      movie.overview ? el('p', { class: 'hero__overview' }, movie.overview) : null,
      el(
        'div',
        { class: 'hero__actions' },
        el(
          'a',
          {
            class: 'btn btn--accent',
            href: `#/watch/${movie.id}`,
            'data-link': '',
          },
          icon('play', { size: 17 }),
          resuming ? 'Resume' : 'Play',
        ),
        el(
          'button',
          {
            class: 'btn btn--ghost',
            onClick: () => import('./detail.js').then((m) => m.openMovie(movie.id)),
          },
          icon('info', { size: 16 }),
          'More info',
        ),
        el(
          'a',
          {
            class: 'btn btn--ghost',
            href: '#/library',
            'data-link': '',
          },
          icon('grid', { size: 16 }),
          'Browse all',
        ),
      ),
    ),
  );
}
