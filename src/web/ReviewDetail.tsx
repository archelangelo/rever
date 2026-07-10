import { useCallback, useEffect, useState } from 'react';
import {
  addReply,
  createThread,
  getReviewDetail,
  getSnapshotDiff,
  getSnapshotThreads,
  publishReview,
  type NewThread,
  type ReviewDetail as Detail,
  type SnapshotStructured,
  type UiThread,
} from './api.js';
import { SummaryComposer, ThreadView } from './CommentUI.js';
import { DiffView } from './DiffView.js';

export function ReviewDetail({ reviewId, navigate }: { reviewId: number; navigate: (to: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);
  const [diff, setDiff] = useState<SnapshotStructured | null>(null);
  const [threads, setThreads] = useState<UiThread[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getReviewDetail(reviewId)
      .then((d) => {
        setDetail(d);
        setSnapshotId(d.snapshots.at(-1)?.id ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [reviewId]);

  const refreshThreads = useCallback(() => {
    if (snapshotId != null) getSnapshotThreads(snapshotId).then(setThreads).catch((e) => setError(String(e)));
  }, [snapshotId]);

  useEffect(() => {
    if (snapshotId == null) return;
    setDiff(null);
    getSnapshotDiff(snapshotId).then(setDiff).catch((e) => setError(String(e)));
    refreshThreads();
  }, [snapshotId, refreshThreads]);

  const onCreateThread = async (input: NewThread) => {
    if (snapshotId == null) return;
    await createThread(snapshotId, input);
    refreshThreads();
  };
  const onReply = async (threadId: number, body: string) => {
    await addReply(threadId, body);
    refreshThreads();
  };
  const onPublish = async () => {
    await publishReview(reviewId);
    refreshThreads();
  };

  if (error) return <main className="page"><p className="error">{error}</p></main>;
  if (!detail) return <main className="page"><p>Loading…</p></main>;

  const draftCount =
    threads.filter((t) => !t.published).length +
    threads.reduce((n, t) => n + t.comments.filter((c) => !c.published).length, 0);
  const summaries = threads.filter((t) => t.kind === 'summary');

  return (
    <main className="page wide">
      <div className="detail-top">
        <button className="back" onClick={() => navigate('/')}>
          ← all reviews
        </button>
        <button className="publish primary" data-testid="publish" disabled={draftCount === 0} onClick={onPublish}>
          Publish {draftCount > 0 ? `(${draftCount})` : ''}
        </button>
      </div>
      <h1>{detail.title ?? `${detail.selector} review`}</h1>
      <p className="repo-path">
        {detail.repoPath}
        {!detail.repoExists && <span className="warn" data-testid="repo-missing"> · path not found</span>}
      </p>

      <SummaryPanel summaries={summaries} onCreateThread={onCreateThread} onReply={onReply} />

      <div className="switcher">
        <label htmlFor="snap">Snapshot</label>
        <select
          id="snap"
          data-testid="snapshot-switcher"
          value={snapshotId ?? ''}
          onChange={(e) => setSnapshotId(Number(e.target.value))}
        >
          {detail.snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.seq} · +{s.insertions} −{s.deletions} · {s.filesChanged} file{s.filesChanged === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </div>

      {diff ? <DiffView files={diff.files} threads={threads} onCreateThread={onCreateThread} onReply={onReply} /> : <p>Loading diff…</p>}
    </main>
  );
}

function SummaryPanel({
  summaries,
  onCreateThread,
  onReply,
}: {
  summaries: UiThread[];
  onCreateThread: (input: NewThread) => void;
  onReply: (threadId: number, body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="summary-panel" data-testid="summary-panel">
      <h2>Review summary</h2>
      {summaries.map((t) => (
        <ThreadView key={t.threadId} thread={t} onReply={onReply} />
      ))}
      {open ? (
        <SummaryComposer
          onSubmit={(body, verdict) => {
            onCreateThread({ kind: 'summary', body, verdict });
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <button data-testid="add-summary" onClick={() => setOpen(true)}>
          + Add summary
        </button>
      )}
    </section>
  );
}
