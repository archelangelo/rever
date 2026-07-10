import { addComment, createThread, publishReview, resolveThread } from '../src/server/comments.js';
import { openDb } from '../src/server/db.js';
import { getSnapshotStructured, startReview } from '../src/server/review.js';

// Seeds a populated review into whatever REVER_HOME points at, so the demo site isn't empty.
async function main() {
  const repo = process.cwd();
  const db = openDb();
  const r = await startReview(db, { repoPath: repo, title: 'Demo: staged review of Rever' });

  // Find a real added line to anchor an inline comment.
  const structured = getSnapshotStructured(db, r.snapshotId);
  let anchor: { filePath: string; line: number } | null = null;
  outer: for (const f of structured.files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add' && l.newLine != null && f.newPath) {
          anchor = { filePath: f.newPath, line: l.newLine };
          break outer;
        }
      }
    }
  }

  // Summary + verdict (published).
  createThread(db, {
    snapshotId: r.snapshotId,
    kind: 'summary',
    author: 'user',
    body: 'Nice work — a couple of inline notes, otherwise looks good.',
    verdict: 'request_changes',
    publish: true,
  });

  if (anchor) {
    const t = createThread(db, {
      snapshotId: r.snapshotId,
      kind: 'inline',
      author: 'user',
      body: 'Can we add a test that covers this branch?',
      filePath: anchor.filePath,
      side: 'new',
      startLine: anchor.line,
      endLine: anchor.line,
    });
    publishReview(db, r.reviewId);
    // Agent replies + resolves, to show the two-sided conversation.
    addComment(db, { threadId: t.threadId, author: 'claude', body: 'Good call — added a test for it.' });
    resolveThread(db, t.threadId);
  }

  db.close();
  console.log(`Seeded review #${r.reviewId} (${structured.files.length} files) into REVER_HOME.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
