import fs from 'node:fs';
import { PID_PATH, REVER_DIR } from './paths.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce a single daemon: if a live pidfile exists, refuse to start.
 * A stale pidfile (process gone) is reclaimed. Registers cleanup on exit.
 */
export function ensureSingleInstance(): void {
  fs.mkdirSync(REVER_DIR, { recursive: true });

  if (fs.existsSync(PID_PATH)) {
    const existing = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    if (existing && existing !== process.pid && isAlive(existing)) {
      console.error(
        `rever: a daemon is already running (pid ${existing}). Refusing to start a second instance.`,
      );
      process.exit(1);
    }
    fs.rmSync(PID_PATH, { force: true }); // stale — reclaim
  }

  fs.writeFileSync(PID_PATH, String(process.pid));

  const cleanup = () => {
    try {
      const owner = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
      if (owner === process.pid) fs.rmSync(PID_PATH, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}
