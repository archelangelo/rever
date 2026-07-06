import os from 'node:os';
import path from 'node:path';

/** Central Rever home (multi-repo daemon state lives here). */
export const REVER_DIR = process.env.REVER_HOME
  ? path.resolve(process.env.REVER_HOME)
  : path.join(os.homedir(), '.rever');

export const DB_PATH = path.join(REVER_DIR, 'rever.db');
export const PID_PATH = path.join(REVER_DIR, 'rever.pid');

export const DEFAULT_PORT = 7910;

export function getPort(): number {
  const raw = process.env.REVER_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid REVER_PORT: ${raw}`);
  }
  return n;
}
