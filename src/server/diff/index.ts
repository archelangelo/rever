import type { SnapshotDiff } from '../../types/index.js';
import { EMPTY_TREE_OID, git, mergeBase, tryRevParse, writeTree } from '../git.js';
import { parsePatch } from './parse.js';

export { parsePatch, splitIntoFileSections } from './parse.js';

export interface ComputeDiffOptions {
  /** Unified context lines. Default 8 (richer context than git's default 3). */
  context?: number;
  /** Per-file byte cap; larger files are marked tooLarge. Default 1.5 MB. */
  maxFileBytes?: number;
}

/**
 * Compute a structured diff for a review selector.
 *  - "staged" (default): `git diff --cached` → HEAD vs the index.
 *  - any other string: treated as a git revspec (`A..B`, `A...B`, a branch, …).
 */
export async function computeSnapshotDiff(
  repoPath: string,
  selector: string,
  opts: ComputeDiffOptions = {},
): Promise<SnapshotDiff> {
  const context = opts.context ?? 8;
  const args = buildDiffArgs(selector, context);
  const patch = await git(args, { cwd: repoPath });
  const files = parsePatch(patch, { maxFileBytes: opts.maxFileBytes });
  const { baseOid, headOid } = await resolveEndpoints(repoPath, selector);
  return { baseOid, headOid, files };
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
