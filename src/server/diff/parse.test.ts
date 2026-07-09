import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatch, splitIntoFileSections } from './parse.js';

// Crafted unified-diff patches exercise every parser branch directly — far more precisely
// than driving real git. `\\` in a template literal is a single literal backslash (needed
// for the "\ No newline at end of file" marker lines).

test('empty patch → no files', () => {
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(splitIntoFileSections(''), []);
});

test('leading noise before the first `diff --git` is ignored', () => {
  const patch = `warning: something unrelated
diff --git a/foo.txt b/foo.txt
index 111..222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1 +1 @@
-a
+b
`;
  const files = parsePatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].newPath, 'foo.txt');
});

test('modified file: hunk header with counts + section heading, context/add/del lines', () => {
  const patch = `diff --git a/foo.ts b/foo.ts
index 111..222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@ function foo()
 keep
-old
+new
 tail
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'modified');
  assert.equal(f.oldPath, 'foo.ts');
  assert.equal(f.newPath, 'foo.ts');
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);

  const h = f.hunks[0];
  assert.deepEqual(
    { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines },
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
  );
  assert.equal(h.header, 'function foo()');
  assert.deepEqual(
    h.lines.map((l) => [l.type, l.content, l.oldLine, l.newLine]),
    [
      ['context', 'keep', 1, 1],
      ['del', 'old', 2, null],
      ['add', 'new', null, 2],
      ['context', 'tail', 3, 3],
    ],
  );
});

test('added file: /dev/null old side, changeType added, oldPath nulled', () => {
  const patch = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'added');
  assert.equal(f.oldPath, null);
  assert.equal(f.newPath, 'new.ts');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
});

test('deleted file: /dev/null new side, newPath nulled', () => {
  const patch = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abc1234..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'deleted');
  assert.equal(f.oldPath, 'gone.ts');
  assert.equal(f.newPath, null);
  assert.equal(f.deletions, 2);
});

test('pure rename: no ---/+++, no hunks, paths from rename headers', () => {
  const patch = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'renamed');
  assert.equal(f.oldPath, 'old.ts');
  assert.equal(f.newPath, 'new.ts');
  assert.equal(f.hunks.length, 0);
});

test('rename with edits: ---/+++ paths win, still renamed', () => {
  const patch = `diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
 keep
-x
+y
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'renamed');
  assert.equal(f.oldPath, 'old.ts');
  assert.equal(f.newPath, 'new.ts');
  assert.equal(f.hunks.length, 1);
});

test('copy: copy from/to headers, changeType copied', () => {
  const patch = `diff --git a/src.ts b/copy.ts
similarity index 100%
copy from src.ts
copy to copy.ts
`;
  const [f] = parsePatch(patch);
  assert.equal(f.changeType, 'copied');
  assert.equal(f.oldPath, 'src.ts');
  assert.equal(f.newPath, 'copy.ts');
});

test('binary file: flagged, no hunks, header still parsed', () => {
  const patch = `diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/img.png differ
`;
  const [f] = parsePatch(patch);
  assert.equal(f.binary, true);
  assert.equal(f.changeType, 'added');
  assert.equal(f.newPath, 'img.png');
  assert.equal(f.hunks.length, 0);
});

test('single-line hunk header (no ,count) + no section heading + no-newline markers', () => {
  const patch = `diff --git a/n.ts b/n.ts
index 111..222 100644
--- a/n.ts
+++ b/n.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
  const [f] = parsePatch(patch);
  const h = f.hunks[0];
  // Omitted counts default to 1; empty section heading → undefined.
  assert.equal(h.oldLines, 1);
  assert.equal(h.newLines, 1);
  assert.equal(h.header, undefined);
  const del = h.lines.find((l) => l.type === 'del')!;
  const add = h.lines.find((l) => l.type === 'add')!;
  assert.equal(del.noNewlineAtEof, true);
  assert.equal(add.noNewlineAtEof, true);
});

test('too-large: hunks dropped, +/- still counted, byte cap respected', () => {
  const patch = `diff --git a/big.ts b/big.ts
index 111..222 100644
--- a/big.ts
+++ b/big.ts
@@ -1,4 +1,4 @@
 keep
-one
-two
+three
+four
`;
  const [f] = parsePatch(patch, { maxFileBytes: 10 });
  assert.equal(f.tooLarge, true);
  assert.equal(f.hunks.length, 0);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 2);
});

test('multiple files in one patch → split into separate sections', () => {
  const patch = `diff --git a/one.ts b/one.ts
index 111..222 100644
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
diff --git a/two.ts b/two.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/two.ts
@@ -0,0 +1 @@
+hi
`;
  const files = parsePatch(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].changeType, 'modified');
  assert.equal(files[1].changeType, 'added');
  assert.equal(splitIntoFileSections(patch).length, 2);
});

test('default maxFileBytes path (no opts) still parses normally', () => {
  const patch = `diff --git a/x.ts b/x.ts
index 111..222 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
`;
  const [f] = parsePatch(patch);
  assert.equal(f.tooLarge, undefined);
  assert.equal(f.hunks.length, 1);
});
