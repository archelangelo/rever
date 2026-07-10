import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { getReviewComments } from '../src/server/comments.js';
import { openDb } from '../src/server/db.js';
import { startReview } from '../src/server/review.js';

const OUT = process.env.OUT_DIR ?? os.tmpdir();
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m7-'));
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@example.com']);
  g(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export function add(a: number, b: number) {\n  return a - b;\n}\n');
  g(repo, ['add', '.']);

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-m7db-'));
  const db = openDb(path.join(dbDir, 'rever.db'));
  const r = await startReview(db, { repoPath: repo, title: 'M7 review' });

  const server = http.createServer(createApp(db));
  await new Promise<void>((res) => server.listen(0, res));
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Leave an inline comment:');
  await page.goto(url);
  await page.click('[data-testid=review-row]');
  await page.waitForSelector('[data-testid=diff-file]');
  // The changed line is new-side line 2 ("return a - b;").
  await page.click('[data-testid="comment-btn-app.ts:new:2"]');
  await page.fill('[data-testid=composer-textarea]', 'Did you mean + here?');
  await page.click('[data-testid=composer-submit]');
  await page.waitForSelector('[data-testid=thread]');
  assert((await page.textContent('[data-testid=thread]'))?.includes('Did you mean + here?'), 'inline comment appears');
  assert((await page.locator('.draft-badge').count()) >= 1, 'comment shows as draft before publish');

  console.log('Add a summary with a verdict:');
  await page.click('[data-testid=add-summary]');
  await page.fill('[data-testid=summary-textarea]', 'Logic looks inverted, otherwise fine.');
  await page.selectOption('[data-testid=verdict-select]', 'request_changes');
  await page.click('[data-testid=summary-submit]');
  await page.waitForSelector('.verdict-request_changes');
  assert(true, 'summary with request_changes verdict appears');
  await page.screenshot({ path: path.join(OUT, 'm7-drafts.png'), fullPage: true });

  console.log('Publish:');
  const draftsBefore = await page.locator('.draft-badge').count();
  assert(draftsBefore >= 1, `there are ${draftsBefore} draft(s) before publish`);
  await page.click('[data-testid=publish]');
  await page.waitForFunction(() => document.querySelectorAll('.draft-badge').length === 0);
  assert((await page.locator('.draft-badge').count()) === 0, 'no drafts remain after publish');
  await page.screenshot({ path: path.join(OUT, 'm7-published.png'), fullPage: true });

  console.log('Agent-side view (get_review_comments, published only):');
  const bundle = getReviewComments(db, r.reviewId, { status: 'all' });
  const inline = bundle.threads.find((t) => t.kind === 'inline');
  const summary = bundle.threads.find((t) => t.kind === 'summary');
  assert(inline?.comments[0].body === 'Did you mean + here?', 'agent sees the published inline comment');
  assert(inline?.code?.target?.[0] === '  return a - b;', 'agent sees the anchored code line');
  assert(summary?.verdict === 'request_changes', 'agent sees the verdict');

  await browser.close();
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('\nM7 e2e: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
