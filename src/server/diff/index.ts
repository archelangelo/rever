import type { FileDiff, SnapshotDiff } from '../../types/index.js';
import { EMPTY_TREE_OID, git, mergeBase, tryRevParse, writeTree } from '../git.js';
import { parsePatch, splitIntoFileSections } from './parse.js';

export { parsePatch, splitIntoFileSections } from './parse.js';

export interface ComputeDiffOptions {
  /** Unified context lines. Default 8 (richer context than git's default 3). */
  context?: number;
  /** Per-file byte cap; larger files are marked tooLarge. Default 1.5 MB. */
  maxFileBytes?: number;
}

/** A parsed file plus the raw patch text of just that file's section (for storage). */
export interface CapturedFile {
  meta: FileDiff;
  text: string;
}

/** Everything the capture/persistence layer needs from one `git diff` run. */
export interface CapturedDiff {
  baseOid: string;
  headOid: string;
  rawDiff: string;
  files: CapturedFile[];
}

/**
 * Run one `git diff` and return the raw patch, per-file raw slices, parsed metadata, and
 * resolved endpoint OIDs. This is the storage-oriented entry (M3 capture). `git` runs async;
 * callers persist the result inside a synchronous SQLite transaction.
 *  - "staged" (default): `git diff --cached` → HEAD vs the index.
 *  - any other string: a git revspec (`A..B`, `A...B`, a branch, …).
 */
export async function captureDiff(
  repoPath: string,
  selector: string,
  opts: ComputeDiffOptions = {},
): Promise<CapturedDiff> {
  const context = opts.context ?? 8;
  const rawDiff = await git(buildDiffArgs(selector, context), { cwd: repoPath });
  const sections = splitIntoFileSections(rawDiff);
  const metas = parsePatch(rawDiff, { maxFileBytes: opts.maxFileBytes });
  const { baseOid, headOid } = await resolveEndpoints(repoPath, selector);
  // parsePatch derives its files from the same sections, in order → safe to zip.
  const files = metas.map((meta, i) => ({ meta, text: sections[i].join('\n') }));
  return { baseOid, headOid, rawDiff, files };
}

/** Structured-only diff (no raw text) — used by read paths and tests. */
export async function computeSnapshotDiff(
  repoPath: string,
  selector: string,
  opts: ComputeDiffOptions = {},
): Promise<SnapshotDiff> {
  const c = await captureDiff(repoPath, selector, opts);
  return { baseOid: c.baseOid, headOid: c.headOid, files: c.files.map((f) => f.meta) };
}

function buildDiffArgs(selector: string, context: number): string[] {
  const base = ['diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`];
  if (selector === 'staged') return [...base, '--cached'];
  return [...base, selector];
}

/** Resolve the concrete base/head object ids for provenance (diff text is the source of truth). */
export async function resolveEndpoints(
  repoPath: string,
  selector: string,
): Promise<{ baseOid: string; headOid: string }> {
  if (selector === 'staged') {
    return {
      baseOid: (await tryRevParse(repoPath, 'HEAD')) ?? EMPTY_TREE_OID,
      headOid: await writeTree(repoPath),
    };
  }

  // Two-dot: A..B → (A, B). Three-dot: A...B → (merge-base(A,B), B).
  const three = selector.split('...');
  if (three.length === 2) {
    const [a, b] = three;
    const base = await mergeBase(repoPath, a || 'HEAD', b || 'HEAD');
    return {
      baseOid: base ?? EMPTY_TREE_OID,
      headOid: (await tryRevParse(repoPath, b || 'HEAD')) ?? EMPTY_TREE_OID,
    };
  }
  const two = selector.split('..');
  if (two.length === 2) {
    const [a, b] = two;
    return {
      baseOid: (await tryRevParse(repoPath, a || 'HEAD')) ?? EMPTY_TREE_OID,
      headOid: (await tryRevParse(repoPath, b || 'HEAD')) ?? EMPTY_TREE_OID,
    };
  }

  // Single ref → diff that ref against the working tree.
  return {
    baseOid: (await tryRevParse(repoPath, selector)) ?? EMPTY_TREE_OID,
    headOid: (await tryRevParse(repoPath, 'HEAD')) ?? EMPTY_TREE_OID,
  };
}
