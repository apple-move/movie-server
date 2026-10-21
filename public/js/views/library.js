import { api } from '../api.js';
import { el, clear } from '../dom.js';
import { state, loadMovies, loadAllProgress, updateFooter } from '../app.js';
import { movieCard, emptyState } from './cards.js';

/** Library page — full grid with search, genre filter and sorting. */
export async function renderLibrary(root) {
  clear(root);

  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const search = params.get('q') || '';
  const genre = params.get('genre') || '';
  const sort = params.get('sort') || 'recent';

  if (!state.genres.length) {
    try {
      const data = await api.get('/api/movies/meta/genres');
      state.genres = data.genres || [];
    } catch { /* ignore */ }
  }

  const controls = el(
    'div',
    { class: 'section__head', style: { paddingTop: '24px' } },
    el('h1', { class: 'section__title' }, search ? `Results for “${search}”` : 'All Movies'),
    el(
      'div',
      { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      el(
        'select',
        {
          class: 'btn btn--soft btn--sm',
          onChange: (e) => {
            const next = new URLSearchParams(params);
            next.set('genre', e.target.value);
            location.hash = `#/library?${next.toString()}`;
          },
        },
        el('option', { value: '' }, 'All genres'),
        state.genres.map((g) =>
          el('option', { value: g, selected: g === genre }, g),
        ),
      ),
      el(
        'select',
        {
          class: 'btn btn--soft btn--sm',
          onChange: (e) => {
            const next = new URLSearchParams(params);
            next.set('sort', e.target.value);
            location.hash = `#/library?${next.toString()}`;
          },
        },
        [
          ['recent', 'Recently added'],
          ['title', 'Title A–Z'],
          ['year', 'Newest first'],
          ['rating', 'Top rated'],
        ].map(([value, label]) => el('option', { value, selected: value === sort }, label)),
      ),
    ),
  );

  root.append(controls);

  const query = { limit: '500', sort };
  if (search) query.q = search;
  if (genre) query.genre = genre;

  let movies;
  try {
    movies = await loadMovies(query);
  } catch (err) {
    root.append(emptyState('ban', 'Could not load movies', err.message));
    return;
  }
  updateFooter();

  if (!movies.length) {
  root.append(
    emptyState(
      'search',
      search ? 'No matches found' : 'No movies yet',
      search
        ? `Nothing matched “${search}”. Try a different keyword.`
        : 'Add movies from the Admin page to see them here.',
    ),
  );
  return;
}

  await loadAllProgress();

  const grid = el('div', { class: 'grid', style: { marginTop: '18px' } });
  for (const movie of movies) grid.append(movieCard(movie));
  root.append(grid);
}
