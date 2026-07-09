import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The empty-tree object id — used as the base when a repo has no commits yet. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitRunOptions {
  cwd: string;
  maxBuffer?: number;
}

/**
 * Run a git command asynchronously, returning stdout. Rejects on non-zero exit.
 * Async so the daemon's event loop stays responsive while git runs in its own process.
 */
export async function git(args: string[], opts: GitRunOptions): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], { cwd })).trim() === 'true';
  } catch {
    return false;
  }
}

/** Resolve a rev to a full object id, or null if it doesn't resolve. */
export async function tryRevParse(cwd: string, rev: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', rev], { cwd })).trim() || null;
  } catch {
    return null;
  }
}

/** Object id of the current index as a tree (staged state). */
export async function writeTree(cwd: string): Promise<string> {
  return (await git(['write-tree'], { cwd })).trim();
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(['merge-base', a, b], { cwd })).trim() || null;
  } catch {
    return null;
  }
}
