import { EventEmitter } from 'node:events';

// In-process pub/sub for live UI updates. Callers above the data layer signal a successful
// mutation with notifyChange(); the SSE endpoint (GET /api/events) forwards each to connected
// browsers, which then refetch. The data layer stays unaware of it (see CODE_NOTES C8).
// v1 is coarse — one global "change" signal, no per-review scoping (fine for single-user).
export const bus = new EventEmitter();
bus.setMaxListeners(0); // allow arbitrarily many SSE clients

export function notifyChange(): void {
  bus.emit('change');
}
