import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { createThread, getReviewComments, publishReview } from '../src/server/comments.js';
import { openDb } from '../src/server/db.js';
import { getSnapshotStructured, startReview } from '../src/server/review.js';

const OUT = process.env.OUT_DIR ?? os.tmpdir();
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  // Seed: a repo + review + one published human comment on the first added line.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m8-'));
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@example.com']);
  g(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const n = 1;\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const n = 2;\n');
  g(repo, ['add', '.']);

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m8db-'));
  const db = openDb(path.join(dbDir, 'rever.db'));
  const r = await startReview(db, { repoPath: repo, title: 'M8 live-sync' });

  const s = getSnapshotStructured(db, r.snapshotId);
  const addLine = s.files[0].hunks.flatMap((h) => h.lines).find((l) => l.type === 'add')!;
  const thread = createThread(db, {
    snapshotId: r.snapshotId,
    kind: 'inline',
    author: 'user',
    body: 'Should this be a constant?',
    filePath: s.files[0].newPath,
    side: 'new',
    startLine: addLine.newLine!,
    endLine: addLine.newLine!,
  });
  createThread(db, {
    snapshotId: r.snapshotId,
    kind: 'summary',
    author: 'user',
    body: 'Looks good.',
    verdict: 'approve',
  });
  publishReview(db, r.reviewId);

  const server = http.createServer(createApp(db));
  await new Promise<void>((res) => server.listen(0, res));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const agent = new Client({ name: 'agent', version: '0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/review/${r.reviewId}`);
  await page.waitForSelector('[data-testid=thread]');
  console.log('Browser open (no reloads from here on):');

  // 1. Agent replies via MCP → appears live.
  await call('add_comment', { thread_id: thread.threadId, body: 'Yes — made it a const.' });
  await page.waitForFunction(
    () => !!document.body.textContent?.includes('Yes — made it a const.'),
    { timeout: 5000 },
  );
  assert(true, 'agent reply appeared live (no reload)');

  // 2. Agent resolves via MCP → resolved badge appears live.
  await call('resolve_thread', { thread_id: thread.threadId });
  await page.waitForSelector('.resolved-badge', { timeout: 5000 });
  assert(true, 'resolved badge appeared live');

  // 3. Agent creates a snapshot via MCP → new option appears in the switcher live.
  await call('create_snapshot', { review_id: r.reviewId });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=snapshot-switcher] option').length === 2,
    { timeout: 5000 },
  );
  assert(true, 'new snapshot appeared in the switcher live');
  await page.screenshot({ path: path.join(OUT, 'm8-live.png'), fullPage: true });

  // 4. Loop-end signal: the bundle surfaces the verdict.
  const bundle = getReviewComments(db, r.reviewId, { snapshotId: r.snapshotId, status: 'all' });
  assert(bundle.verdict === 'approve', 'get_review_comments exposes verdict=approve (loop-end signal)');

  await browser.close();
  await agent.close();
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('\nM8 e2e: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
