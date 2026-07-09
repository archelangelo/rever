import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { FileDiff } from '../../types/index.js';
import { computeSnapshotDiff } from './index.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

let repo: string;

function byNew(files: FileDiff[], p: string) {
  return files.find((f) => f.newPath === p);
}
function byOld(files: FileDiff[], p: string) {
  return files.find((f) => f.oldPath === p);
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-diff-'));
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@example.com']);
  g(repo, ['config', 'user.name', 'Test']);

  // Initial commit: a 12-line file, a file to delete, a file to rename.
  const twelve = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'a.txt'), twelve);
  fs.writeFileSync(path.join(repo, 'del.txt'), 'delete me\n');
  fs.writeFileSync(path.join(repo, 'ren-old.txt'), 'stable content\nsecond line\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'init']);

  // Staged changes of each kind.
  const modified = twelve.replace('line 6', 'line 6 CHANGED');
  fs.writeFileSync(path.join(repo, 'a.txt'), modified); // modify
  fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n'); // add
  g(repo, ['rm', '-q', 'del.txt']); // delete
  g(repo, ['mv', 'ren-old.txt', 'ren-new.txt']); // rename
  g(repo, ['add', 'a.txt', 'new.txt']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('change types: add / modify / delete / rename', async () => {
  const { files } = await computeSnapshotDiff(repo, 'staged');

  assert.equal(byNew(files, 'new.txt')?.changeType, 'added');
  assert.equal(byNew(files, 'new.txt')?.oldPath, null);

  assert.equal(byOld(files, 'del.txt')?.changeType, 'deleted');
  assert.equal(byOld(files, 'del.txt')?.newPath, null);

  const ren = files.find((f) => f.changeType === 'renamed');
  assert.equal(ren?.oldPath, 'ren-old.txt');
  assert.equal(ren?.newPath, 'ren-new.txt');

  assert.equal(byNew(files, 'a.txt')?.changeType, 'modified');
});

test('modified file has correct old/new line numbers on the changed line', async () => {
  const { files } = await computeSnapshotDiff(repo, 'staged');
  const a = byNew(files, 'a.txt')!;
  assert.ok(a.hunks.length >= 1);

  const del = a.hunks.flatMap((h) => h.lines).find((l) => l.type === 'del');
  const add = a.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add');
  // "line 6" was on line 6 in both old and new numbering.
  assert.equal(del?.content, 'line 6');
  assert.equal(del?.oldLine, 6);
  assert.equal(del?.newLine, null);
  assert.equal(add?.content, 'line 6 CHANGED');
  assert.equal(add?.newLine, 6);
  assert.equal(add?.oldLine, null);
  assert.equal(a.additions, 1);
  assert.equal(a.deletions, 1);
});

test('context is -U8 (bounded by file): both sides present, numbered correctly', async () => {
  const { files } = await computeSnapshotDiff(repo, 'staged', { context: 8 });
  const a = byNew(files, 'a.txt')!;
  const ctx = a.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'context');
  // 12-line file, change at line 6 → up to 8 context each side, capped by file = 11 context lines.
  assert.equal(ctx.length, 11);
  // Every context line has matching, contiguous old/new numbers.
  for (const l of ctx) {
    assert.equal(typeof l.oldLine, 'number');
    assert.equal(l.oldLine, l.newLine);
  }
  // First context line is line 1 of both sides.
  assert.equal(ctx[0].oldLine, 1);
});

test('binary file is flagged, no hunks', async () => {
  const bin = path.join(repo, 'blob.bin');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 0, 255, 254, 0, 10, 0]));
  g(repo, ['add', 'blob.bin']);
  const { files } = await computeSnapshotDiff(repo, 'staged');
  const b = byNew(files, 'blob.bin')!;
  assert.equal(b.binary, true);
  assert.equal(b.hunks.length, 0);
  g(repo, ['rm', '-qf', 'blob.bin']);
});

test('oversized file is marked tooLarge with hunks dropped', async () => {
  const big = path.join(repo, 'big.txt');
  fs.writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n') + '\n');
  g(repo, ['add', 'big.txt']);
  const { files } = await computeSnapshotDiff(repo, 'staged', { maxFileBytes: 1000 });
  const b = byNew(files, 'big.txt')!;
  assert.equal(b.tooLarge, true);
  assert.equal(b.hunks.length, 0);
  assert.ok(b.additions > 0);
  g(repo, ['rm', '-qf', 'big.txt']);
});

test('resolves base (HEAD) and head (write-tree) oids for staged', async () => {
  const diff = await computeSnapshotDiff(repo, 'staged');
  assert.match(diff.baseOid, /^[0-9a-f]{40}$/);
  assert.match(diff.headOid, /^[0-9a-f]{40}$/);
});
