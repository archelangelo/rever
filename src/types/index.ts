// Shared DTO contract — serialized across SQLite ↔ server ↔ HTTP/SSE ↔ browser ↔ MCP.
// Plain interfaces (not classes): behavior lives in free functions, never as methods.

// ── M2: structured diff (git-diff adapter output) ──────────────────────────────

export interface SnapshotDiff {
  baseOid: string;
  headOid: string;
  files: FileDiff[];
}

export interface FileDiff {
  changeType: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  oldPath: string | null; // null when added
  newPath: string | null; // null when deleted
  additions: number;
  deletions: number;
  hunks: Hunk[]; // empty when binary or tooLarge
  binary?: boolean; // content omitted → marker
  tooLarge?: boolean; // exceeded per-file cap → stats only
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string; // section heading git appends after @@
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  content: string; // leading +/-/space stripped
  oldLine: number | null; // set for context & del
  newLine: number | null; // set for context & add
  noNewlineAtEof?: boolean;
}

// ── Core review entities (mirror the SQLite schema) ────────────────────────────

export type ReviewStatus = 'active' | 'archived';
export type ThreadKind = 'inline' | 'file' | 'summary';
export type ThreadStatus = 'open' | 'resolved';
export type ThreadSide = 'old' | 'new';
export type Verdict = 'approve' | 'request_changes' | 'comment';
export type Author = 'user' | 'claude';

export interface Review {
  id: number;
  repoPath: string;
  selector: string; // 'staged' (default) or an explicit revspec
  title: string | null;
  status: ReviewStatus;
  createdAt: string;
}

export interface Snapshot {
  id: number;
  reviewId: number;
  seq: number;
  baseOid: string | null;
  headOid: string | null;
  selector: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdAt: string;
}

export interface Thread {
  id: number;
  snapshotId: number;
  kind: ThreadKind;
  status: ThreadStatus;
  filePath: string | null;
  side: ThreadSide | null;
  startLine: number | null;
  endLine: number | null;
  verdict: Verdict | null; // only meaningful for kind='summary'
  publishedAt: string | null; // null = draft
  createdAt: string;
}

export interface Comment {
  id: number;
  threadId: number;
  parentCommentId: number | null; // null = top-level under the thread
  author: Author;
  body: string;
  publishedAt: string | null; // null = draft
  createdAt: string;
}
