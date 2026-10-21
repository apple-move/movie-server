import { isVideoName, isSubtitleName, isImageName, isArchiveName, isPlaylistName } from '../lib/mime.js';
import { guessFromFilename } from '../routes/upload.js';
import { detectLanguage } from '../lib/subtitle.js';
import { one, run } from '../db.js';
import { getProvider } from '../providers/index.js';

/**
 * Scan a storage provider and import everything it finds into the library.
 *
 * Folder layout that is auto-detected:
 *   /Movies/Inception (2010)/Inception.2010.1080p.mkv
 *   /Movies/Inception (2010)/poster.jpg
 *   /Movies/Inception (2010)/Inception.en.srt
 */
export async function scanProvider(providerId, { prefix = '', autoCreate = true } = {}) {
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) {
    throw new Error(`${provider.name} is not configured`);
  }

  const files = await provider.list(prefix);
  const stats = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    videos: 0,
    subtitles: 0,
    posters: 0,
    archives: 0,
    playlists: 0,
  };

  /** folder key -> movie record */
  const buckets = new Map();
  for (const file of files) {
    stats.scanned += 1;
    const folder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
    if (!buckets.has(folder)) {
      buckets.set(folder, { videos: [], subs: [], images: [], archives: [], playlists: [] });
    }
    const bucket = buckets.get(folder);
    if (isVideoName(file.name)) {
      bucket.videos.push(file);
      stats.videos += 1;
    } else if (isSubtitleName(file.name)) {
      bucket.subs.push(file);
      stats.subtitles += 1;
    } else if (isImageName(file.name)) {
      bucket.images.push(file);
      stats.posters += 1;
    } else if (isArchiveName(file.name)) {
      bucket.archives.push(file);
      stats.archives += 1;
    } else if (isPlaylistName(file.name)) {
      bucket.playlists.push(file);
      stats.playlists += 1;
    }
  }

  for (const [folder, bucket] of buckets) {
    // A folder with no direct video can still hold an archive or a playlist.
    if (bucket.videos.length === 0 && bucket.archives.length === 0 && bucket.playlists.length === 0) {
      stats.skipped += 1;
      continue;
    }

    // The "primary" file decides how the title is guessed.
    const primary = bucket.videos[0] || bucket.archives[0] || bucket.playlists[0];
    const guess = guessFromFilename(primary.name);
    const folderName = folder.split('/').filter(Boolean).pop() || '';
    const folderGuess = guessFromFilename(folderName);

    let title = guess.title || folderGuess.title || primary.name;
    let year = guess.year || folderGuess.year || null;
    if (folderGuess.title && (!guess.title || guess.title.length < folderGuess.title.length)) {
      title = folderGuess.title;
    }

    let movie = one('SELECT * FROM movies WHERE title_lower = ? AND (year IS ? OR ? IS NULL)', title.toLowerCase(), year, year);
    if (!movie) {
      if (!autoCreate) {
        stats.skipped += 1;
        continue;
      }
      const created = run(
        `INSERT INTO movies (title, title_lower, year, genres) VALUES (?,?,?,?)`,
        title,
        title.toLowerCase(),
        year,
        JSON.stringify([]),
      );
      movie = one('SELECT * FROM movies WHERE id = ?', Number(created.lastInsertRowid));
      stats.created += 1;
    } else {
      stats.updated += 1;
    }

    for (const video of bucket.videos) {
      const existing = one(
        'SELECT id FROM sources WHERE provider = ? AND remote_path = ?',
        providerId,
        video.path,
      );
      if (!existing) {
        // Derive the quality from THIS file, not from the first one in the folder.
        const videoGuess = guessFromFilename(video.name);
        run(
          `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind)
           VALUES (?,?,?,?,?,?,?,?,'file')`,
          movie.id,
          providerId,
          video.path,
          video.name,
          video.size,
          video.mime,
          videoGuess.quality || guess.quality,
          video.name,
        );
      }
    }

    // Archives (zip/rar/7z) become "zip" sources — the player streams the
    // movie entry straight out of the archive.
    for (const archive of bucket.archives) {
      const existing = one(
        'SELECT id FROM sources WHERE provider = ? AND remote_path = ?',
        providerId,
        archive.path,
      );
      if (!existing) {
        run(
          `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind, container)
           VALUES (?,?,?,?,?,?,?,?,'zip',?)`,
          movie.id,
          providerId,
          archive.path,
          archive.name,
          archive.size,
          archive.mime,
          guess.quality,
          archive.name,
          'zip',
        );
      }
    }

    // HLS playlists become "hls" sources.
    for (const playlist of bucket.playlists) {
      const existing = one(
        'SELECT id FROM sources WHERE provider = ? AND remote_path = ?',
        providerId,
        playlist.path,
      );
      if (!existing) {
        run(
          `INSERT INTO sources (movie_id, provider, remote_path, file_name, size, mime, quality, label, kind)
           VALUES (?,?,?,?,?,?,?,?,'hls')`,
          movie.id,
          providerId,
          playlist.path,
          playlist.name,
          playlist.size,
          playlist.mime,
          guess.quality,
          playlist.name,
        );
      }
    }

    // Subtitles belong to the video whose name they match (same base name),
    // not to whichever file happens to be largest.
    const sourceFor = (subtitleName) => {
      const base = subtitleName.replace(/\.(srt|vtt|ass|ssa|sub)$/i, '').replace(/\.[a-z]{2,3}$/i, '');
      const match = bucket.videos.find((v) => {
        const vBase = v.name.replace(/\.[^.]+$/, '').replace(/\.[a-z]{2,3}$/i, '');
        return vBase.toLowerCase() === base.toLowerCase();
      });
      const target = match || bucket.videos[0];
      if (!target) return null;
      return one(
        'SELECT id FROM sources WHERE provider = ? AND remote_path = ?',
        providerId,
        target.path,
      );
    };

    for (const sub of bucket.subs) {
      const source = sourceFor(sub.name);
      if (!source) continue;
      const lang = detectLanguage(sub.name);
      const existing = one(
        'SELECT id FROM subtitles WHERE provider = ? AND remote_path = ?',
        providerId,
        sub.path,
      );
      if (!existing) {
        run(
          `INSERT INTO subtitles (source_id, provider, remote_path, language, label, mime)
           VALUES (?,?,?,?,?,?)`,
          source.id,
          providerId,
          sub.path,
          lang,
          lang.toUpperCase(),
          sub.name.toLowerCase().endsWith('.vtt') ? 'text/vtt' : 'application/x-subrip',
        );
      }
    }

    // Poster: prefer a file named poster.*, otherwise the first image.
    const poster =
      bucket.images.find((i) => /poster/i.test(i.name)) || bucket.images[0];
    if (poster && !movie.poster_url) {
      const source = one(
        'SELECT id FROM sources WHERE movie_id = ? AND provider = ? ORDER BY size DESC LIMIT 1',
        movie.id,
        providerId,
      );
      if (source) {
        run(
          'UPDATE movies SET poster_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
          `api://image?provider=${encodeURIComponent(providerId)}&path=${encodeURIComponent(poster.path)}`,
          movie.id,
        );
      }
    }  }

  return stats;
}

/** Serve images stored inside a provider (posters, backdrops). */
export async function readProviderImage(providerId, remotePath) {
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) throw new Error(`${provider.name} is not configured`);
  const upstream = await provider.createReadStream(remotePath, {});
  const chunks = [];
  let total = 0;
  for await (const chunk of upstream) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) {
      upstream.destroy?.();
      throw new Error('Image is too large to proxy');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Hard cap so a huge "image" cannot exhaust the server's memory. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
