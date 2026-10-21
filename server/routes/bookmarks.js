import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { one, q, run } from '../db.js';

export const bookmarksRouter = Router();

/**
 * GET /api/movies/:id/bookmarks
 * The current user's bookmarks inside one movie.
 */
bookmarksRouter.get('/:id/bookmarks', requireAuth, (req, res) => {
  const rows = q(
    'SELECT * FROM bookmarks WHERE user_id = ? AND movie_id = ? ORDER BY position',
    req.user.id,
    Number(req.params.id),
  );
  res.json({ bookmarks: rows });
});

/**
 * POST /api/movies/:id/bookmarks
 * Save a bookmark at a playback position.
 */
bookmarksRouter.post('/:id/bookmarks', requireAuth, (req, res) => {
  const { position, label, note, sourceId } = req.body || {};
  const movieId = Number(req.params.id);
  if (!one('SELECT id FROM movies WHERE id = ?', movieId)) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 0) {
    return res.status(400).json({ error: 'A valid position is required' });
  }
  const result = run(
    `INSERT INTO bookmarks (user_id, movie_id, source_id, position, label, note)
     VALUES (?,?,?,?,?,?)`,
    req.user.id,
    movieId,
    sourceId ?? null,
    pos,
    label ?? null,
    note ?? null,
  );
  res.status(201).json({
    bookmark: one('SELECT * FROM bookmarks WHERE id = ?', Number(result.lastInsertRowid)),
  });
});

/** DELETE /api/movies/:id/bookmarks/:bookmarkId */
bookmarksRouter.delete('/:id/bookmarks/:bookmarkId', requireAuth, (req, res) => {
  run(
    'DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND movie_id = ?',
    Number(req.params.bookmarkId),
    req.user.id,
    Number(req.params.id),
  );
  res.json({ ok: true });
});
