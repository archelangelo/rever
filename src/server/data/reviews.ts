import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';
import type { ReviewSummary } from '../review.js';

interface ReviewRow {
  id: number;
  repo_path: string;
  selector: string;
  title: string | null;
  status: string;
  created_at: string;
}

/** Best-effort canonicalization to match the form repo paths are stored in; never throws. */
function bestPath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Reviews DAO — persistence for the review aggregate (review + snapshot tables).
 * Holds `db` privately (C13); SQL lives here and nowhere above it (C12). Methods
 * may name any table the query needs — the review/snapshot join below is
 * intra-aggregate, so it stays entirely within this DAO.
 */
export function makeReviewsDao(db: Db) {
  return {
    /** Reviews newest-first, optionally filtered to one repo, each with a snapshot count + latest seq. */
    listSummaries(repoPath?: string): ReviewSummary[] {
      const rows = (
        repoPath
          ? db.prepare('SELECT * FROM review WHERE repo_path = ? ORDER BY id DESC').all(bestPath(repoPath))
          : db.prepare('SELECT * FROM review ORDER BY id DESC').all()
      ) as ReviewRow[];
      // N+1 by aggregate: one count per review. Behaviour-preserved from the pre-refactor
      // version; a LEFT JOIN ... GROUP BY would fold it into one query (C12) — deferred.
      return rows.map((r) => {
        const agg = db
          .prepare('SELECT COUNT(*) AS n, MAX(seq) AS m FROM snapshot WHERE review_id = ?')
          .get(r.id) as { n: number; m: number | null };
        return {
          id: r.id,
          repoPath: r.repo_path,
          selector: r.selector,
          title: r.title,
          status: r.status,
          createdAt: r.created_at,
          snapshots: agg.n,
          latestSeq: agg.m,
        };
      });
    },
  };
}

export type ReviewsDao = ReturnType<typeof makeReviewsDao>;
