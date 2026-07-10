import type { FileDiff } from '../types/index.js';
import type { UiThread } from '../server/comments.js';
import type { ReviewDetail, ReviewSummary, SnapshotStructured } from '../server/review.js';

export type { FileDiff, ReviewDetail, ReviewSummary, SnapshotStructured, UiThread };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errText(res));
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res));
  return res.json() as Promise<T>;
}

const errText = (res: Response) =>
  res
    .json()
    .then((b: { error?: string }) => b.error ?? res.statusText)
    .catch(() => res.statusText);

export const getReviews = () => fetchJson<ReviewSummary[]>('/api/reviews');
export const getReviewDetail = (id: number) => fetchJson<ReviewDetail>(`/api/reviews/${id}`);
export const getSnapshotDiff = (id: number) => fetchJson<SnapshotStructured>(`/api/snapshots/${id}/diff`);
export const getSnapshotThreads = (id: number) => fetchJson<UiThread[]>(`/api/snapshots/${id}/threads`);

export interface NewThread {
  kind: 'inline' | 'file' | 'summary';
  body: string;
  filePath?: string | null;
  side?: 'old' | 'new' | null;
  startLine?: number | null;
  endLine?: number | null;
  verdict?: 'approve' | 'request_changes' | 'comment' | null;
}

export const createThread = (snapshotId: number, input: NewThread) =>
  postJson<{ threadId: number; commentId: number }>(`/api/snapshots/${snapshotId}/threads`, input);
export const addReply = (threadId: number, body: string, parentCommentId?: number) =>
  postJson<{ commentId: number }>(`/api/threads/${threadId}/comments`, { body, parentCommentId });
export const publishReview = (reviewId: number) =>
  postJson<{ threads: number; comments: number }>(`/api/reviews/${reviewId}/publish`, {});
