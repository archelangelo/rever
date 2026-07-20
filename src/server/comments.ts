import type { Author, ThreadKind, ThreadSide, ThreadStatus, Verdict } from '../types/index.js';
import type { Db } from './db.js';
import { parsePatch } from './diff/index.js';

// ── Write side ─────────────────────────────────────────────────────────────────

export interface CreateThreadInput {
  snapshotId: number;
  kind: ThreadKind;
  author: Author;
  body: string; // the root comment's text (for summary threads, the overview)
  filePath?: string | null;
  side?: ThreadSide | null;
  startLine?: number | null;
  endLine?: number | null;
  verdict?: Verdict | null; // only meaningful for kind='summary'
  /** Publish immediately instead of drafting. Defaults to true for claude, false for user. */
  publish?: boolean;
}

export interface AddCommentInput {
  threadId: number;
  author: Author;
  body: string;
  parentCommentId?: number | null;
  publish?: boolean;
}

/** Create a thread and its root comment. Returns both ids. */
export function createThread(db: Db, input: CreateThreadInput): { threadId: number; commentId: number } {
  const now = new Date().toISOString();
  const publishedAt = (input.publish ?? input.author === 'claude') ? now : null;

  const run = db.transaction(() => {
    const t = db
      .prepare(
        `INSERT INTO thread
           (snapshot_id, kind, status, file_path, side, start_line, end_line, verdict, published_at, created_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.snapshotId,
        input.kind,
        input.filePath ?? null,
        input.side ?? null,
        input.startLine ?? null,
        input.endLine ?? null,
        input.verdict ?? null,
        publishedAt,
        now,
      );
    const threadId = Number(t.lastInsertRowid);
    const c = db
      .prepare(
        `INSERT INTO comment (thread_id, parent_comment_id, author, body, published_at, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
      )
      .run(threadId, input.author, input.body, publishedAt, now);
    return { threadId, commentId: Number(c.lastInsertRowid) };
  });
  return run();
}

/** Add a comment (reply) to an existing thread. */
export function addComment(db: Db, input: AddCommentInput): { commentId: number } {
  const thread = db.prepare('SELECT id FROM thread WHERE id = ?').get(input.threadId);
  if (!thread) throw new Error(`no such thread: ${input.threadId}`);

  const now = new Date().toISOString();
  const publishedAt = (input.publish ?? input.author === 'claude') ? now : null;
  const c = db
    .prepare(
      `INSERT INTO comment (thread_id, parent_comment_id, author, body, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.threadId, input.parentCommentId ?? null, input.author, input.body, publishedAt, now);
  return { commentId: Number(c.lastInsertRowid) };
}

/** Flip every draft thread + comment in the review to published, atomically. */
export function publishReview(db: Db, reviewId: number): { threads: number; comments: number } {
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const t = db
      .prepare(
        `UPDATE thread SET published_at = ?
         WHERE published_at IS NULL
           AND snapshot_id IN (SELECT id FROM snapshot WHERE review_id = ?)`,
      )
      .run(now, reviewId);
    const c = db
      .prepare(
        `UPDATE comment SET published_at = ?
         WHERE published_at IS NULL
           AND thread_id IN (
             SELECT t.id FROM thread t
             JOIN snapshot s ON s.id = t.snapshot_id
             WHERE s.review_id = ?
           )`,
      )
      .run(now, reviewId);
    return { threads: t.changes, comments: c.changes };
  });
  return run();
}

export function updateThreadStatus(db: Db, threadId: number, status: ThreadStatus): void {
  const res = db.prepare('UPDATE thread SET status = ? WHERE id = ?').run(status, threadId);
  if (res.changes === 0) throw new Error(`no such thread: ${threadId}`);
}

export function resolveThread(db: Db, threadId: number): void {
  updateThreadStatus(db, threadId, 'resolved');
}

// ── Read side: the get_review_comments bundle ────────────────────────────────────

export interface CommentDTO {
  id: number;
  parentCommentId: number | null;
  depth: number;
  author: Author;
  body: string;
  createdAt: string;
}

export interface ThreadCode {
  filePath: string;
  side: ThreadSide;
  startLine: number;
  endLine: number;
  target: string[]; // exact commented line(s)
  snippet: string; // rendered ±N-line window with markers + line numbers
}

export interface ThreadDTO {
  threadId: number;
  kind: ThreadKind;
  status: ThreadStatus;
  verdict: Verdict | null;
  filePath: string | null;
  side: ThreadSide | null;
  startLine: number | null;
  endLine: number | null;
  code: ThreadCode | null;
  comments: CommentDTO[];
}

export interface ReviewCommentsBundle {
  reviewId: number;
  snapshotId: number;
  seq: number;
  /** Latest published summary verdict on the snapshot (loop-end signal). `approve` = done. */
  verdict: Verdict | null;
  threads: ThreadDTO[];
}

export interface GetReviewCommentsOptions {
  snapshotId?: number; // default: latest snapshot of the review
  status?: ThreadStatus | 'all'; // default: 'open'
  contextRadius?: number; // default 3
}

interface ThreadRow {
  id: number;
  snapshot_id: number;
  kind: ThreadKind;
  status: ThreadStatus;
  file_path: string | null;
  side: ThreadSide | null;
  start_line: number | null;
  end_line: number | null;
  verdict: Verdict | null;
}

interface CommentRow {
  id: number;
  parent_comment_id: number | null;
  author: Author;
  body: string;
  created_at: string;
}

/** The primary agent-facing pull: published threads on a snapshot with code + comment tree. */
export function getReviewComments(
  db: Db,
  reviewId: number,
  opts: GetReviewCommentsOptions = {},
): ReviewCommentsBundle {
  const status = opts.status ?? 'open';
  const radius = opts.contextRadius ?? 3;

  const snap = (
    opts.snapshotId
      ? db.prepare('SELECT id, seq FROM snapshot WHERE id = ? AND review_id = ?').get(opts.snapshotId, reviewId)
      : db.prepare('SELECT id, seq FROM snapshot WHERE review_id = ? ORDER BY seq DESC LIMIT 1').get(reviewId)
  ) as { id: number; seq: number } | undefined;
  if (!snap) throw new Error(`no snapshot for review ${reviewId}`);

  let sql = 'SELECT * FROM thread WHERE snapshot_id = ? AND published_at IS NOT NULL';
  const params: unknown[] = [snap.id];
  if (status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at, id';
  const threadRows = db.prepare(sql).all(...params) as ThreadRow[];

  // Latest published summary verdict — independent of the status filter, so `approve` is
  // still detected even once the summary thread is resolved.
  const verdictRow = db
    .prepare(
      `SELECT verdict FROM thread
       WHERE snapshot_id = ? AND kind = 'summary' AND published_at IS NOT NULL AND verdict IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(snap.id) as { verdict: Verdict } | undefined;

  const threads = threadRows.map((t) => toThreadDTO(db, snap.id, t, radius));
  return { reviewId, snapshotId: snap.id, seq: snap.seq, verdict: verdictRow?.verdict ?? null, threads };
}

function toThreadDTO(db: Db, snapshotId: number, t: ThreadRow, radius: number): ThreadDTO {
  const commentRows = db
    .prepare('SELECT * FROM comment WHERE thread_id = ? AND published_at IS NOT NULL ORDER BY created_at, id')
    .all(t.id) as CommentRow[];

  return {
    threadId: t.id,
    kind: t.kind,
    status: t.status,
    verdict: t.verdict,
    filePath: t.file_path,
    side: t.side,
    startLine: t.start_line,
    endLine: t.end_line,
    code: buildCode(db, snapshotId, t, radius),
    comments: flattenPreorder(commentRows),
  };
}

// ── Browser read model: ALL threads on a snapshot, drafts included ───────────────

export interface UiComment {
  id: number;
  parentCommentId: number | null;
  depth: number;
  author: Author;
  body: string;
  published: boolean;
  createdAt: string;
}

export interface UiThread {
  threadId: number;
  kind: ThreadKind;
  status: ThreadStatus;
  verdict: Verdict | null;
  filePath: string | null;
  side: ThreadSide | null;
  startLine: number | null;
  endLine: number | null;
  published: boolean;
  comments: UiComment[];
}

interface FullThreadRow {
  id: number;
  kind: ThreadKind;
  status: ThreadStatus;
  verdict: Verdict | null;
  file_path: string | null;
  side: ThreadSide | null;
  start_line: number | null;
  end_line: number | null;
  published_at: string | null;
}

interface FullCommentRow {
  id: number;
  parent_comment_id: number | null;
  author: Author;
  body: string;
  published_at: string | null;
  created_at: string;
}

/** Every thread on a snapshot (draft + published, all statuses) for the review UI. */
export function getSnapshotThreads(db: Db, snapshotId: number): UiThread[] {
  const threads = db
    .prepare(
      `SELECT id, kind, status, verdict, file_path, side, start_line, end_line, published_at
       FROM thread WHERE snapshot_id = ? ORDER BY created_at, id`,
    )
    .all(snapshotId) as FullThreadRow[];

  return threads.map((t) => {
    const rows = db
      .prepare(
        'SELECT id, parent_comment_id, author, body, published_at, created_at FROM comment WHERE thread_id = ? ORDER BY created_at, id',
      )
      .all(t.id) as FullCommentRow[];
    return {
      threadId: t.id,
      kind: t.kind,
      status: t.status,
      verdict: t.verdict,
      filePath: t.file_path,
      side: t.side,
      startLine: t.start_line,
      endLine: t.end_line,
      published: t.published_at != null,
      comments: uiFlattenPreorder(rows),
    };
  });
}

function uiFlattenPreorder(rows: FullCommentRow[]): UiComment[] {
  const byParent = new Map<number | null, FullCommentRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.parent_comment_id) ?? [];
    list.push(r);
    byParent.set(r.parent_comment_id, list);
  }
  const out: UiComment[] = [];
  const visit = (parentId: number | null, depth: number): void => {
    for (const r of byParent.get(parentId) ?? []) {
      out.push({
        id: r.id,
        parentCommentId: r.parent_comment_id,
        depth,
        author: r.author,
        body: r.body,
        published: r.published_at != null,
        createdAt: r.created_at,
      });
      visit(r.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** DFS pre-order flatten: each comment immediately followed by its subtree; siblings by created_at. */
function flattenPreorder(rows: CommentRow[]): CommentDTO[] {
  const byParent = new Map<number | null, CommentRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.parent_comment_id) ?? [];
    list.push(r);
    byParent.set(r.parent_comment_id, list);
  }
  const out: CommentDTO[] = [];
  const visit = (parentId: number | null, depth: number): void => {
    for (const r of byParent.get(parentId) ?? []) {
      out.push({
        id: r.id,
        parentCommentId: r.parent_comment_id,
        depth,
        author: r.author,
        body: r.body,
        createdAt: r.created_at,
      });
      visit(r.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** Extract the target line(s) + a ±radius window from the frozen file diff. */
function buildCode(db: Db, snapshotId: number, t: ThreadRow, radius: number): ThreadCode | null {
  if (!t.file_path || !t.side || t.start_line == null || t.end_line == null) return null;

  const row = db
    .prepare('SELECT file_diff FROM snapshot_file WHERE snapshot_id = ? AND (new_path = ? OR old_path = ?)')
    .get(snapshotId, t.file_path, t.file_path) as { file_diff: string } | undefined;
  if (!row) return null;

  const [fd] = parsePatch(row.file_diff);
  if (!fd) return null;

  const lines = fd.hunks.flatMap((h) => h.lines);
  const sideLine = (l: (typeof lines)[number]) => (t.side === 'new' ? l.newLine : l.oldLine);
  const hits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => {
      const n = sideLine(l);
      return n != null && n >= t.start_line! && n <= t.end_line!;
    });

  const base = { filePath: t.file_path, side: t.side, startLine: t.start_line, endLine: t.end_line };
  if (hits.length === 0) return { ...base, target: [], snippet: '' };

  const from = Math.max(0, hits[0].i - radius);
  const to = Math.min(lines.length - 1, hits[hits.length - 1].i + radius);
  const window = lines.slice(from, to + 1);
  return {
    ...base,
    target: hits.map(({ l }) => l.content),
    snippet: window.map(renderLine).join('\n'),
  };
}

function renderLine(l: { type: 'context' | 'add' | 'del'; content: string; oldLine: number | null; newLine: number | null }): string {
  const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
  const num = l.newLine ?? l.oldLine ?? '';
  return `${mark} ${String(num).padStart(4)}  ${l.content}`;
}
