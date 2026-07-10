import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { addComment, getReviewComments, resolveThread, updateThreadStatus } from './comments.js';
import type { Db } from './db.js';
import { createSnapshot, getSnapshotDiff, listReviews, startReview } from './review.js';

const okJson = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const okText = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (msg: string): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${msg}` }],
  isError: true,
});

/** Run business logic, returning JSON on success or an isError tool result on throw. */
async function run(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return okJson(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** Build a fresh MCP server exposing Rever's tools, backed by `db`. */
export function createMcpServer(db: Db): McpServer {
  const server = new McpServer({ name: 'rever', version: '0.0.1' });

  server.registerTool(
    'start_review',
    {
      description:
        'Start a NEW Rever review of a repo. Stage the files you want reviewed first (default ' +
        'selector "staged" diffs HEAD vs the index). Returns reviewId, snapshotId, and a browser URL.',
      inputSchema: { repo_path: z.string(), selector: z.string().optional() },
    },
    async ({ repo_path, selector }) => run(() => startReview(db, { repoPath: repo_path, selector })),
  );

  server.registerTool(
    'list_reviews',
    {
      description: 'List reviews (newest first), optionally filtered to one repo path. Use to recover a reviewId.',
      inputSchema: { repo_path: z.string().optional() },
    },
    async ({ repo_path }) => run(() => listReviews(db, repo_path)),
  );

  server.registerTool(
    'get_review_comments',
    {
      description:
        'Pull the published comment threads for a review (default: latest snapshot, open threads). ' +
        'Each thread includes its location, a code snippet, and a pre-order flattened comment tree.',
      inputSchema: {
        review_id: z.number().int(),
        snapshot_id: z.number().int().optional(),
        status: z.enum(['open', 'resolved', 'all']).optional(),
      },
    },
    async ({ review_id, snapshot_id, status }) =>
      run(() => getReviewComments(db, review_id, { snapshotId: snapshot_id, status })),
  );

  server.registerTool(
    'add_comment',
    {
      description:
        'Reply in a thread (author=claude, published immediately). Omit parent_comment_id for a ' +
        'top-level reply, or set it to reply to a specific comment.',
      inputSchema: {
        thread_id: z.number().int(),
        body: z.string(),
        parent_comment_id: z.number().int().optional(),
      },
    },
    async ({ thread_id, body, parent_comment_id }) =>
      run(() =>
        addComment(db, {
          threadId: thread_id,
          author: 'claude',
          body,
          parentCommentId: parent_comment_id,
          publish: true,
        }),
      ),
  );

  server.registerTool(
    'resolve_thread',
    {
      description: 'Mark a thread resolved (addressed).',
      inputSchema: { thread_id: z.number().int() },
    },
    async ({ thread_id }) =>
      run(() => {
        resolveThread(db, thread_id);
        return { ok: true, threadId: thread_id, status: 'resolved' };
      }),
  );

  server.registerTool(
    'update_thread_status',
    {
      description: 'Set a thread status to "open" or "resolved".',
      inputSchema: { thread_id: z.number().int(), status: z.enum(['open', 'resolved']) },
    },
    async ({ thread_id, status }) =>
      run(() => {
        updateThreadStatus(db, thread_id, status);
        return { ok: true, threadId: thread_id, status };
      }),
  );

  server.registerTool(
    'create_snapshot',
    {
      description:
        'Freeze a new snapshot on an existing review after you revise + re-stage code. Starts empty ' +
        'of comments (the fresh review surface for the next round).',
      inputSchema: { review_id: z.number().int() },
    },
    async ({ review_id }) => run(() => createSnapshot(db, review_id)),
  );

  server.registerTool(
    'get_snapshot_diff',
    {
      description: 'The full frozen diff text for a snapshot, or a single file when `file` is given.',
      inputSchema: { snapshot_id: z.number().int(), file: z.string().optional() },
    },
    async ({ snapshot_id, file }) => {
      try {
        return okText(getSnapshotDiff(db, snapshot_id, file));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
