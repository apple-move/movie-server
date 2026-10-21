import { api, downloadUrl } from '../api.js';
import { el, clear, formatBytes, timeAgo, toast } from '../dom.js';
import { icon } from '../icons.js';
import { openModal, closeModal, state } from '../app.js';
import { posterUrl, backdropUrl } from './cards.js';

/** Open the detail modal for a movie. */
export async function openMovie(movieId) {
  const modal = el('div', { class: 'modal' });
  openModal(modal);

  let data;
  try {
    data = await api.get(`/api/movies/${movieId}`);
  } catch (err) {
    clear(modal).append(el('p', { style: { padding: '30px' } }, err.message));
    return;
  }

  renderDetail(modal, data.movie);
}

/**
 * Choose the source to play by default: prefer 1080p, then 720p, then the
 * smallest remaining file (a sensible fallback over a huge 4K remux).
 */
function pickDefaultSource(sources) {
  if (!sources.length) return null;
  for (const quality of ['1080p', '720p', '480p']) {
    const match = sources.find((s) => String(s.quality || '').toLowerCase() === quality);
    if (match) return match;
  }
  return [...sources].sort((a, b) => (a.size || 0) - (b.size || 0))[0];
}

/**
 * Whether a source would benefit from being converted to MP4:
 *   - HLS playlists have no single file to download
 *   - MKV and other containers browsers cannot decode
 */
function needsConversion(source) {
  if (source.kind === 'hls') return true;
  const mime = String(source.mime || '').toLowerCase();
  if (mime.includes('matroska') || mime.includes('x-msvideo') || mime.includes('quicktime')) return true;
  return /\.(mkv|avi|wmv|flv|mov)$/i.test(source.file_name || '');
}

/** Start an ffmpeg job that produces a browser-playable MP4. */
async function convertToMp4(button, source) {
  button.disabled = true;
  // Keep the nodes, not the text — the button holds an SVG icon that
  // textContent would destroy.
  const original = [...button.childNodes];
  button.textContent = '…';
  try {
    await api.post('/api/admin/convert', { sourceId: source.id });
    toast('Conversion started — it will appear as a new source when it finishes', 'ok', 5000);
  } catch (err) {
    toast(err.message, 'error');
  }
  button.disabled = false;
  button.replaceChildren(...original);
}

function renderDetail(modal, movie) {
  clear(modal);

  const backdrop = backdropUrl(movie);
  const poster = posterUrl(movie);
  const progress = state.progress.get(movie.id);
  const resuming =
    progress && progress.duration_sec && progress.position_sec / progress.duration_sec > 0.02;

  modal.append(
    el(
      'div',
      { class: 'modal__backdrop' },
      backdrop ? el('img', { src: backdrop, alt: '' }) : null,
      el(
        'button',
        { class: 'modal__close', 'aria-label': 'Close', title: 'Close', onClick: closeModal },
        icon('x', { size: 17 }),
      ),
    ),
  );

  const body = el('div', { class: 'modal__body' });

  body.append(el('h2', { class: 'modal__title' }, movie.title));

  body.append(
    el(
      'div',
      { class: 'modal__meta' },
      movie.year ? el('span', { class: 'pill' }, String(movie.year)) : null,
      movie.rating
        ? el('span', { class: 'pill' }, icon('star', { size: 12 }), Number(movie.rating).toFixed(1))
        : null,
      movie.runtime ? el('span', { class: 'pill' }, icon('clock', { size: 12 }), `${movie.runtime} min`) : null,
      (movie.genres || []).map((g) => el('span', { class: 'pill' }, g)),
      el(
        'span',
        { class: 'pill pill--accent' },
        icon('film', { size: 12 }),
        `${movie.sources?.length || 0} source${movie.sources?.length === 1 ? '' : 's'}`,
      ),
      movie.created_at ? el('span', { class: 'pill' }, `Added ${timeAgo(movie.created_at)}`) : null,
    ),
  );

  if (movie.tagline) {
    body.append(el('p', { class: 'modal__tagline' }, `“${movie.tagline}”`));
  }
  if (movie.overview) body.append(el('p', { class: 'modal__overview' }, movie.overview));

  const primary = pickDefaultSource(movie.sources || []);

  const actions = el('div', { class: 'modal__actions' });
  if (primary) {
    actions.append(
      el(
        'a',
        { class: 'btn btn--accent', href: `#/watch/${movie.id}?source=${primary.id}`, 'data-link': '' },
        icon('play', { size: 16 }),
        resuming ? 'Resume' : 'Play',
      ),
    );
  } else {
    actions.append(el('span', { class: 'pill pill--warn' }, 'No playable source attached'));
  }
  if (primary) {
    actions.append(
      el(
        'a',
        { class: 'btn btn--ghost', href: downloadUrl(primary.id) },
        icon('download', { size: 15 }),
        'Download',
      ),
    );
  }
  body.append(actions);

  /* ---- cast & crew ---- */
  if (movie.cast?.length) {
    body.append(el('h3', { class: 'modal__section' }, 'Cast'));
    const grid = el('div', { class: 'cast-grid' });
    for (const person of movie.cast.slice(0, 10)) {
      grid.append(
        el(
          'div',
          { class: 'cast-item' },
          person.image
            ? el('img', { src: person.image, alt: person.name, loading: 'lazy' })
            : el('div', { class: 'cast-item__placeholder' }, icon('user', { size: 16 })),
          el(
            'div',
            {},
            el('div', { class: 'cast-item__name' }, person.name),
            person.character ? el('div', { class: 'cast-item__role' }, person.character) : null,
          ),
        ),
      );
    }
    body.append(grid);
  }

  /* ---- sources ---- */
  if (movie.sources?.length) {
    body.append(el('h3', { class: 'modal__section' }, 'Available sources'));
    const list = el('div', { class: 'source-list' });

    for (const source of movie.sources) {
      const kindBadge =
        source.kind === 'zip'
          ? el('span', { class: 'pill pill--warn' }, icon('archive', { size: 11 }), 'Archive')
          : source.kind === 'hls'
            ? el('span', { class: 'pill pill--info' }, icon('activity', { size: 11 }), 'HLS')
            : null;

      list.append(
        el(
          'div',
          { class: 'source-item' },
          el(
            'div',
            {},
            el(
              'div',
              { class: 'source-item__name' },
              source.label || source.file_name || 'Video file',
              kindBadge,
            ),
            el(
              'div',
              { class: 'source-item__meta' },
              `${source.provider.toUpperCase()} · ${formatBytes(source.size)}`,
              source.quality ? ` · ${source.quality}` : '',
              source.mime ? ` · ${source.mime.replace('video/', '').toUpperCase()}` : '',
            ),
          ),
          el(
            'div',
            { class: 'source-item__actions' },
            el(
              'a',
              {
                class: 'btn btn--soft btn--sm',
                href: `#/watch/${movie.id}?source=${source.id}`,
                'data-link': '',
              },
              icon('play', { size: 14 }),
              source.kind === 'hls' ? 'Live' : 'Play',
            ),
            source.kind === 'hls'
              ? null
              : el(
                  'a',
                  { class: 'btn btn--ghost btn--sm', href: downloadUrl(source.id) },
                  icon('download', { size: 14 }),
                  'Download',
                ),
            needsConversion(source) && state.user?.role === 'admin'
              ? el(
                  'button',
                  {
                    class: 'btn btn--ghost btn--sm',
                    title: 'Convert to MP4 with ffmpeg so browsers can play it',
                    onClick: (e) => convertToMp4(e.currentTarget, source),
                  },
                  icon('zap', { size: 14 }),
                  'MP4',
                )
              : null,
          ),
        ),
      );
    }
    body.append(list);
  }

  /* ---- subtitles ---- */
  if (movie.subtitles?.length) {
    body.append(el('h3', { class: 'modal__section' }, 'Subtitles'));
    const list = el('div', { class: 'source-list' });
    for (const sub of movie.subtitles) {
      list.append(
        el(
          'div',
          { class: 'source-item' },
          el(
            'div',
            {},
            el('div', { class: 'source-item__name' }, icon('subtitles', { size: 14 }), sub.label || sub.language),
            el('div', { class: 'source-item__meta' }, sub.language.toUpperCase()),
          ),
        ),
      );
    }
    body.append(list);
  }

  if (poster) {
    body.append(
      el(
        'div',
        { style: { marginTop: '26px' } },
        el('img', {
          src: poster,
          alt: movie.title,
          style: { maxWidth: '200px', borderRadius: '14px', border: '1px solid var(--line)' },
        }),
      ),
    );
  }

  modal.append(body);
}
