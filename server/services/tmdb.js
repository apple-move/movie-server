import { config } from '../config.js';
import { one, q, run } from '../db.js';

const BASE = 'https://api.themoviedb.org/3';

/**
 * Read a server setting.
 */
export function getSetting(key, fallback = null) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key),
    JSON.stringify(value),
  );
  return value;
}

/**
 * The TMDB API key.
 *
 * It can be set in the Admin panel (stored in the database) or in `.env`.
 * The database value wins, so a key can be rotated without a restart.
 */
export function getApiKey() {
  const fromDb = getSetting('tmdb_api_key', '');
  if (fromDb) return String(fromDb);
  return config.tmdb.apiKey || '';
}

/**
 * Thin TMDB client used to enrich library entries with poster art,
 * synopsis, genres and ratings.
 */
export const tmdb = {
  isConfigured() {
    return Boolean(getApiKey());
  },

  async request(path, params = {}) {
    const key = getApiKey();
    if (!key) throw new Error('No TMDB API key configured');
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set('api_key', key);
    url.searchParams.set('language', config.tmdb.language);
    for (const [key2, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key2, String(value));
    }
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error('The TMDB API key was rejected');
      throw new Error(`TMDB request failed: ${res.status}`);
    }
    return res.json();
  },

  /** Search for a movie by title. */
  async search(title, year) {
    const data = await this.request('/search/movie', { query: title, year, include_adult: 'false' });
    return data.results || [];
  },

  /** Full details for a TMDB movie id. */
  async details(tmdbId) {
    return this.request(`/movie/${tmdbId}`, { append_to_response: 'credits,videos' });
  },

  /** TMDB image URL builder. */
  image(path, size = 'w780') {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    return `https://image.tmdb.org/t/p/${size}${path}`;
  },
};

/**
 * Score a TMDB search result against the title/year we are looking for.
 * TMDB orders results by popularity, so `results[0]` is frequently the
 * wrong film ("It" → "IT" → "Cars").
 */
export function scoreResult(result, title, year) {
  const wantedRaw = String(title || '').toLowerCase();
  const gotRaw = String(result.title || '').toLowerCase();
  const wanted = wantedRaw.replace(/[^a-z0-9]/g, '');
  const got = gotRaw.replace(/[^a-z0-9]/g, '');
  if (!wanted || !got) return 0;

  let score = 0;
  if (got === wanted) score += 100;
  else if (got.startsWith(wanted) || wanted.startsWith(got)) score += 60;
  else if (got.includes(wanted) || wanted.includes(got)) score += 35;
  else {
    // Word overlap, so "Blade Runner" still matches "Blade Runner 2049".
    const a = new Set(wantedRaw.split(/[^a-z0-9]+/).filter(Boolean));
    const b = new Set(gotRaw.split(/[^a-z0-9]+/).filter(Boolean));
    if (a.size && b.size) {
      let shared = 0;
      for (const word of a) if (b.has(word)) shared += 1;
      score += (shared / a.size) * 25;
    }
  }

  const gotYear = Number(String(result.release_date || '').slice(0, 4));
  if (year && gotYear) {
    const diff = Math.abs(gotYear - year);
    if (diff === 0) score += 30;
    else if (diff <= 1) score += 20;
    else if (diff <= 3) score += 8;
    else score -= 15;
  }
  return score;
}

/**
 * Fetch everything about a movie in one go: metadata, cast, crew, the
 * trailer and the release date. This is what the Admin panel uses when a
 * movie is added, so a new entry is complete straight away.
 */
export async function fetchFullDetails(tmdbId) {
  const details = await tmdb.details(tmdbId);
  const credits = details.credits || {};

  const trailer =
    (details.videos?.results || []).find(
      (v) => v.type === 'Trailer' && v.site === 'YouTube' && v.official !== false,
    ) ||
    (details.videos?.results || []).find((v) => v.type === 'Trailer') ||
    null;

  return {
    id: details.id,
    imdbId: details.imdb_id || null,
    title: details.title,
    originalTitle: details.original_title || details.title,
    tagline: details.tagline || null,
    overview: details.overview || null,
    year: details.release_date ? Number(details.release_date.slice(0, 4)) : null,
    releaseDate: details.release_date || null,
    runtime: details.runtime ?? null,
    rating: details.vote_average ?? null,
    voteCount: details.vote_count ?? null,
    status: details.status || null,
    genres: (details.genres || []).map((g) => g.name),
    keywords: (details.keywords?.keywords || []).map((k) => k.name).slice(0, 12),
    poster: tmdb.image(details.poster_path, 'w500'),
    backdrop: tmdb.image(details.backdrop_path, 'w1280'),
    logo: tmdb.image(details.logo_path, 'w300'),
    cast: (credits.cast || []).slice(0, 20).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character || null,
      image: tmdb.image(c.profile_path, 'w185'),
    })),
    crew: (credits.crew || [])
      .filter((c) => ['Director', 'Writer', 'Producer', 'Executive Producer'].includes(c.job))
      .slice(0, 12)
      .map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        image: tmdb.image(c.profile_path, 'w185'),
      })),
    trailer: trailer
      ? {
          key: trailer.key,
          name: trailer.name,
          site: trailer.site,
          url: `https://www.youtube.com/watch?v=${trailer.key}`,
        }
      : null,
    collection: details.belongs_to_collection
      ? {
          name: details.belongs_to_collection.name,
          poster: tmdb.image(details.belongs_to_collection.poster_path, 'w300'),
        }
      : null,
  };
}

/**
 * Look a movie up on TMDB and write the metadata onto the local record.
 */
export async function enrichMovie(movieId, { overwrite = false } = {}) {
  if (!tmdb.isConfigured()) throw new Error('No TMDB API key configured');
  const movie = one('SELECT * FROM movies WHERE id = ?', movieId);
  if (!movie) throw new Error('Movie not found');

  let results = await tmdb.search(movie.title, movie.year);
  // If the year filter was too strict, retry without it.
  if (!results.length && movie.year) {
    results = await tmdb.search(movie.title);
  }
  if (!results.length) throw new Error(`No TMDB match for "${movie.title}"`);

  const best = results
    .map((r) => ({ result: r, score: scoreResult(r, movie.title, movie.year) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score <= 0) {
    throw new Error(`No confident TMDB match for "${movie.title}"`);
  }

  const details = await tmdb.details(best.result.id);

  const genres = (details.genres || []).map((g) => g.name);
  const poster = tmdb.image(details.poster_path, 'w500');
  const backdrop = tmdb.image(details.backdrop_path, 'w1280');
  const runtime = details.runtime ?? null;
  const rating = details.vote_average ?? null;
  const overview = details.overview || movie.overview;
  const tagline = details.tagline || movie.tagline;

  const fields = [];
  const params = [];
  const set = (col, val) => {
    if (val === null || val === undefined || val === '') return;
    if (!overwrite && movie[col]) return;
    fields.push(`${col} = ?`);
    params.push(val);
  };

  set('overview', overview);
  set('tagline', tagline);
  set('runtime', runtime);
  set('rating', rating);
  set('poster_url', poster);
  set('backdrop_url', backdrop);
  set('tmdb_id', details.id);
  if (genres.length && (overwrite || !safeGenres(movie.genres).length)) {
    fields.push('genres = ?');
    params.push(JSON.stringify(genres));
  }

  if (fields.length) {
    fields.push("updated_at = datetime('now')");
    params.push(movie.id);
    run(`UPDATE movies SET ${fields.join(', ')} WHERE id = ?`, ...params);
  }

  return { ...movie, genres, poster, backdrop };
}

function safeGenres(value) {
  try {
    return JSON.parse(value ?? '[]');
  } catch {
    return [];
  }
}
