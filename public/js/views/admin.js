import { api } from '../api.js';
import { el, clear, formatBytes, toast, debounce } from '../dom.js';
import { icon, PROVIDER_ICONS } from '../icons.js';
import { state } from '../app.js';

/**
 * Admin panel.
 *
 * Tabs:
 *   Storage   — provider instances (add/edit/test/scan), usage
 *   Movies    — TMDB import, metadata refresh, bulk actions
 *   Upload    — drag & drop uploads into any provider
 *   Jobs      — ffmpeg remux / transcode queue
 *   Users     — accounts, roles, 2FA
 *   Security  — sessions, IP bans, audit log
 *   Settings  — server settings
 */
export async function renderAdmin(root) {
  clear(root);

  let status;
  try {
    status = await api.get('/api/admin/status');
  } catch (err) {
    root.append(el('div', { class: 'empty' }, el('h2', {}, 'Could not load admin status'), el('p', {}, err.message)));
    return;
  }

  root.append(
    el(
      'div',
      { class: 'stat-grid', style: { paddingTop: '24px' } },
      statCard(status.movies, 'Movies'),
      statCard(status.sources, 'Sources'),
      statCard(status.users, 'Users'),
      statCard(status.totalSizeLabel || formatBytes(status.totalSize), 'Total size'),
      statCard(status.providers.filter((p) => p.configured).length, 'Providers ready'),
      statCard(status.ffmpeg ? 'Yes' : 'No', 'ffmpeg'),
    ),
  );

  const tabs = el('div', { class: 'tabs' });
  const panel = el('div', { class: 'admin__grid' });
  const admin = el('div', { class: 'admin' }, tabs, panel);
  root.append(admin);

  const views = {
    storage: () => storagePanel(panel, status),
    movies: () => moviesPanel(panel),
    upload: () => uploadPanel(panel),
    jobs: () => jobsPanel(panel, status),
    users: () => usersPanel(panel),
    security: () => securityPanel(panel),
    settings: () => settingsPanel(panel, status),
  };

  const tabDefs = [
    ['storage', 'server', 'Storage'],
    ['movies', 'film', 'Movies'],
    ['upload', 'upload', 'Upload'],
    ['jobs', 'zap', 'Jobs'],
    ['users', 'users', 'Users'],
    ['security', 'shield', 'Security'],
    ['settings', 'settings', 'Settings'],
  ];

  for (const [key, iconName, label] of tabDefs) {
    tabs.append(
      el(
        'button',
        {
          class: 'tab',
          'data-tab': key,
          onClick: () => selectTab(key),
        },
        icon(iconName, { size: 15 }),
        label,
      ),
    );
  }

  function selectTab(key) {
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === key));
    clear(panel);
    Promise.resolve(views[key]()).catch((err) => {
      console.error(err);
      toast(err.message || 'Could not load this panel', 'error');
    });
  }

  selectTab('storage');
}

function statCard(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat__value' }, String(value)), el('div', { class: 'stat__label' }, label));
}

/* ------------------------------------------------------------- storage */

async function storagePanel(panel, status) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Storage providers'));
  container.append(
    el(
      'p',
      { class: 'hint' },
      'Add as many instances as you like — several Cloudflare R2 buckets, several MEGA accounts, several Google Drive accounts, several local folders.',
    ),
  );

  const addBtn = el(
    'button',
    { class: 'btn btn--accent btn--sm', style: { marginBottom: '14px' } },
    '+ Add provider',
  );
  addBtn.addEventListener('click', () => showProviderForm(container));
  container.append(addBtn);

  const table = el(
    'table',
    { class: 'table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, 'Provider'),
        el('th', {}, 'Type'),
        el('th', {}, 'Status'),
        el('th', {}, 'Usage'),
        el('th', {}, 'Actions'),
      ),
    ),
  );
  const tbody = el('tbody');

  for (const provider of status.providers) {
    const usageCell = el('td', {}, '—');
    const providerIcon = PROVIDER_ICONS[provider.type] || 'server';
    const row = el(
      'tr',
      {},
      el('td', {}, icon(providerIcon, { size: 16, className: 'provider-icon' }), provider.name),
      el('td', {}, provider.type),
      el(
        'td',
        {},
        provider.configured
          ? el('span', { class: 'pill pill--ok' }, 'Ready')
          : el('span', { class: 'pill' }, 'Not configured'),
        provider.enabled ? null : el('span', { class: 'pill pill--warn', style: { marginLeft: '6px' } }, 'Disabled'),
      ),
      usageCell,
      el(
        'td',
        {},
        el(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          el(
            'button',
            {
              class: 'btn btn--soft btn--sm',
              disabled: !provider.configured,
              title: provider.configured ? '' : 'Configure this provider first',
              onClick: async (e) => {
                const btn = e.target;
                btn.disabled = true;
                btn.textContent = '…';
                try {
                  const res = await api.get(`/api/admin/providers/${provider.id}/usage`);
                  usageCell.textContent = `${res.usage.bytesLabel} · ${res.usage.files} files`;
                } catch (err) {
                  usageCell.textContent = 'n/a';
                }
                btn.disabled = false;
                btn.textContent = 'Usage';
              },
            },
            'Usage',
          ),
          el(
            'button',
            {
              class: 'btn btn--soft btn--sm',
              disabled: !provider.configured,
              title: provider.configured ? '' : 'Configure this provider first',
              onClick: async (e) => {
                const btn = e.target;
                btn.disabled = true;
                btn.textContent = 'Scanning…';
                try {
                  const res = await api.post('/api/admin/scan', { provider: provider.id });
                  const s = res.stats;
                  toast(`Scanned ${s.scanned} files · ${s.created} new · ${s.updated} updated`, 'ok', 5000);
                } catch (err) {
                  toast(err.message, 'error');
                }
                btn.disabled = false;
                btn.textContent = 'Scan';
              },
            },
            'Scan',
          ),
          el(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              onClick: () => showProviderForm(container, provider),
            },
            'Edit',
          ),
          el(
            'button',
            {
              class: 'btn btn--danger btn--sm',
              onClick: async () => {
                if (!confirm(`Delete the provider "${provider.name}"?`)) return;
                try {
                  await api.del(`/api/admin/providers/${provider.id}`);
                  toast('Provider deleted', 'ok');
                  renderAdmin(document.getElementById('view'));
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Delete',
          ),
        ),
      ),
    );
    tbody.append(row);
  }
  table.append(tbody);
  container.append(el('div', { class: 'table__scroll' }, table));
  panel.append(container);
}

/** Add / edit a provider instance. */
async function showProviderForm(container, existing = null) {
  const { types, fields } = await api.get('/api/admin/provider-types');
  const typeSelect = el(
    'select',
    {},
    types.map((t) => el('option', { value: t.id, selected: t.id === existing?.type }, t.name)),
  );

  const nameInput = el('input', { type: 'text', value: existing?.name || '', placeholder: 'e.g. 4K Archive' });
  const idInput = el('input', {
    type: 'text',
    value: existing?.id || '',
    placeholder: 'r2_backup',
    disabled: Boolean(existing),
  });

  const fieldWrap = el('div', {});
  const inputs = new Map();

  function renderFields() {
    clear(fieldWrap);
    inputs.clear();
    const defs = fields[typeSelect.value] || [];
    for (const def of defs) {
      const input =
        def.type === 'textarea'
          ? el('textarea', { rows: '4', placeholder: def.placeholder || '' })
          : el('input', { type: def.type, placeholder: def.placeholder || '' });
      inputs.set(def.key, input);
      fieldWrap.append(
        el(
          'div',
          { class: 'field' },
          el('label', {}, def.label + (def.required ? ' *' : '')),
          input,
        ),
      );
    }
  }
  typeSelect.addEventListener('change', renderFields);
  renderFields();

  const error = el('div', { class: 'alert alert--error', hidden: true });

  const form = el(
    'form',
    {},
    error,
    el('div', { class: 'row-inline' },
      el('div', { class: 'field' }, el('label', {}, 'Type'), typeSelect),
      el('div', { class: 'field' }, el('label', {}, 'Display name'), nameInput),
      el('div', { class: 'field' }, el('label', {}, 'Instance id'), idInput),
    ),
    fieldWrap,
    el(
      'div',
      { style: { display: 'flex', gap: '10px', marginTop: '10px' } },
      el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, existing ? 'Save' : 'Add provider'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => form.remove() }, 'Cancel'),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const cfg = {};
    for (const [key, input] of inputs) {
      const value = String(input.value || '').trim();
      if (value) cfg[key] = value;
    }
    try {
      if (existing) {
        await api.patch(`/api/admin/providers/${existing.id}`, { name: nameInput.value.trim() || existing.id, config: cfg });
        toast('Provider updated', 'ok');
      } else {
        await api.post('/api/admin/providers', {
          id: idInput.value.trim() || undefined,
          type: typeSelect.value,
          name: nameInput.value.trim() || undefined,
          config: cfg,
        });
        toast('Provider added', 'ok');
      }
      form.remove();
      renderAdmin(document.getElementById('view'));
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  container.append(form);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------- movies */

async function moviesPanel(panel) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Library'));
  container.append(
    el(
      'p',
      { class: 'hint' },
      'Search TMDB and add a movie with its full details — synopsis, poster, genres, cast, crew and trailer — in one click.',
    ),
  );

  // TMDB key status + inline setup.
  const keyRow = el('div', { class: 'tmdb-key' });
  const renderKeyRow = async () => {
    clear(keyRow);
    try {
      const status = await api.get('/api/admin/tmdb/key');
      if (status.configured) {
        keyRow.append(
          el('span', { class: 'pill pill--ok' }, icon('check', { size: 12 }), 'TMDB connected'),
          el(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              onClick: async () => {
                const key = prompt('Enter a new TMDB API key (leave empty to remove):');
                if (key === null) return;
                try {
                  await api.put('/api/admin/tmdb/key', { apiKey: key.trim() });
                  toast(key.trim() ? 'TMDB key saved' : 'TMDB key removed', 'ok');
                  renderKeyRow();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Change key',
          ),
        );
      } else {
        keyRow.append(
          el('span', { class: 'pill pill--warn' }, icon('info', { size: 12 }), 'No TMDB key'),
          el('span', { class: 'field__hint' }, 'Add a free key to auto-fill movie details.'),
        );
      }
    } catch { /* ignore */ }
  };
  renderKeyRow();
  container.append(keyRow);

  const query = el('input', { type: 'text', placeholder: 'Search TMDB for a title…' });
  const results = el('div', { class: 'source-list' });
  const table = el('div', { class: 'table__scroll' });

  const search = debounce(async () => {
    const q = query.value.trim();
    if (!q) {
      clear(results);
      return;
    }
    results.append(el('p', { class: 'hint' }, 'Searching…'));
    try {
      const data = await api.get(`/api/admin/tmdb/search?q=${encodeURIComponent(q)}`);
      clear(results);
      if (!data.results.length) {
        results.append(el('p', { class: 'hint' }, 'No TMDB results found.'));
        return;
      }
      for (const item of data.results) {
        results.append(
          el(
            'div',
            { class: 'source-item' },
            item.poster ? el('img', { src: item.poster, style: { width: '48px', borderRadius: '8px' } }) : null,
            el(
              'div',
              {},
              el('div', { class: 'source-item__name' }, `${item.title}${item.year ? ` (${item.year})` : ''}`),
              el('div', { class: 'source-item__meta' },
                `Rated ${Number(item.rating || 0).toFixed(1)}`,
              ),
            ),
            el(
              'div',
              { class: 'source-item__actions' },
              el(
                'button',
                {
                  class: 'btn btn--accent btn--sm',
                  onClick: async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    btn.textContent = 'Importing…';
                    try {
                      const res = await api.post('/api/admin/tmdb/import', { tmdbId: item.id });
                      toast(
                        res.created
                          ? `Added “${item.title}” with full details`
                          : `Updated “${item.title}”`,
                        'ok',
                        5000,
                      );
                      btn.textContent = 'Done';
                      renderAdmin(document.getElementById('view'));
                    } catch (err) {
                      toast(err.message, 'error');
                      btn.disabled = false;
                      btn.textContent = 'Import';
                    }
                  },
                },
                'Import with details',
              ),
            ),
          ),
        );
      }
    } catch (err) {
      clear(results).append(el('p', { class: 'hint' }, err.message));
      toast(err.message, 'error');
    }
  }, 400);

  query.addEventListener('input', search);

  container.append(el('div', { class: 'field' }, el('label', {}, 'TMDB search'), query));
  container.append(results);
  container.append(el('h3', { style: { marginTop: '22px' } }, 'Existing movies'));
  panel.append(container);

  try {
    const data = await api.get('/api/movies?limit=500');
    const list = el(
      'table',
      { class: 'table' },
      el(
        'thead',
        {},
        el('tr', {},
          el('th', {}, ''),
          el('th', {}, 'Title'),
          el('th', {}, 'Year'),
          el('th', {}, 'Sources'),
          el('th', {}, 'Actions'),
        ),
      ),
    );
    const tbody = el('tbody');
    const selected = new Set();

    for (const movie of data.movies) {
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(movie.id);
        else selected.delete(movie.id);
      });
      tbody.append(
        el(
          'tr',
          {},
          el('td', {}, checkbox),
          el('td', {}, movie.title),
          el('td', {}, movie.year || '—'),
          el('td', {}, String(movie.sources?.length || 0)),
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              el(
                'button',
                {
                  class: 'btn btn--soft btn--sm',
                  onClick: async (e) => {
                    const btn = e.target;
                    btn.disabled = true;
                    btn.textContent = '…';
                    try {
                      await api.post(`/api/admin/enrich/${movie.id}`, { overwrite: true });
                      toast(`Updated metadata for "${movie.title}"`, 'ok');
                      btn.textContent = 'Refreshed';
                    } catch (err) {
                      toast(err.message, 'error');
                      btn.disabled = false;
                      btn.textContent = 'Refresh';
                    }
                  },
                },
                'Refresh',
              ),
              el(
                'button',
                {
                  class: 'btn btn--soft btn--sm',
                  onClick: () => showAttachForm(movie),
                },
                'Attach',
              ),
              el(
                'button',
                {
                  class: 'btn btn--soft btn--sm',
                  title: 'Convert the source to MP4 so browsers can play it',
                  onClick: () => showRemuxForm(movie),
                },
                icon('zap', { size: 14 }),
                'MP4',
              ),
              el(
                'button',
                {
                  class: 'btn btn--danger btn--sm',
                  onClick: async () => {
                    if (!confirm(`Delete "${movie.title}" and its sources?`)) return;
                    try {
                      await api.del(`/api/movies/${movie.id}`);
                      toast('Movie deleted', 'ok');
                      renderAdmin(document.getElementById('view'));
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Delete',
              ),
            ),
          ),
        ),
      );
    }
    list.append(tbody);
    table.append(list);
    container.append(table);

    // Bulk actions
    const bulk = el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } });
    const bulkAction = async (action, label) => {
      if (!selected.size) return toast('Select some movies first', 'error');
      if (action === 'delete' && !confirm(`Delete ${selected.size} movie(s)?`)) return;
      try {
        const res = await api.post('/api/admin/bulk', { action, movieIds: [...selected] });
        toast(`${label}: ${res.affected} movie(s)`, 'ok');
        renderAdmin(document.getElementById('view'));
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    bulk.append(
      el('button', { class: 'btn btn--soft btn--sm', onClick: () => bulkAction('feature', 'Featured') },
        icon('star', { size: 14 }), 'Feature'),
      el('button', { class: 'btn btn--soft btn--sm', onClick: () => bulkAction('unfeature', 'Unfeatured') },
        icon('x', { size: 14 }), 'Unfeature'),
      el('button', { class: 'btn btn--danger btn--sm', onClick: () => bulkAction('delete', 'Deleted') },
        icon('trash', { size: 14 }), 'Delete selected'),
    );
    container.append(bulk);
  } catch (err) {
    container.append(el('p', { class: 'hint' }, err.message));
  }
}

/** Attach an existing storage file (or archive) to a movie. */
async function showAttachForm(movie) {
  const providers = (await api.get('/api/movies/meta/providers')).providers.filter((p) => p.configured);
  if (!providers.length) {
    toast('No configured providers', 'error');
    return;
  }

  const providerSelect = el(
    'select',
    {},
    providers.map((p) => el('option', { value: p.id }, p.name)),
  );
  const fileList = el('div', { class: 'source-list', style: { maxHeight: '260px', overflowY: 'auto' } });
  const searchInput = el('input', { type: 'text', placeholder: 'Filter by name…' });

  const modal = el('div', { class: 'panel panel--wide' });
  modal.append(
    el('h3', {}, `Attach a file to “${movie.title}”`),
    el('div', { class: 'row-inline' },
      el('div', { class: 'field' }, el('label', {}, 'Provider'), providerSelect),
      el('div', { class: 'field' }, el('label', {}, 'Search'), searchInput),
    ),
    fileList,
    el('button', { class: 'btn btn--ghost btn--sm', onClick: () => modal.remove() }, 'Close'),
  );

  let files = [];
  async function load() {
    fileList.append(el('p', { class: 'hint' }, 'Loading…'));
    try {
      const data = await api.get(`/api/browse/remote?provider=${encodeURIComponent(providerSelect.value)}`);
      files = data.files || [];
      render();
    } catch (err) {
      clear(fileList).append(el('p', { class: 'hint' }, err.message));
    }
  }

  function render() {
    clear(fileList);
    const filter = searchInput.value.trim().toLowerCase();
    const shown = files.filter((f) => !filter || f.name.toLowerCase().includes(filter));
    if (!shown.length) {
      fileList.append(el('p', { class: 'hint' }, 'No matching files.'));
      return;
    }
    for (const file of shown.slice(0, 300)) {
      const isArchive = /\.(zip|rar|7z)$/i.test(file.name);
      const isPlaylist = /\.m3u8$/i.test(file.name);
      fileList.append(
        el(
          'div',
          { class: 'source-item' },
          el(
            'div',
            {},
            el('div', { class: 'source-item__name' }, file.name),
            el(
              'div',
              { class: 'source-item__meta' },
              `${file.sizeLabel}${isArchive ? ' · archive' : ''}${isPlaylist ? ' · HLS playlist' : ''}`,
            ),
          ),
          el(
            'div',
            { class: 'source-item__actions' },
            el(
              'button',
              {
                class: 'btn btn--accent btn--sm',
                onClick: async (e) => {
                  const btn = e.target;
                  btn.disabled = true;
                  btn.textContent = '…';
                  try {
                    const res = await api.post(`/api/movies/${movie.id}/sources`, {
                      provider: providerSelect.value,
                      remotePath: file.path,
                    });
                    toast(
                      res.source?.kind === 'zip'
                        ? 'Archive attached — pick the video inside the player'
                        : 'Source attached',
                      'ok',
                    );
                    modal.remove();
                    renderAdmin(document.getElementById('view'));
                  } catch (err) {
                    toast(err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Attach';
                  }
                },
              },
              'Attach',
            ),
          ),
        ),
      );
    }
  }

  providerSelect.addEventListener('change', load);
  searchInput.addEventListener('input', render);

  const host = document.getElementById('view');
  host.append(modal);
  modal.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  load();
}

/** Start a remux job for one of a movie's sources. */
async function showRemuxForm(movie) {
  const status = await api.get('/api/admin/status');
  if (!status.ffmpeg) {
    toast('ffmpeg is not installed on this server', 'error');
    return;
  }
  const sources = movie.sources || [];
  if (!sources.length) {
    toast('This movie has no source to convert', 'error');
    return;
  }

  const providers = (await api.get('/api/movies/meta/providers')).providers.filter((p) => p.configured);
  const sourceSelect = el(
    'select',
    {},
    sources.map((s) => el('option', { value: s.id }, `${s.label || s.file_name} (${s.provider})`)),
  );
  const providerSelect = el('select', {}, providers.map((p) => el('option', { value: p.id }, p.name)));
  const targetInput = el('input', {
    type: 'text',
    value: `Movies/${movie.title.replace(/[^\w -]+/g, '')}${movie.year ? ` (${movie.year})` : ''}/${movie.title.replace(/[^\w -]+/g, '')}.mp4`,
  });
  const error = el('div', { class: 'alert alert--error', hidden: true });

  const form = el(
    'form',
    {},
    error,
    el('div', { class: 'row-inline' },
      el('div', { class: 'field' }, el('label', {}, 'Source'), sourceSelect),
      el('div', { class: 'field' }, el('label', {}, 'Target provider'), providerSelect),
    ),
    el('div', { class: 'field' }, el('label', {}, 'Destination path'), targetInput),
    el('div', { style: { display: 'flex', gap: '10px' } },
      el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Start remux'),
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => form.remove() }, 'Cancel'),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    try {
      await api.post('/api/admin/jobs', {
        type: 'remux',
        sourceId: Number(sourceSelect.value),
        provider: providerSelect.value,
        targetPath: targetInput.value.trim(),
      });
      toast('Remux job started — check the Jobs tab', 'ok');
      form.remove();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  const host = document.getElementById('view');
  host.append(form);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------- upload */

function uploadPanel(panel) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Upload a movie'));
  container.append(el('p', { class: 'hint' }, 'Files are streamed straight into the storage provider you pick.'));

  const providerSelect = el('select', {});
  const folderInput = el('input', { type: 'text', placeholder: 'Movies/Example (2020)' });
  const movieSelect = el('select', {});

  const drop = el(
    'div',
    { class: 'dropzone' },
    el('div', { class: 'dropzone__icon' }, icon('upload', { size: 24 })),
    el('div', {}, 'Drop a video file here, or click to choose'),
    el('div', { class: 'field__hint' }, 'MP4, MKV, WebM, AVI, ZIP, M3U8 — up to 5 GB'),
  );
  const fileInput = el('input', { type: 'file', hidden: true, accept: 'video/*,.mkv,.mp4,.avi,.webm,.zip,.m3u8' });

  const progressWrap = el('div', { hidden: true });
  const progressBar = el('span', { style: { width: '0%' } });
  const progressText = el('div', { class: 'field__hint' }, '');
  progressWrap.append(progressBar, progressText);

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFile(fileInput.files[0]);
  });

  container.append(
    el(
      'div',
      { class: 'row-inline' },
      el('div', { class: 'field' }, el('label', {}, 'Storage provider'), providerSelect),
      el('div', { class: 'field' }, el('label', {}, 'Destination folder'), folderInput),
      el('div', { class: 'field' }, el('label', {}, 'Attach to movie'), movieSelect),
    ),
    el('div', { style: { marginTop: '16px' } }, drop, fileInput, progressWrap),
  );
  panel.append(container);

  async function loadOptions() {
    try {
      const providers = (await api.get('/api/movies/meta/providers')).providers.filter((p) => p.configured);
      clear(providerSelect);
      for (const p of providers) {
        providerSelect.append(el('option', { value: p.id }, p.name));
      }
      if (!providers.length) {
        providerSelect.append(el('option', { value: '' }, 'No providers configured'));
      }
    } catch { /* ignore */ }
    try {
      const data = await api.get('/api/movies?limit=500');
      clear(movieSelect);
      movieSelect.append(el('option', { value: '' }, '— Don’t attach —'));
      for (const m of data.movies) {
        movieSelect.append(el('option', { value: m.id }, `${m.title}${m.year ? ` (${m.year})` : ''}`));
      }
    } catch { /* ignore */ }
  }
  loadOptions();

  function uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    form.append('provider', providerSelect.value || 'local');
    form.append('folder', folderInput.value.trim());
    if (movieSelect.value) form.append('movieId', movieSelect.value);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('ms_token') || ''}`);

    progressWrap.hidden = false;
    progressText.textContent = `Uploading ${file.name} (${formatBytes(file.size)})…`;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `Uploading ${file.name} — ${pct.toFixed(1)}%`;
      }
    });

    xhr.addEventListener('load', () => {
      try {
        const res = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          progressBar.style.width = '100%';
          progressText.textContent = `Uploaded to ${res.provider} (${res.sizeLabel})`;
          toast(`Uploaded ${file.name}`, 'ok');
          loadOptions();
        } else {
          progressText.textContent = res.error || 'Upload failed';
          toast(res.error || 'Upload failed', 'error');
        }
      } catch {
        progressText.textContent = 'Upload failed';
        toast('Upload failed', 'error');
      }
    });

    xhr.addEventListener('error', () => {
      progressText.textContent = 'Network error during upload';
      toast('Network error during upload', 'error');
    });

    xhr.send(form);
  }
}

/* ---------------------------------------------------------------- jobs */

async function jobsPanel(panel, status) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Conversion jobs'));
  container.append(
    el(
      'p',
      { class: 'hint' },
      status.ffmpeg
        ? 'ffmpeg is available. Remux an MKV to MP4 so browsers can play it (fast, no quality loss).'
        : 'ffmpeg is not installed on this server. Install it to enable remuxing and transcoding.',
    ),
  );

  const jobList = el('div', { class: 'source-list' });
  container.append(jobList);

  /* Remux form — turn an MKV into a browser-playable MP4. */
  if (status.ffmpeg) {
    container.append(el('h4', { style: { marginTop: '20px' } }, 'New conversion job'));
    const movies = (await api.get('/api/movies?limit=500')).movies || [];
    const providers = (await api.get('/api/movies/meta/providers')).providers.filter((p) => p.configured);

    const movieSelect = el('select', {}, el('option', { value: '' }, '— pick a movie —'));
    const sourceSelect = el('select', {});
    const providerSelect = el('select', {}, providers.map((p) => el('option', { value: p.id }, p.name)));
    const targetInput = el('input', { type: 'text', placeholder: 'Movies/Example (2020)/example.mp4' });
    const typeSelect = el('select', {},
      el('option', { value: 'remux' }, 'Remux (fast, no quality loss)'),
      el('option', { value: 'transcode' }, 'Transcode to H.264 (slow)'),
    );

    const fillSources = () => {
      clear(sourceSelect);
      const movie = movies.find((m) => String(m.id) === movieSelect.value);
      if (!movie) return;
      for (const source of movie.sources || []) {
        sourceSelect.append(
          el('option', { value: source.id },
            `${source.label || source.file_name} (${source.provider}${source.kind !== 'file' ? `, ${source.kind}` : ''})`),
        );
      }
      if (!movie.sources?.length) {
        sourceSelect.append(el('option', { value: '' }, '— no sources —'));
      }
    };

    for (const movie of movies) {
      movieSelect.append(el('option', { value: movie.id }, `${movie.title}${movie.year ? ` (${movie.year})` : ''}`));
    }
    movieSelect.addEventListener('change', fillSources);
    fillSources();

    const jobForm = el('form', {},
      el('div', { class: 'row-inline' },
        el('div', { class: 'field' }, el('label', {}, 'Movie'), movieSelect),
        el('div', { class: 'field' }, el('label', {}, 'Source'), sourceSelect),
      ),
      el('div', { class: 'row-inline', style: { marginTop: '10px' } },
        el('div', { class: 'field' }, el('label', {}, 'Type'), typeSelect),
        el('div', { class: 'field' }, el('label', {}, 'Target provider'), providerSelect),
      ),
      el('div', { class: 'row-inline', style: { marginTop: '10px' } },
        el('div', { class: 'field' }, el('label', {}, 'Destination path'), targetInput),
        el('div', { class: 'field' }, el('label', {}, ' '), el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Start job')),
      ),
    );

    const jobAlert = el('div', { class: 'alert alert--error', hidden: true });
    jobForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      jobAlert.hidden = true;
      if (!sourceSelect.value) {
        jobAlert.textContent = 'Pick a source file first';
        jobAlert.hidden = false;
        return;
      }
      if (!targetInput.value.trim()) {
        jobAlert.textContent = 'A destination path is required';
        jobAlert.hidden = false;
        return;
      }
      try {
        await api.post('/api/admin/jobs', {
          type: typeSelect.value,
          sourceId: Number(sourceSelect.value),
          provider: providerSelect.value,
          targetPath: targetInput.value.trim(),
        });
        toast('Conversion job started', 'ok');
        refresh();
      } catch (err) {
        jobAlert.textContent = err.message;
        jobAlert.hidden = false;
      }
    });

    container.append(jobAlert, jobForm);
  }

  const list = el(
    'table',
    { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Type'), el('th', {}, 'Target'), el('th', {}, 'Progress'),
      el('th', {}, 'Status'), el('th', {}, ''),
    )),
  );
  const tbody = el('tbody');
  container.append(el('div', { class: 'table__scroll' }, list));

  panel.append(container);

  async function refresh() {
    try {
      const data = await api.get('/api/admin/jobs');
      clear(tbody);
      if (!data.jobs.length) {
        tbody.append(el('tr', {}, el('td', { colspan: '5' }, 'No jobs yet.')));
        return;
      }
      for (const job of data.jobs) {
        tbody.append(
          el(
            'tr',
            {},
            el('td', {}, job.type),
            el('td', {}, job.target_path || '—'),
            el('td', {}, `${Math.round(job.progress || 0)}%`),
            el(
              'td',
              {},
              el(
                'span',
                {
                  class: `pill ${
                    job.status === 'done' ? 'pill--ok'
                    : job.status === 'failed' ? 'pill--danger'
                    : job.status === 'running' ? 'pill--accent'
                    : ''
                  }`,
                },
                job.status,
              ),
              job.message ? el('div', { class: 'source-item__meta' }, job.message) : null,
            ),
            el(
              'td',
              {},
              job.status === 'running' || job.status === 'queued'
                ? el(
                    'button',
                    {
                      class: 'btn btn--danger btn--sm',
                      onClick: async () => {
                        await api.del(`/api/admin/jobs/${job.id}`).catch(() => {});
                        refresh();
                      },
                    },
                    'Cancel',
                  )
                : null,
            ),
          ),
        );
      }
    } catch (err) {
      clear(tbody).append(el('tr', {}, el('td', { colspan: '5' }, err.message)));
    }
  }
  refresh();
  const timer = setInterval(refresh, 3000);
  // Stop polling when the admin page is replaced.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearInterval(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('view'), { childList: true, subtree: true });
}

/* --------------------------------------------------------------- users */

async function usersPanel(panel) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Users'));
  container.append(el('p', { class: 'hint' }, 'Admins can manage the library; members can watch and download.'));

  const form = el('form', {
    style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: '18px' },
  });
  const username = el('input', { type: 'text', placeholder: 'username' });
  const password = el('input', { type: 'password', placeholder: 'password (min 8)' });
  const role = el('select', {}, el('option', { value: 'member' }, 'member'), el('option', { value: 'admin' }, 'admin'));
  const submit = el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Add user');
  form.append(username, password, role, submit);

  const alert = el('div', { class: 'alert alert--error', hidden: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alert.hidden = true;
    try {
      await api.post('/api/auth/users', {
        username: username.value.trim(),
        password: password.value,
        role: role.value,
      });
      username.value = '';
      password.value = '';
      toast('User created', 'ok');
      renderAdmin(document.getElementById('view'));
    } catch (err) {
      alert.textContent = err.message;
      alert.hidden = false;
    }
  });

  container.append(alert, form);

  try {
    const data = await api.get('/api/auth/users');
    const table = el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'ID'), el('th', {}, 'Username'), el('th', {}, 'Role'),
        el('th', {}, '2FA'), el('th', {}, 'Last login'), el('th', {}, ''),
      )),
    );
    const tbody = el('tbody');
    for (const user of data.users) {
      tbody.append(
        el(
          'tr',
          {},
          el('td', {}, String(user.id)),
          el('td', {}, user.username),
          el('td', {}, el('span', { class: `pill ${user.role === 'admin' ? 'pill--accent' : ''}` }, user.role)),
          el('td', {}, user.totp_enabled ? el('span', { class: 'pill pill--ok' }, 'On') : el('span', { class: 'pill' }, 'Off')),
          el('td', {}, (user.last_login_at || 'never').slice(0, 16)),
          el(
            'td',
            {},
            el(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              el(
                'button',
                {
                  class: 'btn btn--soft btn--sm',
                  onClick: async () => {
                    const newPassword = prompt('New password (min 8 characters):');
                    if (!newPassword) return;
                    try {
                      await api.patch(`/api/auth/users/${user.id}`, { password: newPassword });
                      toast('Password changed — that user must sign in again', 'ok');
                      renderAdmin(document.getElementById('view'));
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Reset password',
              ),
              el(
                'button',
                {
                  class: 'btn btn--danger btn--sm',
                  onClick: async () => {
                    if (!confirm(`Delete user "${user.username}"?`)) return;
                    try {
                      await api.del(`/api/auth/users/${user.id}`);
                      toast('User deleted', 'ok');
                      renderAdmin(document.getElementById('view'));
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Delete',
              ),
            ),
          ),
        ),
      );
    }
    table.append(tbody);
    container.append(el('div', { class: 'table__scroll' }, table));
  } catch (err) {
    container.append(el('p', { class: 'hint' }, err.message));
  }

  panel.append(container);
}

/* ------------------------------------------------------------ security */

async function securityPanel(panel) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Security'));
  container.append(el('p', { class: 'hint' }, 'Active sessions, blocked addresses and the audit trail.'));

  /* Sessions */
  container.append(el('h4', { style: { marginTop: '18px' } }, 'Active sessions'));
  try {
    const data = await api.get('/api/admin/sessions');
    const table = el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'User'), el('th', {}, 'IP'), el('th', {}, 'Device'),
        el('th', {}, 'Last seen'), el('th', {}, ''),
      )),
    );
    const tbody = el('tbody');
    for (const session of data.sessions) {
      tbody.append(
        el(
          'tr',
          {},
          el('td', {}, session.username || `#${session.user_id}`),
          el('td', {}, session.ip || '—'),
          el('td', { style: { fontSize: '11.5px', color: 'var(--text-faint)', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis' } }, session.user_agent || '—'),
          el('td', {}, (session.last_seen_at || '').slice(0, 16)),
          el(
            'td',
            {},
            session.revoked_at
              ? el('span', { class: 'pill' }, 'Revoked')
              : el(
                  'button',
                  {
                    class: 'btn btn--danger btn--sm',
                    onClick: async () => {
                      await api.del(`/api/admin/sessions/${session.id}`).catch(() => {});
                      toast('Session revoked', 'ok');
                      renderAdmin(document.getElementById('view'));
                    },
                  },
                  'Revoke',
                ),
          ),
        ),
      );
    }
    table.append(tbody);
    container.append(el('div', { class: 'table__scroll' }, table));
  } catch (err) {
    container.append(el('p', { class: 'hint' }, err.message));
  }

  /* IP bans */
  container.append(el('h4', { style: { marginTop: '24px' } }, 'Blocked addresses'));
  const banForm = el('form', { style: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' } });
  const banIp = el('input', { type: 'text', placeholder: '203.0.113.5' });
  const banReason = el('input', { type: 'text', placeholder: 'reason (optional)' });
  banForm.append(
    banIp,
    banReason,
    el('button', { class: 'btn btn--danger btn--sm', type: 'submit' }, 'Block'),
  );
  banForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/admin/bans', { ip: banIp.value.trim(), reason: banReason.value.trim() || null });
      toast('Address blocked', 'ok');
      renderAdmin(document.getElementById('view'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  container.append(banForm);

  try {
    const data = await api.get('/api/admin/bans');
    if (!data.bans.length) {
      container.append(el('p', { class: 'hint' }, 'No blocked addresses.'));
    } else {
      const list = el('div', { class: 'source-list' });
      for (const ban of data.bans) {
        list.append(
          el(
            'div',
            { class: 'source-item' },
            el('div', {}, el('div', { class: 'source-item__name' }, ban.ip), el('div', { class: 'source-item__meta' }, ban.reason || 'no reason')),
            el(
              'div',
              { class: 'source-item__actions' },
              el(
                'button',
                {
                  class: 'btn btn--soft btn--sm',
                  onClick: async () => {
                    await api.del(`/api/admin/bans/${encodeURIComponent(ban.ip)}`).catch(() => {});
                    toast('Address unblocked', 'ok');
                    renderAdmin(document.getElementById('view'));
                  },
                },
                'Unblock',
              ),
            ),
          ),
        );
      }
      container.append(list);
    }
  } catch { /* ignore */ }

  /* Audit log */
  container.append(el('h4', { style: { marginTop: '24px' } }, 'Audit log'));
  try {
    const data = await api.get('/api/admin/audit?limit=60');
    const table = el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'User'), el('th', {}, 'Action'), el('th', {}, 'Target'),
      )),
    );
    const tbody = el('tbody');
    for (const entry of data.entries) {
      tbody.append(
        el(
          'tr',
          {},
          el('td', {}, (entry.created_at || '').slice(0, 19)),
          el('td', {}, entry.username || '—'),
          el('td', {}, entry.action),
          el('td', { style: { fontSize: '12px', color: 'var(--text-faint)' } }, entry.target || '—'),
        ),
      );
    }
    table.append(tbody);
    container.append(el('div', { class: 'table__scroll' }, table));
  } catch (err) {
    container.append(el('p', { class: 'hint' }, err.message));
  }

  panel.append(container);
}

/* ------------------------------------------------------------ settings */

async function settingsPanel(panel, status) {
  const container = el('div', { class: 'panel panel--wide' });
  container.append(el('h3', {}, 'Server info & settings'));
  container.append(el('p', { class: 'hint' }, 'Runtime configuration and per-site preferences.'));

  const rows = [
    ['Public URL', status.publicUrl],
    ['Node version', status.nodeVersion],
    ['Uptime', `${Math.round((status.uptime || 0) / 60)} minutes`],
    ['Memory', formatBytes(status.memory || 0)],
    ['TMDB integration', status.tmdb ? 'Configured' : 'Not configured (set TMDB_API_KEY)'],
    ['ffmpeg', status.ffmpeg ? 'Available' : 'Not installed'],
  ];

  const table = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Setting'), el('th', {}, 'Value'))));
  const tbody = el('tbody');
  for (const [key, value] of rows) {
    tbody.append(el('tr', {}, el('td', {}, key), el('td', {}, String(value))));
  }
  table.append(tbody);
  container.append(el('div', { class: 'table__scroll' }, table));

  // Editable settings
  container.append(el('h4', { style: { marginTop: '22px' } }, 'Site settings'));
  const settingsForm = el('form', { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } });
  let current = {};
  try {
    current = (await api.get('/api/admin/settings')).settings || {};
  } catch { /* ignore */ }

  // The TMDB key lives in its own form so it is never echoed back.
  const tmdbKey = el('input', {
    type: 'password',
    placeholder: current.tmdb_api_key ? '•••••••• (a key is saved)' : 'Paste your TMDB API key',
    autocomplete: 'off',
  });
  const tmdbStatus = current.tmdb_api_key
    ? el('span', { class: 'pill pill--ok' }, icon('check', { size: 12 }), 'Saved')
    : el('span', { class: 'pill pill--warn' }, icon('info', { size: 12 }), 'Not set');
  const tmdbForm = el(
    'form',
    { style: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '18px' } },
    el(
      'div',
      { class: 'field', style: { flex: '1', minWidth: '240px', marginBottom: '0' } },
      el('label', {}, 'TMDB API key'),
      tmdbKey,
      el('div', { class: 'field__hint' }, 'Get a free key at themoviedb.org/settings/api — it auto-fills every movie you add.'),
    ),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingBottom: '2px' } },
      tmdbStatus,
      el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Save key'),
    ),
  );
  tmdbForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.put('/api/admin/tmdb/key', { apiKey: tmdbKey.value.trim() });
      toast(tmdbKey.value.trim() ? 'TMDB key saved' : 'TMDB key cleared', 'ok');
      renderAdmin(document.getElementById('view'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  container.append(tmdbForm);

  const defs = [
    { key: 'siteTitle', label: 'Site title', type: 'text' },
    { key: 'defaultQuality', label: 'Preferred quality', type: 'text' },
    { key: 'theme', label: 'Default theme', type: 'select', options: ['dark', 'light'] },
    { key: 'showContinueRow', label: 'Show Continue Watching', type: 'select', options: ['true', 'false'] },
    { key: 'allowDownloads', label: 'Allow downloads', type: 'select', options: ['true', 'false'] },
  ];
  const inputs = new Map();
  for (const def of defs) {
    let input;
    if (def.type === 'select') {
      input = el('select', {}, def.options.map((o) => el('option', { value: o, selected: String(current[def.key] ?? '') === o }, o)));
    } else {
      input = el('input', { type: def.type, value: current[def.key] ?? '' });
    }
    inputs.set(def.key, input);
    settingsForm.append(el('div', { class: 'field' }, el('label', {}, def.label), input));
  }
  settingsForm.append(
    el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } },
      el('button', { class: 'btn btn--accent btn--sm', type: 'submit' }, 'Save settings'),
    ),
  );
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {};
    for (const [key, input] of inputs) payload[key] = input.value;
    try {
      await api.put('/api/admin/settings', payload);
      toast('Settings saved', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  container.append(settingsForm);

  const tips = el('div', { style: { marginTop: '18px' } });
  tips.append(el('h3', {}, 'Notes'));
  tips.append(
    el(
      'ul',
      { style: { color: 'var(--text-muted)', fontSize: '13.5px', lineHeight: '1.8', paddingLeft: '18px' } },
      el('li', {}, 'Telegram can only handle files under 50 MB (upload) / 20 MB (download) — use R2 or Drive for full movies.'),
      el('li', {}, 'MEGA free accounts are capped at 20 GB of storage each — add several instances to get more.'),
      el('li', {}, 'Google Drive service accounts have 15 TB shared across all service-account users.'),
      el('li', {}, 'Cloudflare R2 is the best option for large libraries — it supports real range requests and egress-free serving.'),
      el('li', {}, 'A .zip uploaded as a source is browsable: the player lists the files inside and streams the one you pick.'),
      el('li', {}, 'An .m3u8 uploaded as a source is played as an HLS stream, with all segments proxied through the server.'),
      el('li', {}, 'Run the server behind Nginx for HTTPS; set TRUST_PROXY=1 and PUBLIC_URL=https://your-domain.'),
    ),
  );
  container.append(tips);
  panel.append(container);
}
