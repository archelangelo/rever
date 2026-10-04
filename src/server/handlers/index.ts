import type { Db } from '../db.js';
import { makeReviewsDao } from '../data/reviews.js';
import { makeReviewsHandler } from './reviews.js';

/**
 * Composition root for layer 2: builds each DAO (holding `db`) and each handler
 * (holding its DAO), so `db` is quarantined to the data tier — nothing above
 * `data/` names it (C13). Wiring calls this once and shares the result across
 * both the HTTP and MCP transports (C3).
 */
export function makeHandlers(db: Db) {
  const reviews = makeReviewsHandler(makeReviewsDao(db));
  return { reviews };
}

export type Handlers = ReturnType<typeof makeHandlers>;
