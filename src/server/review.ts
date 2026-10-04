import fs from 'node:fs';
import path from 'node:path';
import type { FileDiff } from '../types/index.js';
import type { Db } from './db.js';
import { captureDiff, parsePatch, type CapturedDiff } from './diff/index.js';
import { isGitRepo } from './git.js';
import { getPort } from './paths.js';

export interface StartReviewInput {
  repoPath: string;
  /** Diff selector; defaults to "staged" (`git diff --cached`). */
  selector?: string;
  title?: string;
}

export interface CaptureResult {
  reviewId: number;
  snapshotId: number;
  seq: number;
  url: string;
}

/** Always creates a NEW review (reviews are cheap/disposable) and freezes snapshot 1. */
export async function startReview(db: Db, input: StartReviewInput): Promise<CaptureResult> {
  const repoPath = canonicalizeRepo(input.repoPath);
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  const selector = input.selector ?? 'staged';
  const title = input.title ?? null;

  // git runs async, BEFORE the synchronous transaction.
  const captured = await captureDiff(repoPath, selector);
  const now = new Date().toISOString();

  const run = db.transaction((): CaptureResult => {
    const res = db
      .prepare(
        'INSERT INTO review (repo_path, selector, title, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(repoPath, selector, title, 'active', now);
    const reviewId = Number(res.lastInsertRowid);
    const snapshotId = insertSnapshot(db, reviewId, 1, selector, captured, now);
    return { reviewId, snapshotId, seq: 1, url: reviewUrl(reviewId) };
  });
  return run();
}

/** Freezes a fresh snapshot (seq+1) on an existing review — starts empty of comments. */
export async function createSnapshot(db: Db, reviewId: number): Promise<CaptureResult> {
  const review = db
    .prepare('SELECT repo_path, selector FROM review WHERE id = ?')
    .get(reviewId) as { repo_path: string; selector: string } | undefined;
  if (!review) throw new Error(`no such review: ${reviewId}`);

  const captured = await captureDiff(review.repo_path, review.selector);
  const now = new Date().toISOString();

  const run = db.transaction((): CaptureResult => {
    const { n: seq } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM snapshot WHERE review_id = ?')
      .get(reviewId) as { n: number };
    const snapshotId = insertSnapshot(db, reviewId, seq, review.selector, captured, now);
    return { reviewId, snapshotId, seq, url: reviewUrl(reviewId) };
  });
  return run();
}

function insertSnapshot(
  db: Db,
  reviewId: number,
  seq: number,
  selector: string,
  captured: CapturedDiff,
  now: string,
): number {
  const insertions = captured.files.reduce((s, f) => s + f.meta.additions, 0);
  const deletions = captured.files.reduce((s, f) => s + f.meta.deletions, 0);

  const res = db
    .prepare(
      `INSERT INTO snapshot
         (review_id, seq, base_oid, head_oid, selector, raw_diff, files_changed, insertions, deletions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reviewId,
      seq,
      captured.baseOid,
      captured.headOid,
      selector,
      captured.rawDiff,
      captured.files.length,
      insertions,
      deletions,
      now,
    );
  const snapshotId = Number(res.lastInsertRowid);

  const insertFile = db.prepare(
    `INSERT INTO snapshot_file
       (snapshot_id, old_path, new_path, change_type, file_diff, binary, too_large, additions, deletions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of captured.files) {
    insertFile.run(
      snapshotId,
      f.meta.oldPath,
      f.meta.newPath,
      f.meta.changeType,
      f.text,
      f.meta.binary ? 1 : 0,
      f.meta.tooLarge ? 1 : 0,
      f.meta.additions,
      f.meta.deletions,
    );
  }
  return snapshotId;
}

export interface ReviewSummary {
  id: number;
  repoPath: string;
  selector: string;
  title: string | null;
  status: string;
  createdAt: string;
  snapshots: number;
  latestSeq: number | null;
}

export interface SnapshotSummary {
  id: number;
  seq: number;
  createdAt: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ReviewDetail {
  id: number;
  repoPath: string;
  selector: string;
  title: string | null;
  status: string;
  createdAt: string;
  repoExists: boolean; // false when the repo has moved/been deleted
  snapshots: SnapshotSummary[];
}

// Local until getReviewDetail migrates to the reviews DAO (which has its own copy).
interface ReviewRow {
  id: number;
  repo_path: string;
  selector: string;
  title: string | null;
  status: string;
  created_at: string;
}

/** Review metadata + its snapshots (ascending seq), plus whether the repo still exists on disk. */
export function getReviewDetail(db: Db, reviewId: number): ReviewDetail {
  const r = db.prepare('SELECT * FROM review WHERE id = ?').get(reviewId) as ReviewRow | undefined;
  if (!r) throw new Error(`no such review: ${reviewId}`);
  const snaps = db
    .prepare(
      'SELECT id, seq, created_at, files_changed, insertions, deletions FROM snapshot WHERE review_id = ? ORDER BY seq',
    )
    .all(reviewId) as {
    id: number;
    seq: number;
    created_at: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  }[];
  return {
    id: r.id,
    repoPath: r.repo_path,
    selector: r.selector,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    repoExists: fs.existsSync(r.repo_path),
    snapshots: snaps.map((s) => ({
      id: s.id,
      seq: s.seq,
      createdAt: s.created_at,
      filesChanged: s.files_changed,
      insertions: s.insertions,
      deletions: s.deletions,
    })),
  };
}

export interface SnapshotStructured {
  snapshotId: number;
  seq: number;
  selector: string;
  baseOid: string | null;
  headOid: string | null;
  files: FileDiff[];
}

/** The structured (files → hunks → lines) diff for a snapshot, parsed from its frozen text. */
export function getSnapshotStructured(db: Db, snapshotId: number): SnapshotStructured {
  const s = db
    .prepare('SELECT seq, selector, base_oid, head_oid, raw_diff FROM snapshot WHERE id = ?')
    .get(snapshotId) as
    | { seq: number; selector: string; base_oid: string | null; head_oid: string | null; raw_diff: string }
    | undefined;
  if (!s) throw new Error(`no such snapshot: ${snapshotId}`);
  return {
    snapshotId,
    seq: s.seq,
    selector: s.selector,
    baseOid: s.base_oid,
    headOid: s.head_oid,
    files: parsePatch(s.raw_diff),
  };
}

/** The frozen diff text for a snapshot, or a single file's slice when `file` is given. */
export function getSnapshotDiff(db: Db, snapshotId: number, file?: string): string {
  if (file) {
    const row = db
      .prepare('SELECT file_diff FROM snapshot_file WHERE snapshot_id = ? AND (new_path = ? OR old_path = ?)')
      .get(snapshotId, file, file) as { file_diff: string } | undefined;
    if (!row) throw new Error(`no such file in snapshot ${snapshotId}: ${file}`);
    return row.file_diff;
  }
  const row = db.prepare('SELECT raw_diff FROM snapshot WHERE id = ?').get(snapshotId) as
    | { raw_diff: string }
    | undefined;
  if (!row) throw new Error(`no such snapshot: ${snapshotId}`);
  return row.raw_diff;
}

/** Resolve to a canonical absolute path (symlinks resolved); throw if it doesn't exist. */
function canonicalizeRepo(repoPath: string): string {
  try {
    return fs.realpathSync(path.resolve(repoPath));
  } catch {
    throw new Error(`repo path not found: ${repoPath}`);
  }
}

function reviewUrl(reviewId: number): string {
  return `http://localhost:${getPort()}/review/${reviewId}`;
}
