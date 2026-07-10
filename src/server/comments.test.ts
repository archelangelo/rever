import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  addComment,
  createThread,
  getReviewComments,
  publishReview,
  resolveThread,
  updateThreadStatus,
} from './comments.js';
import type { Db } from './db.js';
import { openDb } from './db.js';
import { createSnapshot, startReview } from './review.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const tmpDirs: string[] = [];
const openDbs: Db[] = [];

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m4-'));
  tmpDirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nCHANGED\nl3\n');
  g(dir, ['add', '.']);
  return dir;
}

function tmpDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m4db-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'rever.db'));
  openDbs.push(db);
  return db;
}

async function fresh(): Promise<{ db: Db; reviewId: number; snapshotId: number }> {
  const repo = setupRepo();
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo });
  return { db, reviewId: r.reviewId, snapshotId: r.snapshotId };
}

const inlineOnA = (snapshotId: number, author: 'user' | 'claude', body: string) => ({
  snapshotId,
  kind: 'inline' as const,
  author,
  body,
  filePath: 'a.txt',
  side: 'new' as const,
  startLine: 2,
  endLine: 2,
});

after(() => {
  for (const db of openDbs) db.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('user drafts are hidden until publishReview', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  createThread(db, inlineOnA(snapshotId, 'user', 'a draft note'));
  assert.equal(getReviewComments(db, reviewId).threads.length, 0);

  const res = publishReview(db, reviewId);
  assert.equal(res.threads, 1);
  assert.equal(res.comments, 1);
  assert.equal(getReviewComments(db, reviewId).threads.length, 1);
});

test('claude comments publish immediately', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  createThread(db, inlineOnA(snapshotId, 'claude', 'agent note'));
  assert.equal(getReviewComments(db, reviewId).threads.length, 1);
});

test('code block: target line + surrounding window with markers', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  createThread(db, inlineOnA(snapshotId, 'claude', 'why the change?'));
  const [t] = getReviewComments(db, reviewId).threads;
  assert.deepEqual(t.code?.target, ['CHANGED']);
  assert.match(t.code!.snippet, /\+\s+2\s+CHANGED/); // added line 2
  assert.match(t.code!.snippet, /-\s+2\s+l2/); // removed old line 2
  assert.ok(t.code!.snippet.includes('l1')); // context above
});

test('comment tree flattened pre-order with depth + parent', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  const { threadId, commentId: root } = createThread(db, inlineOnA(snapshotId, 'user', 'root'));
  const r1 = addComment(db, { threadId, author: 'claude', body: 'reply1', parentCommentId: root });
  addComment(db, { threadId, author: 'user', body: 'reply1.1', parentCommentId: r1.commentId });
  addComment(db, { threadId, author: 'claude', body: 'reply2', parentCommentId: root });
  publishReview(db, reviewId);

  const [t] = getReviewComments(db, reviewId).threads;
  assert.deepEqual(
    t.comments.map((c) => [c.body, c.depth]),
    [
      ['root', 0],
      ['reply1', 1],
      ['reply1.1', 2],
      ['reply2', 1],
    ],
  );
  assert.equal(t.comments[1].parentCommentId, root);
});

test('summary thread carries verdict, has no code', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  createThread(db, {
    snapshotId,
    kind: 'summary',
    author: 'user',
    body: 'overall looks good',
    verdict: 'approve',
    publish: true,
  });
  const [t] = getReviewComments(db, reviewId).threads;
  assert.equal(t.kind, 'summary');
  assert.equal(t.verdict, 'approve');
  assert.equal(t.code, null);
  assert.equal(t.comments[0].body, 'overall looks good');
});

test('file-level thread has no code block', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  createThread(db, { snapshotId, kind: 'file', author: 'claude', body: 'file note', filePath: 'a.txt' });
  const [t] = getReviewComments(db, reviewId).threads;
  assert.equal(t.code, null);
});

test('resolveThread + status filter', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  const { threadId } = createThread(db, inlineOnA(snapshotId, 'claude', 'x'));
  assert.equal(getReviewComments(db, reviewId).threads.length, 1); // default 'open'

  resolveThread(db, threadId);
  assert.equal(getReviewComments(db, reviewId).threads.length, 0); // open excludes resolved
  assert.equal(getReviewComments(db, reviewId, { status: 'all' }).threads.length, 1);
  assert.equal(getReviewComments(db, reviewId, { status: 'resolved' }).threads.length, 1);
});

test('default snapshot is latest; explicit snapshotId targets an older one', async () => {
  const { db, reviewId, snapshotId: s1 } = await fresh();
  createThread(db, inlineOnA(s1, 'claude', 'on snap1'));
  await createSnapshot(db, reviewId); // s2 becomes latest, empty

  assert.equal(getReviewComments(db, reviewId).threads.length, 0); // latest = s2
  assert.equal(getReviewComments(db, reviewId, { snapshotId: s1 }).threads.length, 1);
});

test('buildCode edge cases: no hit, missing file, unparsable diff → null/empty', async () => {
  const { db, reviewId, snapshotId } = await fresh();

  // Line with no matching diff line → empty target/snippet.
  createThread(db, {
    snapshotId,
    kind: 'inline',
    author: 'claude',
    body: 'phantom',
    filePath: 'a.txt',
    side: 'new',
    startLine: 999,
    endLine: 999,
  });
  // File not present in the snapshot → code null.
  createThread(db, {
    snapshotId,
    kind: 'inline',
    author: 'claude',
    body: 'ghost file',
    filePath: 'nope.txt',
    side: 'new',
    startLine: 1,
    endLine: 1,
  });
  // Empty file_diff → parsePatch yields nothing → code null.
  db.prepare(
    `INSERT INTO snapshot_file (snapshot_id, old_path, new_path, change_type, file_diff, binary, too_large, additions, deletions)
     VALUES (?, NULL, 'empty.txt', 'added', '', 0, 0, 0, 0)`,
  ).run(snapshotId);
  createThread(db, {
    snapshotId,
    kind: 'inline',
    author: 'claude',
    body: 'empty diff',
    filePath: 'empty.txt',
    side: 'new',
    startLine: 1,
    endLine: 1,
  });

  const byBody = Object.fromEntries(
    getReviewComments(db, reviewId).threads.map((t) => [t.comments[0].body, t]),
  );
  assert.deepEqual(byBody['phantom'].code?.target, []);
  assert.equal(byBody['phantom'].code?.snippet, '');
  assert.equal(byBody['ghost file'].code, null);
  assert.equal(byBody['empty diff'].code, null);
});

test('old-side anchoring + top-level addComment (no parent)', async () => {
  const { db, reviewId, snapshotId } = await fresh();
  const { threadId } = createThread(db, {
    snapshotId,
    kind: 'inline',
    author: 'claude',
    body: 'root',
    filePath: 'a.txt',
    side: 'old',
    startLine: 2,
    endLine: 2,
  });
  addComment(db, { threadId, author: 'claude', body: 'second root' }); // no parentCommentId → top-level

  const [t] = getReviewComments(db, reviewId).threads;
  assert.deepEqual(t.code?.target, ['l2']); // old line 2 = the deleted 'l2'
  assert.deepEqual(
    t.comments.map((c) => [c.body, c.depth]),
    [
      ['root', 0],
      ['second root', 0],
    ],
  );
});

test('errors: unknown thread / review', async () => {
  const { db, reviewId } = await fresh();
  assert.throws(() => addComment(db, { threadId: 9999, author: 'user', body: 'x' }), /no such thread/);
  assert.throws(() => updateThreadStatus(db, 9999, 'resolved'), /no such thread/);
  assert.throws(() => getReviewComments(db, 9999), /no snapshot/);
  assert.equal(reviewId > 0, true);
});
