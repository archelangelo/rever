import { useEffect, useState } from 'react';
import { getReviews, type ReviewSummary } from './api.js';

function repoName(p: string): string {
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function ReviewList({ navigate }: { navigate: (to: string) => void }) {
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getReviews().then(setReviews).catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="page">
      <h1>Rever</h1>
      {error && <p className="error">{error}</p>}
      {reviews && reviews.length === 0 && <p className="empty">No reviews yet. Start one from Claude Code.</p>}
      {reviews && reviews.length > 0 && (
        <ul className="review-list">
          {reviews.map((r) => (
            <li key={r.id}>
              <button className="review-row" onClick={() => navigate(`/review/${r.id}`)} data-testid="review-row">
                <span className="repo">{repoName(r.repoPath)}</span>
                <span className="title">{r.title ?? `${r.selector} review`}</span>
                <span className="meta">
                  {r.snapshots} snapshot{r.snapshots === 1 ? '' : 's'} · {new Date(r.createdAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
