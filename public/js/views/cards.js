import { el, formatBytes, toast } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../app.js';

/**
 * Poster art. Handles TMDB URLs, provider-hosted images (proxied through
 * /api/images) and local posters.
 */
export function posterUrl(movie, size = 'w500') {
  const url = movie.poster_url;
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('api://image')) {
    const params = new URLSearchParams(url.replace('api://image', ''));
    return `/api/images?${params.toString()}`;
  }
  if (url.startsWith('/')) return url;
  return `https://image.tmdb.org/t/p/${size}/${url}`;
}

export function backdropUrl(movie) {
  const url = movie.backdrop_url || movie.poster_url;
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('api://image')) {
    const params = new URLSearchParams(url.replace('api://image', ''));
    return `/api/images?${params.toString()}`;
  }
  if (url.startsWith('/')) return url;
  return `https://image.tmdb.org/t/p/w1280/${url}`;
}

/** A movie card with a hover play affordance and a resume bar. */
export function movieCard(movie, { onOpen } = {}) {
  const poster = posterUrl(movie);
  const progress = state.progress.get(movie.id);
  const pct =
    progress && progress.duration_sec
      ? Math.min(100, (progress.position_sec / progress.duration_sec) * 100)
      : 0;

  const card = el(
    'article',
    { class: 'card', tabindex: '0', role: 'button', 'aria-label': movie.title },
    el(
      'div',
      { class: 'card__poster' },
      poster
        ? el('img', { src: poster, alt: movie.title, loading: 'lazy', decoding: 'async' })
        : el('div', { class: 'card__poster--empty' }, icon('film', { size: 34 })),
      movie.featured
        ? el('span', { class: 'card__badge' }, 'Featured')
        : null,
      movie.rating
        ? el('span', { class: 'card__rating' }, icon('star', { size: 11 }), Number(movie.rating).toFixed(1))
        : null,
      el('div', { class: 'card__play' }, el('span', {}, icon('play', { size: 20 }))),
      pct > 1
        ? el('div', { class: 'card__progress' }, el('span', { style: { width: `${pct}%` } }))
        : null,
    ),
    el(
      'div',
      { class: 'card__body' },
      el('h3', { class: 'card__title' }, movie.title),
      el(
        'div',
        { class: 'card__meta' },
        movie.year ? el('span', {}, String(movie.year)) : null,
        movie.sources?.length ? el('span', {}, formatBytes(movie.totalSize)) : null,
        (movie.genres || []).slice(0, 1).map((g) => el('span', {}, g)),
      ),
    ),
  );

  const open = () =>
    onOpen
      ? onOpen(movie)
      : import('./detail.js')
          .then((m) => m.openMovie(movie.id))
          .catch((err) => {
            console.error(err);
            toast(err.message, 'error');
          });

  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

/** A horizontally scrolling row of movie cards. */
export function movieRow(title, movies, { onOpen, subtitle } = {}) {
  if (!movies.length) return null;
  const scroller = el('div', { class: 'row__scroller' });
  for (const movie of movies) {
    scroller.append(movieCard(movie, { onOpen }));
  }
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section__head' },
      el(
        'div',
        {},
        el('h2', { class: 'section__title' }, title),
        subtitle ? el('span', { class: 'section__count' }, subtitle) : null,
      ),
      el('span', { class: 'section__count' }, `${movies.length} title${movies.length === 1 ? '' : 's'}`),
    ),
    scroller,
  );
}

/** Full-page empty state. */
export function emptyState(iconName, title, message, action) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon(iconName, { size: 32 })),
    el('h2', {}, title),
    el('p', {}, message),
    action || null,
  );
}
