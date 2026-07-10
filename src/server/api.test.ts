import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';
import type { Db } from './db.js';
import { openDb } from './db.js';
import { createSnapshot, startReview } from './review.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const tmpDirs: string[] = [];
let db: Db;
let server: http.Server;
let base: string;
let reviewId: number;
let snapshotId: number;

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m6-'));
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

const get = async (url: string) => {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: (await res.json()) as any };
};

const post = async (url: string, body: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

before(async () => {
  const repo = setupRepo();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m6db-'));
  tmpDirs.push(dbDir);
  db = openDb(path.join(dbDir, 'rever.db'));
  const r = await startReview(db, { repoPath: repo, title: 'Demo' });
  reviewId = r.reviewId;
  snapshotId = r.snapshotId;
  await createSnapshot(db, reviewId); // second snapshot

  server = http.createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('GET /api/reviews lists the review', async () => {
  const { status, body } = await get('/api/reviews');
  assert.equal(status, 200);
  const row = body.find((r: { id: number }) => r.id === reviewId);
  assert.ok(row);
  assert.equal(row.title, 'Demo');
  assert.equal(row.snapshots, 2);
  assert.equal(row.latestSeq, 2);
});

test('GET /api/reviews/:id returns detail + snapshots', async () => {
  const { status, body } = await get(`/api/reviews/${reviewId}`);
  assert.equal(status, 200);
  assert.equal(body.id, reviewId);
  assert.equal(body.repoExists, true);
  assert.equal(body.snapshots.length, 2);
  assert.deepEqual(
    body.snapshots.map((s: { seq: number }) => s.seq),
    [1, 2],
  );
  assert.ok(body.snapshots[0].filesChanged >= 1);
});

test('GET /api/reviews/:id 404 for unknown review', async () => {
  const { status, body } = await get('/api/reviews/999999');
  assert.equal(status, 404);
  assert.match(body.error, /no such review/);
});

test('GET /api/snapshots/:id/diff returns structured files/hunks/lines', async () => {
  const { status, body } = await get(`/api/snapshots/${snapshotId}/diff`);
  assert.equal(status, 200);
  const a = body.files.find((f: { newPath: string }) => f.newPath === 'a.txt');
  assert.equal(a.changeType, 'modified');
  const addLine = a.hunks.flatMap((h: { lines: unknown[] }) => h.lines).find((l: { type: string }) => l.type === 'add');
  assert.equal(addLine.content, 'CHANGED');
  assert.equal(addLine.newLine, 2);
});

test('GET /api/snapshots/:id/diff 404 for unknown snapshot', async () => {
  const { status } = await get('/api/snapshots/999999/diff');
  assert.equal(status, 404);
});

test('moved repo → repoExists false', async () => {
  const repo2 = setupRepo();
  const r2 = await startReview(db, { repoPath: repo2 });
  fs.rmSync(repo2, { recursive: true, force: true });
  const { body } = await get(`/api/reviews/${r2.reviewId}`);
  assert.equal(body.repoExists, false);
});

test('authoring: draft thread + nested reply, hidden until publish', async () => {
  const created = (
    await post(`/api/snapshots/${snapshotId}/threads`, {
      kind: 'inline',
      filePath: 'a.txt',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'why change line 2?',
    })
  ).body;
  assert.ok(created.threadId > 0);

  // Visible to the browser as a draft.
  let threads = (await get(`/api/snapshots/${snapshotId}/threads`)).body;
  const draft = threads.find((t: { threadId: number }) => t.threadId === created.threadId);
  assert.equal(draft.published, false);
  assert.equal(draft.comments[0].published, false);

  await post(`/api/threads/${created.threadId}/comments`, { body: 'nested reply', parentCommentId: created.commentId });

  const pub = (await post(`/api/reviews/${reviewId}/publish`, {})).body;
  assert.ok(pub.threads >= 1);
  assert.ok(pub.comments >= 2);

  threads = (await get(`/api/snapshots/${snapshotId}/threads`)).body;
  const t = threads.find((x: { threadId: number }) => x.threadId === created.threadId);
  assert.equal(t.published, true);
  assert.equal(t.comments.length, 2);
  assert.equal(t.comments[1].depth, 1); // nested reply, pre-order
  assert.ok(t.comments.every((c: { published: boolean }) => c.published));
});

test('authoring: summary carries verdict', async () => {
  await post(`/api/snapshots/${snapshotId}/threads`, {
    kind: 'summary',
    body: 'overall looks good',
    verdict: 'approve',
  });
  const threads = (await get(`/api/snapshots/${snapshotId}/threads`)).body;
  const summary = threads.find((t: { kind: string }) => t.kind === 'summary');
  assert.equal(summary.verdict, 'approve');
});

test('authoring: reply to unknown thread → 400', async () => {
  const { status } = await post('/api/threads/999999/comments', { body: 'x' });
  assert.equal(status, 400);
});
