import { config } from './config.js';

// node:sqlite is built in from Node 22.5 (behind --experimental-sqlite on
// 22.x) and enabled by default from Node 23.4 onwards.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    '\n[db] node:sqlite is not available in this Node.js build.\n' +
      '  Node 22.5 or newer is required. On Node 22.x, start the server with:\n' +
      '    node --experimental-sqlite server/index.js\n',
  );
  process.exit(1);
}

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Add a column to an existing table if it is missing.
 * `CREATE TABLE IF NOT EXISTS` does not add columns to a table that already
 * exists, so upgrades need explicit migrations.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.length) return false;
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migration: added ${table}.${column}`);
  return true;
}

/** Run a migration exactly once, tracked in the `migrations` table. */
function migrate(name, fn) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
  const done = db.prepare('SELECT name FROM migrations WHERE name = ?').get(name);
  if (done) return;
  db.exec('BEGIN');
  try {
    fn();
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, datetime('now'))").run(name);
    db.exec('COMMIT');
    console.log(`[db] migration applied: ${name}`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`[db] migration FAILED: ${name} — ${err.message}`);
    throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  display_name  TEXT,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Storage backends. One row per configured account/bucket, so you can run
-- several Cloudflare R2 buckets or several MEGA accounts side by side.
CREATE TABLE IF NOT EXISTS provider_instances (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS movies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  title_lower  TEXT NOT NULL,
  year         INTEGER,
  overview     TEXT,
  tagline      TEXT,
  runtime      INTEGER,
  rating       REAL,
  genres       TEXT NOT NULL DEFAULT '[]',
  poster_url   TEXT,
  backdrop_url TEXT,
  tmdb_id      INTEGER,
  imdb_id      TEXT,
  cast        TEXT NOT NULL DEFAULT '[]',
  crew        TEXT NOT NULL DEFAULT '[]',
  keywords    TEXT NOT NULL DEFAULT '[]',
  trailer_url TEXT,
  release_date TEXT,
  vote_count  INTEGER,
  featured     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movies_title_lower ON movies(title_lower);

CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id   INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  file_name  TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  mime       TEXT,
  quality    TEXT,
  label      TEXT,
  -- 'file' (normal) | 'zip' (entry inside an archive) | 'hls' (playlist)
  kind       TEXT NOT NULL DEFAULT 'file',
  container  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, remote_path)
);

CREATE INDEX IF NOT EXISTS idx_sources_movie ON sources(movie_id);

CREATE TABLE IF NOT EXISTS subtitles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT 'en',
  label       TEXT,
  mime        TEXT NOT NULL DEFAULT 'text/vtt',
  UNIQUE(provider, remote_path)
);

CREATE INDEX IF NOT EXISTS idx_subtitles_source ON subtitles(source_id);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id     INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  source_id    INTEGER,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Server-side login sessions, so a session can be revoked remotely.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  revoked_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

-- Every meaningful action, for the admin audit trail.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- Background jobs (ffmpeg remux/transcode, scans).
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  user_id     INTEGER,
  source_id   INTEGER,
  movie_id    INTEGER,
  provider    TEXT,
  target_path TEXT,
  progress    REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  message     TEXT,
  output      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Per-user bookmarks inside a video.
CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id   INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  source_id  INTEGER,
  position   REAL NOT NULL,
  label      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, movie_id);

-- Blocked IP addresses (admin-managed).
CREATE TABLE IF NOT EXISTS ip_bans (
  ip        TEXT PRIMARY KEY,
  reason    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------- migrations
// Schema upgrades for databases created by an older version.

migrate('001-user-totp', () => {
  addColumnIfMissing('users', 'totp_secret', 'TEXT');
  addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
});

migrate('002-source-kind', () => {
  addColumnIfMissing('sources', 'kind', "TEXT NOT NULL DEFAULT 'file'");
  addColumnIfMissing('sources', 'container', 'TEXT');
});

// Older rows that point at a provider instance by its old id still work,
// because the seeded instance ids match the old provider ids.
migrate('003-provider-instances', () => {});

migrate('004-session-index', () => {
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)');
});

migrate('005-job-duration', () => {
  addColumnIfMissing('jobs', 'duration_sec', 'REAL NOT NULL DEFAULT 0');
});

migrate('006-provider-source', () => {
  // Remembers whether an instance was seeded from .env, so the two can be
  // distinguished from one an admin created by hand.
  addColumnIfMissing('provider_instances', 'source', "TEXT NOT NULL DEFAULT 'admin'");
});

migrate('007-movie-metadata', () => {
  addColumnIfMissing('movies', 'cast', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('movies', 'crew', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('movies', 'keywords', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('movies', 'trailer_url', 'TEXT');
  addColumnIfMissing('movies', 'release_date', 'TEXT');
  addColumnIfMissing('movies', 'vote_count', 'INTEGER');
});

migrate('008-skip-markers', () => {
  // Where the intro ends and the credits begin, so the player can offer
  // "skip intro" / "skip credits".
  addColumnIfMissing('movies', 'skip_intro', 'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('movies', 'skip_credits', 'REAL NOT NULL DEFAULT 0');
});

/** Small query helper: `q('select * from users where id = ?', id)` */
export function q(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** Fetch a single row (or undefined). */
export function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}

/** Execute a write statement; returns `{ changes, lastInsertRowid }`. */
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
