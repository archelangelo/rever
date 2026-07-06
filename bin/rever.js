#!/usr/bin/env node
// Launches the Rever daemon from the built server bundle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../dist/server/index.js');

if (!fs.existsSync(entry)) {
  console.error('rever: server not built. Run `npm run build` first (or `npm run dev`).');
  process.exit(1);
}

await import(entry);
