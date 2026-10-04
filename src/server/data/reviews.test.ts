import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Db } from '../db.js';
import { openDb } from '../db.js';
import { startReview } from '../review.js';
import { makeReviewsDao } from './reviews.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const tmpDirs: string[] = [];
const openDbs: Db[] = [];

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-dao-'));
  tmpDirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nCHANGED\n');
  g(dir, ['add', '.']);
  return dir;
}

function tmpDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-daodb-'));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, 'rever.db'));
  openDbs.push(db);
  return db;
}

after(() => {
  for (const db of openDbs) db.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('listSummaries: unfiltered, repo filter (realpath match), and no-match fallback', async () => {
  const repo = setupRepo();
  const db = tmpDb();
  const dao = makeReviewsDao(db);
  await startReview(db, { repoPath: repo });

  assert.equal(dao.listSummaries().length, 1);
  assert.equal(dao.listSummaries(repo).length, 1); // canonicalized path matches the stored one
  assert.equal(dao.listSummaries('/no/such/path/xyz').length, 0); // bestPath fallback, no match
  assert.equal(dao.listSummaries()[0].latestSeq, 1); // snapshot aggregate is populated
});
