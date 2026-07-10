import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { openDb } from '../src/server/db.js';

const OUT = process.env.OUT_DIR ?? os.tmpdir();
const REPO = process.cwd();

async function main() {
  // Isolated demo DB so we don't touch ~/.rever.
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-demo-'));
  const db = openDb(path.join(dbDir, 'rever.db'));
  const server = http.createServer(createApp(db));
  await new Promise<void>((res) => server.listen(0, res));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const agent = new Client({ name: 'demo-agent', version: '0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await agent.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0].text);
  };

  console.log('\n── AGENT: start_review on this repo (staged changes) ──');
  const sr = await call('start_review', { repo_path: REPO });
  console.log(`  reviewId=${sr.reviewId} snapshotId=${sr.snapshotId}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/review/${sr.reviewId}`);
  await page.waitForSelector('[data-testid=diff-file]');
  const fileCount = await page.locator('[data-testid=diff-file]').count();
  console.log(`\n── HUMAN: opened the review in the browser — ${fileCount} files ──`);
  await page.screenshot({ path: path.join(OUT, 'demo-1-diff.png') });

  // Comment on a real source line: prefer a src/ file's new-side line.
  const btnIds = await page.$$eval('[data-testid^="comment-btn-"]', (els) => els.map((e) => e.getAttribute('data-testid')!));
  const target = btnIds.find((id) => /comment-btn-src\/.*:new:/.test(id)) ?? btnIds[0];
  console.log(`  commenting on: ${target?.replace('comment-btn-', '')}`);
  await page.click(`[data-testid="${target}"]`);
  await page.fill('[data-testid=composer-textarea]', 'Can we add a test that covers this branch?');
  await page.click('[data-testid=composer-submit]');
  await page.waitForSelector('[data-testid=thread]');

  await page.click('[data-testid=add-summary]');
  await page.fill('[data-testid=summary-textarea]', 'Solid change. One inline nit before merge.');
  await page.selectOption('[data-testid=verdict-select]', 'request_changes');
  await page.click('[data-testid=summary-submit]');
  await page.waitForSelector('.verdict-request_changes');

  const drafts = await page.locator('.draft-badge').count();
  console.log(`  left an inline comment + a summary (verdict: request_changes) — ${drafts} drafts`);
  await page.screenshot({ path: path.join(OUT, 'demo-2-drafts.png') });

  console.log('\n── HUMAN: hit Publish ──');
  await page.click('[data-testid=publish]');
  await page.waitForFunction(() => document.querySelectorAll('.draft-badge').length === 0);

  console.log('\n── AGENT: get_review_comments (what Claude Code receives) ──');
  const bundle = await call('get_review_comments', { review_id: sr.reviewId });
  const inline = bundle.threads.find((t: { kind: string }) => t.kind === 'inline');
  console.log(`  thread on ${inline.filePath}:${inline.startLine} (${inline.side})`);
  console.log(`  comment: "${inline.comments[0].body}"`);
  console.log(`  code:\n${inline.code.snippet.split('\n').map((l: string) => '      ' + l).join('\n')}`);
  const summary = bundle.threads.find((t: { kind: string }) => t.kind === 'summary');
  console.log(`  verdict: ${summary.verdict}`);

  console.log('\n── AGENT: reply + resolve ──');
  await call('add_comment', { thread_id: inline.threadId, body: 'Good call — added a test for it.' });
  await call('resolve_thread', { thread_id: inline.threadId });

  await page.reload();
  await page.waitForSelector('[data-testid=diff-file]');
  console.log('  (human refreshes → sees the agent reply + resolved badge)');
  await page.screenshot({ path: path.join(OUT, 'demo-3-resolved.png'), fullPage: false });

  await browser.close();
  await agent.close();
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('\nDemo complete. Screenshots in', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
