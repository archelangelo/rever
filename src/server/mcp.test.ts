import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';
import { createThread, publishReview } from './comments.js';
import type { Db } from './db.js';
import { openDb } from './db.js';

function g(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const tmpDirs: string[] = [];
let db: Db;
let server: http.Server;
let client: Client;
let repo: string;
let reviewId: number;
let snapshotId: number;
let threadId: number;

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m5-'));
  tmpDirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nCHANGED\nl3\n');
  g(dir, ['add', '.']);
  return dir;
}

/** Call a tool and return { result, text } where text is the first text content block. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { result, text: content[0].text };
}

before(async () => {
  repo = setupRepo();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m5db-'));
  tmpDirs.push(dbDir);
  db = openDb(path.join(dbDir, 'rever.db'));

  server = http.createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  client = new Client({ name: 'rever-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
});

after(async () => {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('lists all Rever tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const expected of [
    'add_comment',
    'create_snapshot',
    'get_review_comments',
    'get_snapshot_diff',
    'list_reviews',
    'resolve_thread',
    'start_review',
    'update_thread_status',
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test('start_review over MCP creates a review', async () => {
  const { text } = await call('start_review', { repo_path: repo });
  const sr = JSON.parse(text);
  reviewId = sr.reviewId;
  snapshotId = sr.snapshotId;
  assert.ok(reviewId > 0);
  assert.ok(snapshotId > 0);
  assert.match(sr.url, /\/review\/\d+$/);
});

test('agent reads a published thread, replies, and resolves it', async () => {
  // Simulate the human reviewer: draft a comment, then publish.
  const created = createThread(db, {
    snapshotId,
    kind: 'inline',
    author: 'user',
    body: 'why change line 2?',
    filePath: 'a.txt',
    side: 'new',
    startLine: 2,
    endLine: 2,
  });
  threadId = created.threadId;
  publishReview(db, reviewId);

  // get_review_comments
  let bundle = JSON.parse((await call('get_review_comments', { review_id: reviewId })).text);
  assert.equal(bundle.threads.length, 1);
  assert.equal(bundle.threads[0].threadId, threadId);
  assert.deepEqual(bundle.threads[0].code.target, ['CHANGED']);

  // add_comment (agent reply, published immediately)
  const added = JSON.parse((await call('add_comment', { thread_id: threadId, body: 'Done — refactored.' })).text);
  assert.ok(added.commentId > 0);

  bundle = JSON.parse((await call('get_review_comments', { review_id: reviewId })).text);
  const reply = bundle.threads[0].comments.find((c: { body: string }) => c.body === 'Done — refactored.');
  assert.equal(reply.author, 'claude');

  // resolve_thread → open filter now excludes it
  await call('resolve_thread', { thread_id: threadId });
  bundle = JSON.parse((await call('get_review_comments', { review_id: reviewId })).text);
  assert.equal(bundle.threads.length, 0);
});

test('create_snapshot advances the seq', async () => {
  const snap = JSON.parse((await call('create_snapshot', { review_id: reviewId })).text);
  assert.equal(snap.seq, 2);
});

test('update_thread_status reopens a resolved thread', async () => {
  await call('update_thread_status', { thread_id: threadId, status: 'open' });
  // threadId is on snapshot 1; query it explicitly since latest is now the empty snapshot 2.
  const bundle = JSON.parse(
    (await call('get_review_comments', { review_id: reviewId, snapshot_id: snapshotId })).text,
  );
  assert.equal(bundle.threads.length, 1);
  assert.equal(bundle.threads[0].threadId, threadId);
});

test('list_reviews and get_snapshot_diff', async () => {
  const reviews = JSON.parse((await call('list_reviews', {})).text);
  assert.ok(reviews.some((r: { id: number }) => r.id === reviewId));

  const diff = (await call('get_snapshot_diff', { snapshot_id: snapshotId })).text;
  assert.match(diff, /diff --git/);
  const fileDiff = (await call('get_snapshot_diff', { snapshot_id: snapshotId, file: 'a.txt' })).text;
  assert.match(fileDiff, /a\.txt/);
});

test('tool errors surface as isError results', async () => {
  const bad = await call('start_review', { repo_path: '/no/such/repo/xyz' });
  assert.equal(bad.result.isError, true);
  assert.match(bad.text, /not found/);

  const badDiff = await call('get_snapshot_diff', { snapshot_id: 999999 });
  assert.equal(badDiff.result.isError, true);
  assert.match(badDiff.text, /no such snapshot/);
});
