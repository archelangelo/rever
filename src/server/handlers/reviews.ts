import type { Ctx } from '../context.js';
import type { ReviewsDao } from '../data/reviews.js';
import type { ReviewSummary } from '../review.js';

export interface ListReviewsInput {
  repoPath?: string;
}

/**
 * Reviews handler — layer 2, the spine. Holds its DAO (C13), returns plain data
 * and throws domain errors (C5), and takes `ctx` on every method including reads
 * (C11) even where it goes unused, so reads and writes share one signature shape.
 * One instance is shared by both transports (C3).
 */
export function makeReviewsHandler(dao: ReviewsDao) {
  return {
    list(_ctx: Ctx, input: ListReviewsInput): ReviewSummary[] {
      return dao.listSummaries(input.repoPath);
    },
  };
}

export type ReviewsHandler = ReturnType<typeof makeReviewsHandler>;
