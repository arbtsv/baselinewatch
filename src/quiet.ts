// Cleanup that must never change how a run ends. On Windows an antivirus scan or an indexer can hold a
// file for a moment, and fs.rmSync then throws EBUSY or EPERM. A cleanup that runs in a finally block
// and throws would replace the outcome the run had already decided (a built zip, a held lock).
// node:fs only; no Playwright module is loaded here.
import fs from 'node:fs';

const TRIES = 3;
const PAUSE_MS = 50;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Removes a file, or a directory with recursive, and never throws. A target that is held is tried
 * three times with a short pause, then left for the next run (or for retention). Returns whether the
 * target is gone; a target that does not exist counts as gone.
 */
export function removeQuietly(target: string, options: { recursive?: boolean } = {}): boolean {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: options.recursive === true, force: true });
      return true;
    } catch {
      if (attempt + 1 < TRIES) {
        pause(PAUSE_MS);
      }
    }
  }
  return false;
}
