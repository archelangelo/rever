import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './paths.js';

export type Db = Database.Database;

// Full schema. `IF NOT EXISTS` keeps openDb idempotent; a real migration runner
// can replace this once the schema starts changing.
const DDL = `
CREATE TABLE IF NOT EXISTS review (
  id          INTEGER PRIMARY KEY,
  repo_path   TEXT    NOT NULL,
  selector    TEXT    NOT NULL DEFAULT 'staged',
  title       TEXT,
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot (
  id             INTEGER PRIMARY KEY,
  review_id      INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  base_oid       TEXT,
  head_oid       TEXT,
  selector       TEXT    NOT NULL,
  raw_diff       TEXT    NOT NULL,
  files_changed  INTEGER NOT NULL DEFAULT 0,
  insertions     INTEGER NOT NULL DEFAULT 0,
  deletions      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  UNIQUE(review_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshot_file (
  id           INTEGER PRIMARY KEY,
  snapshot_id  INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  old_path     TEXT,
  new_path     TEXT,
  change_type  TEXT    NOT NULL,
  file_diff    TEXT    NOT NULL,
  binary       INTEGER NOT NULL DEFAULT 0,
  too_large    INTEGER NOT NULL DEFAULT 0,
  additions    INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS thread (
  id            INTEGER PRIMARY KEY,
  snapshot_id   INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',
  file_path     TEXT,
  side          TEXT,
  start_line    INTEGER,
  end_line      INTEGER,
  verdict       TEXT,
  published_at  TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comment (
  id                 INTEGER PRIMARY KEY,
  thread_id          INTEGER NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  parent_comment_id  INTEGER REFERENCES comment(id) ON DELETE CASCADE,
  author             TEXT    NOT NULL,
  body               TEXT    NOT NULL,
  published_at       TEXT,
  created_at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_snapshot_review ON snapshot(review_id, seq);
CREATE INDEX IF NOT EXISTS ix_file_snapshot   ON snapshot_file(snapshot_id);
CREATE INDEX IF NOT EXISTS ix_thread_snapshot ON thread(snapshot_id);
CREATE INDEX IF NOT EXISTS ix_comment_thread  ON comment(thread_id);
CREATE INDEX IF NOT EXISTS ix_comment_parent  ON comment(parent_comment_id);
`;

export function openDb(dbPath: string = DB_PATH): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  return db;
}
