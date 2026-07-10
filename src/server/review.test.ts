import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Db } from './db.js';
import { openDb } from './db.js';
import { captureDiff } from './diff/index.js';
import { createSnapshot, getSnapshotDiff, listReviews, startReview } from './review.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const tmpDirs: string[] = [];
const openDbs: Db[] = [];

/** A repo with one commit plus staged changes: a.txt modified, b.txt added. */
function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m3-'));
  tmpDirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nCHANGED\nl3\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new file\n');
  g(dir, ['add', '.']);
  return dir;
}

function tmpDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m3db-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'rever.db'));
  openDbs.push(db);
  return db;
}

const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

after(() => {
  for (const db of openDbs) db.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('startReview: creates 1 review + 1 snapshot + N files, returns ids + url', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo });

  assert.equal(typeof r.reviewId, 'number');
  assert.equal(typeof r.snapshotId, 'number');
  assert.equal(r.seq, 1);
  assert.match(r.url, new RegExp(`/review/${r.reviewId}$`));

  assert.equal(count(db, 'review'), 1);
  assert.equal(count(db, 'snapshot'), 1);
  const files = db
    .prepare('SELECT change_type, new_path FROM snapshot_file WHERE snapshot_id = ? ORDER BY new_path')
    .all(r.snapshotId) as { change_type: string; new_path: string }[];
  assert.equal(files.length, 2); // a.txt modified, b.txt added
  assert.equal(files.find((f) => f.new_path === 'a.txt')?.change_type, 'modified');
  assert.equal(files.find((f) => f.new_path === 'b.txt')?.change_type, 'added');

  const snap = db.prepare('SELECT files_changed, insertions, deletions FROM snapshot WHERE id = ?').get(r.snapshotId) as {
    files_changed: number;
    insertions: number;
    deletions: number;
  };
  assert.equal(snap.files_changed, 2);
  assert.ok(snap.insertions > 0);
});

test('startReview: explicit selector + title are persisted', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo, selector: 'staged', title: 'My review' });
  const row = db.prepare('SELECT selector, title FROM review WHERE id = ?').get(r.reviewId) as {
    selector: string;
    title: string;
  };
  assert.equal(row.selector, 'staged');
  assert.equal(row.title, 'My review');
});

test('startReview: nonexistent repo path → throws, no rows', async () => {
  const db = tmpDb();
  await assert.rejects(() => startReview(db, { repoPath: '/no/such/path/xyz' }), /not found/);
  assert.equal(count(db, 'review'), 0);
  assert.equal(count(db, 'snapshot'), 0);
});

test('startReview: non-git directory → throws, no rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-notgit-'));
  tmpDirs.push(dir);
  const db = tmpDb();
  await assert.rejects(() => startReview(db, { repoPath: dir }), /not a git repository/);
  assert.equal(count(db, 'review'), 0);
});

test('startReview: invalid revspec → throws, no rows', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  await assert.rejects(() => startReview(db, { repoPath: repo, selector: 'no-such-a..no-such-b' }));
  assert.equal(count(db, 'review'), 0);
  assert.equal(count(db, 'snapshot'), 0);
});

test('durability: stored snapshot is frozen text, unaffected by later git changes', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo });

  const stored = () =>
    (db.prepare('SELECT raw_diff FROM snapshot WHERE id = ?').get(r.snapshotId) as { raw_diff: string }).raw_diff;
  const original = stored();
  assert.ok(original.includes('CHANGED'));

  // Mutate git state: stage another change.
  fs.writeFileSync(path.join(repo, 'c.txt'), 'later addition\n');
  g(repo, ['add', 'c.txt']);

  // Stored snapshot text is unchanged...
  assert.equal(stored(), original);
  // ...even though a fresh capture now differs.
  const fresh = await captureDiff(repo, 'staged');
  assert.notEqual(fresh.rawDiff, original);
  assert.ok(fresh.rawDiff.includes('c.txt'));
});

test('startReview: binary and oversized files are flagged in snapshot_file', async () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 10, 0]));
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(1_600_000) + '\n'); // > 1.5MB cap
  g(repo, ['add', '.']);
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo });

  const rows = db
    .prepare('SELECT new_path, binary, too_large FROM snapshot_file WHERE snapshot_id = ?')
    .all(r.snapshotId) as { new_path: string; binary: number; too_large: number }[];
  assert.equal(rows.find((x) => x.new_path === 'img.bin')?.binary, 1);
  assert.equal(rows.find((x) => x.new_path === 'big.txt')?.too_large, 1);
});

test('createSnapshot: advances to seq 2, new snapshot, empty of comments', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const r1 = await startReview(db, { repoPath: repo });

  const r2 = await createSnapshot(db, r1.reviewId);
  assert.equal(r2.reviewId, r1.reviewId);
  assert.equal(r2.seq, 2);
  assert.notEqual(r2.snapshotId, r1.snapshotId);

  const snaps = db.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE review_id = ?').get(r1.reviewId) as { n: number };
  assert.equal(snaps.n, 2);
  const threads = db.prepare('SELECT COUNT(*) AS n FROM thread WHERE snapshot_id = ?').get(r2.snapshotId) as { n: number };
  assert.equal(threads.n, 0);
});

test('createSnapshot: unknown review → throws', async () => {
  const db = tmpDb();
  await assert.rejects(() => createSnapshot(db, 9999), /no such review/);
});

test('listReviews (filter + fallback path) and getSnapshotDiff (file + errors)', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const r = await startReview(db, { repoPath: repo });

  assert.equal(listReviews(db).length, 1);
  assert.equal(listReviews(db, repo).length, 1); // realpath match
  assert.equal(listReviews(db, '/no/such/path/xyz').length, 0); // bestPath fallback, no match
  assert.equal(listReviews(db)[0].latestSeq, 1);

  assert.match(getSnapshotDiff(db, r.snapshotId), /diff --git/);
  assert.match(getSnapshotDiff(db, r.snapshotId, 'a.txt'), /a\.txt/);
  assert.throws(() => getSnapshotDiff(db, r.snapshotId, 'nope.txt'), /no such file/);
  assert.throws(() => getSnapshotDiff(db, 999999), /no such snapshot/);
});
