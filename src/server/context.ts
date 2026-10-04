import type { Author } from '../types/index.js';

/**
 * Per-request context, established by wiring: who is making the request.
 *
 * Plain data about the caller only — never a db handle, logger, or service (C11),
 * so a handler's real dependencies stay visible in its constructor, not hidden here.
 * One field for now; a field is added only when something actually reads it.
 *
 * `user`'s type is `Author` until the Author -> UserId rename lands (I3).
 */
export interface Ctx {
  user: Author; // 'user' from HTTP (the human reviewer), 'claude' from MCP (the agent)
}
