import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus } from './bus.js';
import { addComment, createThread, getSnapshotThreads, publishReview } from './comments.js';
import type { Db } from './db.js';
import { openDb } from './db.js';
import { createMcpServer } from './mcp.js';
import { DB_PATH } from './paths.js';
import { getReviewDetail, getSnapshotStructured, listReviews } from './review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// After build this file is dist/server/app.js, so the web bundle is dist/web.
// REVER_WEB_DIST overrides it (e.g. when running the server from source via tsx in tests).
const WEB_DIST = process.env.REVER_WEB_DIST
  ? path.resolve(process.env.REVER_WEB_DIST)
  : path.resolve(__dirname, '../web');

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Rever</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
  </head>
  <body>
    <h1>Rever</h1>
    <p>Daemon is running. The web UI bundle isn't built yet — run <code>npm run build:web</code>
    (or <code>npm run dev</code> for the Vite dev server).</p>
    <p><a href="/health">/health</a></p>
  </body>
</html>`;

export function createApp(db: Db = openDb()): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    let reviews = -1;
    try {
      reviews = (db.prepare('SELECT COUNT(*) AS n FROM review').get() as { n: number }).n;
    } catch {
      /* leave -1 to signal a DB problem */
    }
    res.json({ status: 'ok', pid: process.pid, db: DB_PATH, reviews, uptime: process.uptime() });
  });

  // MCP endpoint (Streamable HTTP, stateless request/response). Registered before the web
  // catch-all so it isn't shadowed. A fresh server+transport per request avoids cross-call state.
  app.post('/mcp', async (req, res) => {
    const mcp = createMcpServer(db);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

  // REST API for the browser UI (distinct from the agent's MCP surface).
  app.get('/api/reviews', (_req, res) => {
    res.json(listReviews(db));
  });
  app.get('/api/reviews/:id', (req, res) => {
    try {
      res.json(getReviewDetail(db, Number(req.params.id)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
  app.get('/api/snapshots/:id/diff', (req, res) => {
    try {
      res.json(getSnapshotStructured(db, Number(req.params.id)));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // Comment authoring (browser = the human reviewer; author is always "user", drafted).
  app.get('/api/snapshots/:id/threads', (req, res) => {
    res.json(getSnapshotThreads(db, Number(req.params.id)));
  });
  app.post('/api/snapshots/:id/threads', (req, res) => {
    try {
      const b = req.body ?? {};
      res.json(
        createThread(db, {
          snapshotId: Number(req.params.id),
          kind: b.kind,
          author: 'user',
          body: b.body,
          filePath: b.filePath,
          side: b.side,
          startLine: b.startLine,
          endLine: b.endLine,
          verdict: b.verdict,
        }),
      );
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post('/api/threads/:id/comments', (req, res) => {
    try {
      const b = req.body ?? {};
      res.json(
        addComment(db, {
          threadId: Number(req.params.id),
          author: 'user',
          body: b.body,
          parentCommentId: b.parentCommentId,
        }),
      );
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post('/api/reviews/:id/publish', (req, res) => {
    res.json(publishReview(db, Number(req.params.id)));
  });

  // Live updates: SSE stream that emits a `change` event whenever review data mutates
  // (via REST or MCP). The browser refetches on each. Heartbeat keeps the connection alive.
  app.get('/api/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const onChange = () => res.write('event: change\ndata: {}\n\n');
    bus.on('change', onChange); // subscribe before flushing, so no change is missed
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('change', onChange);
    });
  });

  const indexHtml = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (_req, res) => res.sendFile(indexHtml));
  } else {
    app.get('/', (_req, res) => res.type('html').send(PLACEHOLDER_HTML));
  }

  return app;
}
