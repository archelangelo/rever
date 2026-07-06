import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { ensureSingleInstance } from './instance.js';
import { DB_PATH, getPort } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// After build this file is dist/server/index.js, so the web bundle is dist/web.
const WEB_DIST = path.resolve(__dirname, '../web');

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

export function createApp(db = openDb()) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    let reviews = -1;
    try {
      reviews = (db.prepare('SELECT COUNT(*) AS n FROM review').get() as { n: number }).n;
    } catch {
      /* leave -1 to signal a DB problem */
    }
    res.json({
      status: 'ok',
      pid: process.pid,
      db: DB_PATH,
      reviews,
      uptime: process.uptime(),
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

function main() {
  ensureSingleInstance();
  const app = createApp();
  const port = getPort();
  app.listen(port, () => {
    console.log(`Rever daemon listening on http://localhost:${port}`);
  });
}

main();
