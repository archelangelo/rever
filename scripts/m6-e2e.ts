import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { openDb } from '../src/server/db.js';
import { createSnapshot, startReview } from '../src/server/review.js';

const OUT = process.env.OUT_DIR ?? os.tmpdir();
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  // ── Seed a repo + review with two snapshots ──────────────────────────────────
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-e2e-'));
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@example.com']);
  g(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'init']);
  // snapshot 1: modify app.ts
  fs.writeFileSync(
    path.join(repo, 'app.ts'),
    'export function add(a: number, b: number) {\n  // sum two numbers\n  return a + b;\n}\n',
  );
  g(repo, ['add', '.']);

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rever-e2edb-'));
  const db = openDb(path.join(dbDir, 'rever.db'));
  const r = await startReview(db, { repoPath: repo, title: 'Demo review' });

  // snapshot 2: also add util.ts
  fs.writeFileSync(path.join(repo, 'util.ts'), 'export const version = 1;\n');
  g(repo, ['add', '.']);
  await createSnapshot(db, r.reviewId);

  const server = http.createServer(createApp(db));
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;

  // ── Drive the UI with a real browser ─────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Review list:');
  await page.goto(url);
  await page.waitForSelector('[data-testid=review-row]');
  const rowText = await page.textContent('[data-testid=review-row]');
  assert(rowText?.includes('Demo review'), 'list shows the review title');
  assert(rowText?.includes('2 snapshots'), 'list shows snapshot count');
  await page.screenshot({ path: path.join(OUT, 'm6-list.png') });

  console.log('Review detail (latest snapshot = #2):');
  await page.click('[data-testid=review-row]');
  await page.waitForSelector('[data-testid=diff-file]');
  const paths1 = await page.$$eval('[data-testid=file-path]', (els) => els.map((e) => e.textContent));
  assert(paths1.some((p) => p?.includes('app.ts')), 'diff shows app.ts');
  assert(paths1.some((p) => p?.includes('util.ts')), 'snapshot #2 shows util.ts');
  const adds = await page.$$eval('[data-testid=file-additions]', (els) => els.map((e) => e.textContent));
  assert(
    adds.every((a) => /^\+\d+$/.test(a ?? '')),
    'each file shows an additions count',
  );
  await page.screenshot({ path: path.join(OUT, 'm6-detail-snap2.png'), fullPage: true });

  console.log('Switch to snapshot #1:');
  await page.selectOption('[data-testid=snapshot-switcher]', { index: 0 });
  await page.waitForFunction(() =>
    !Array.from(document.querySelectorAll('[data-testid=file-path]')).some((e) => e.textContent?.includes('util.ts')),
  );
  const paths2 = await page.$$eval('[data-testid=file-path]', (els) => els.map((e) => e.textContent));
  assert(paths2.some((p) => p?.includes('app.ts')), 'snapshot #1 still shows app.ts');
  assert(!paths2.some((p) => p?.includes('util.ts')), 'snapshot #1 does NOT show util.ts (switcher works)');
  await page.screenshot({ path: path.join(OUT, 'm6-detail-snap1.png'), fullPage: true });

  await browser.close();
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('\nM6 e2e: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
