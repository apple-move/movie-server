import { el, clear } from '../dom.js';
import { state, loadMovies, loadAllProgress } from '../app.js';
import { movieRow, emptyState } from './cards.js';

/** Continue watching page. */
export async function renderContinue(root) {
  clear(root);
  const movies = await loadMovies({ limit: '500' });
  await loadAllProgress();

  const resumable = movies.filter((m) => {
    const p = state.progress.get(m.id);
    if (!p || !p.duration_sec || p.position_sec < 5) return false;
    return p.position_sec / p.duration_sec < 0.97;
  });

  root.append(
    el(
      'div',
      { class: 'section__head', style: { paddingTop: '24px' } },
      el('h1', { class: 'section__title' }, 'Continue Watching'),
      el('span', { class: 'section__count' }, `${resumable.length} title${resumable.length === 1 ? '' : 's'}`),
    ),
  );

  if (!resumable.length) {
    root.append(
      emptyState('clock', 'Nothing in progress', 'Movies you start watching will show up here so you can pick up where you left off.'),
    );
    return;
  }

  const row = movieRow('Resume', resumable);
  root.append(row);
}
