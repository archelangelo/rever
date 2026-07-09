import type { DiffLine, FileDiff, Hunk } from '../../types/index.js';

// Parses `git diff` unified-patch text into structured FileDiff[]. Assumes the patch
// was produced with --no-color -M -U<n> (no combined/merge diffs, no --binary payloads).

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface ParseOptions {
  /** Files whose raw section exceeds this many bytes are marked tooLarge (hunks dropped). */
  maxFileBytes?: number;
}

export function parsePatch(patch: string, opts: ParseOptions = {}): FileDiff[] {
  const maxFileBytes = opts.maxFileBytes ?? 1_500_000;
  return splitIntoFileSections(patch).map((section) => parseFileSection(section, maxFileBytes));
}

/** Split a full patch into per-file sections, each starting at a `diff --git` line. */
export function splitIntoFileSections(patch: string): string[][] {
  const sections: string[][] = [];
  let cur: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) sections.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function parseFileSection(lines: string[], maxFileBytes: number): FileDiff {
  const header = parseHeader(lines);

  const file: FileDiff = {
    changeType: header.changeType,
    oldPath: header.oldPath,
    newPath: header.newPath,
    additions: 0,
    deletions: 0,
    hunks: [],
  };

  if (header.binary) {
    file.binary = true;
    return file;
  }

  // Too-large guard: skip hunk parsing, keep cheap +/- counts.
  const byteLen = Buffer.byteLength(lines.join('\n'), 'utf8');
  if (byteLen > maxFileBytes) {
    file.tooLarge = true;
    // Counting starts at bodyStart (past the ---/+++ header), so every '+'/'-' here is a
    // hunk content line, never a file-header line.
    for (let i = header.bodyStart; i < lines.length; i++) {
      const c = lines[i][0];
      if (c === '+') file.additions++;
      else if (c === '-') file.deletions++;
    }
    return file;
  }

  file.hunks = parseHunks(lines, header.bodyStart);
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') file.additions++;
      else if (l.type === 'del') file.deletions++;
    }
  }
  return file;
}

interface HeaderInfo {
  changeType: FileDiff['changeType'];
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  bodyStart: number; // index of the first hunk line (or lines.length if none)
}

function parseHeader(lines: string[]): HeaderInfo {
  let isNew = false;
  let isDeleted = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let copyFrom: string | null = null;
  let copyTo: string | null = null;
  let binary = false;
  let minusPath: string | null = null;
  let plusPath: string | null = null;

  // Fallback paths from the `diff --git a/<old> b/<new>` line — needed when there are no
  // ---/+++ lines (e.g. a new/deleted binary file, or a pure rename).
  const gitLine = gitHeaderPaths(lines[0]);

  let i = 1; // skip the `diff --git` line
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) break;
    if (line.startsWith('new file mode')) isNew = true;
    else if (line.startsWith('deleted file mode')) isDeleted = true;
    else if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
    else if (line.startsWith('copy from ')) copyFrom = line.slice('copy from '.length);
    else if (line.startsWith('copy to ')) copyTo = line.slice('copy to '.length);
    else if (line.startsWith('Binary files ')) binary = true;
    else if (line.startsWith('--- ')) minusPath = stripDiffPathPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) plusPath = stripDiffPathPrefix(line.slice(4));
  }

  let changeType: FileDiff['changeType'];
  if (isNew) changeType = 'added';
  else if (isDeleted) changeType = 'deleted';
  else if (renameFrom !== null && renameTo !== null) changeType = 'renamed';
  else if (copyFrom !== null && copyTo !== null) changeType = 'copied';
  else changeType = 'modified';

  // Prefer explicit ---/+++ paths; then rename/copy headers; then the `diff --git` line.
  let oldPath = minusPath ?? renameFrom ?? copyFrom ?? gitLine.oldPath;
  let newPath = plusPath ?? renameTo ?? copyTo ?? gitLine.newPath;

  if (changeType === 'added') oldPath = null;
  if (changeType === 'deleted') newPath = null;

  return { changeType, oldPath, newPath, binary, bodyStart: i };
}

function parseHunks(lines: string[], bodyStart: number): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5]?.trim() ? m[5].trim() : undefined,
        lines: [],
      };
      hunks.push(cur);
      oldLine = cur.oldStart;
      newLine = cur.newStart;
      continue;
    }
    if (!cur) continue;

    const marker = line[0];
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — annotate the previous emitted line.
      const prev = cur.lines[cur.lines.length - 1];
      if (prev) prev.noNewlineAtEof = true;
      continue;
    }
    if (marker === ' ') {
      cur.lines.push(lineOf('context', line.slice(1), oldLine, newLine));
      oldLine++;
      newLine++;
    } else if (marker === '+') {
      cur.lines.push(lineOf('add', line.slice(1), null, newLine));
      newLine++;
    } else if (marker === '-') {
      cur.lines.push(lineOf('del', line.slice(1), oldLine, null));
      oldLine++;
    }
    // Any other line (e.g. trailing '') ends this file's hunk stream implicitly.
  }
  return hunks;
}

function lineOf(
  type: DiffLine['type'],
  content: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine {
  return { type, content, oldLine, newLine };
}

/** Parse `diff --git a/<old> b/<new>` into its two paths (common unquoted case). */
function gitHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice('diff --git '.length);
  const m = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (!m) return { oldPath: null, newPath: null };
  return { oldPath: m[1], newPath: m[2] };
}

/** Strip the `a/` or `b/` prefix git adds; map /dev/null to null. */
function stripDiffPathPrefix(raw: string): string | null {
  const p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
