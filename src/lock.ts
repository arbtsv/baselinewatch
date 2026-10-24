// The run lock: artifacts/.lock, a JSON file with the pid, the start time and the run id of the run
// that holds it. A second `blw run` that finds a live holder stops without writing anything. This
// module uses node:fs and node:path only and loads no Playwright module.
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = '.lock';
/**
 * A lock whose start is this old is stale even when its pid is alive: a hard kill leaves the lock with
 * a dead pid, and Windows reuses pids, so another process may carry that pid and look like the holder.
 * This bounds how long that can blind the monitor. The longest run is about 35 minutes (two passes of
 * at most 15 minutes, their watchdog grace and the zip), so an hour leaves room.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;
/** A lock file that cannot be parsed is a half-written one for this long, then it is stale. */
export const PARTIAL_GRACE_MS = 10_000;

export type LockContent = { pid: number; started_at: string; run_id: string | null };

export type LockDeps = {
  now: () => Date;
  pid: number;
  /** True when the pid belongs to a live process; EPERM counts as alive. */
  isAlive: (pid: number) => boolean;
  /** Publishes a file under a second name; defaults to fs.linkSync. A test replaces it. */
  link?: (existing: string, newPath: string) => void;
  /** Test seam between a stale verdict and the rename that takes the file aside. */
  afterJudge?: () => void;
  /** Test seam: reads the file that was taken aside; defaults to fs.readFileSync. */
  readAside?: (file: string) => string;
};

export type LockResult =
  | { held: true; takenOver: boolean; setRunId: (runId: string) => void; release: () => void }
  | { held: false; holder: Partial<LockContent> };

/** process.kill(pid, 0): alive when it does not throw, or throws EPERM (another user's process). */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// What blw writes: toISOString(). Date.parse alone also takes free text, so the start is matched
// strictly: it is printed to the console when a run finds the lock held.
const STARTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function parse(text: string): LockContent | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.started_at !== 'string' ||
      !STARTED_AT.test(value.started_at) ||
      !Number.isFinite(Date.parse(value.started_at))
    ) {
      return undefined;
    }
    return { pid: value.pid, started_at: value.started_at, run_id: typeof value.run_id === 'string' ? value.run_id : null };
  } catch {
    return undefined;
  }
}

// Writes the whole content to a private name and links it to the lock name: the lock file is never
// visible empty, and the link fails with EEXIST when somebody else holds the lock. A file system
// without hard links falls back to the exclusive create, which can show the file empty for a moment;
// a reader treats an unreadable file younger than PARTIAL_GRACE_MS as held, so that is safe too.
function publish(lockFile: string, content: LockContent, deps: LockDeps): boolean {
  const link = deps.link ?? fs.linkSync;
  const text = `${JSON.stringify(content)}\n`;
  const temp = `${lockFile}.${content.pid}.new`;
  fs.writeFileSync(temp, text, 'utf8');
  try {
    link(temp, lockFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    return createExclusively(lockFile, text);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// The fallback of publish: open with 'wx', write, close. EEXIST means somebody else holds the lock.
function createExclusively(lockFile: string, text: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

type Verdict = { kind: 'gone' } | { kind: 'busy'; holder: Partial<LockContent> } | { kind: 'stale'; text: string };

// Free, held by a run that is still working, or left behind. A lock is left behind when its pid is
// dead, when it holds the pid of this very run (an earlier run that died, whose pid this process got),
// or when it is STALE_AFTER_MS old, which also bounds the harm of a pid that another process reused.
// A file that cannot be read as a lock is a lock that is being written for PARTIAL_GRACE_MS.
function judge(lockFile: string, deps: LockDeps): Verdict {
  let text: string;
  let modified: number;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
    modified = fs.statSync(lockFile).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'busy', holder: {} };
  }
  const now = deps.now().getTime();
  const content = parse(text);
  if (content === undefined) {
    return now - modified < PARTIAL_GRACE_MS ? { kind: 'busy', holder: {} } : { kind: 'stale', text };
  }
  const left = content.pid === deps.pid || !deps.isAlive(content.pid) || now - Date.parse(content.started_at) >= STALE_AFTER_MS;
  return left ? { kind: 'stale', text } : { kind: 'busy', holder: content };
}

// Puts a file that was taken aside by mistake back under the lock name. Somebody else may hold the
// lock again by now, and then the file stays aside and is deleted: that holder wins. The text is known
// when the file could be read; without it a file system with no hard links gets the file back by a
// rename, unless the name is taken in the meantime.
function giveBack(aside: string, lockFile: string, text: string | undefined, deps: LockDeps): void {
  try {
    (deps.link ?? fs.linkSync)(aside, lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return;
    }
    if (text !== undefined) {
      createExclusively(lockFile, text);
    } else if (!fs.existsSync(lockFile)) {
      try {
        fs.renameSync(aside, lockFile);
      } catch {
        // The file stays aside; the next run judges whatever the lock name holds.
      }
    }
  }
}

/**
 * Takes the lock in artifacts, or says who holds it. The artifacts directory is created when missing
 * and an error from that propagates. A lock that was left behind is taken over: renamed aside under a
 * name of this run, read again and compared with what was judged. A different text means that a slower
 * judge than the one that won has just carried off a fresh lock of its neighbour, so it is given back.
 * Of two runs that see the same stale lock exactly one holds it. The window of the give-back (the
 * neighbour's lock is missing for a moment) can only matter for a third run at that very moment.
 */
export function acquireLock(artifactsDir: string, deps: LockDeps): LockResult {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const lockFile = path.join(artifactsDir, LOCK_FILE);
  const mine = (): LockContent => ({ pid: deps.pid, started_at: deps.now().toISOString(), run_id: null });
  let takenOver = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const verdict = judge(lockFile, deps);
    if (verdict.kind === 'busy') {
      return { held: false, holder: verdict.holder };
    }
    if (verdict.kind === 'stale') {
      deps.afterJudge?.();
      const aside = `${lockFile}.stale-${deps.pid}`;
      try {
        fs.renameSync(lockFile, aside);
      } catch {
        continue; // somebody else moved or replaced it first: judge again
      }
      let moved: string | undefined;
      try {
        moved = (deps.readAside ?? ((file: string) => fs.readFileSync(file, 'utf8')))(aside);
      } catch {
        moved = undefined;
      }
      // A file that cannot be read is not shown to be the stale one, so it goes back like a different one.
      if (moved !== verdict.text) {
        giveBack(aside, lockFile, moved, deps);
        fs.rmSync(aside, { force: true });
        continue;
      }
      fs.rmSync(aside, { force: true });
      takenOver = true;
    }
    if (publish(lockFile, mine(), deps)) {
      return held(lockFile, deps, takenOver);
    }
  }
  return { held: false, holder: {} };
}

function held(lockFile: string, deps: LockDeps, takenOver: boolean): LockResult {
  return {
    held: true,
    takenOver,
    setRunId(runId) {
      // Best effort: the run id only helps a person read the file; liveness uses pid and started_at.
      try {
        const content = parse(fs.readFileSync(lockFile, 'utf8'));
        if (content?.pid === deps.pid) {
          fs.writeFileSync(lockFile, `${JSON.stringify({ ...content, run_id: runId })}\n`, 'utf8');
        }
      } catch {
        // ignored
      }
    },
    release() {
      try {
        const content = parse(fs.readFileSync(lockFile, 'utf8'));
        if (content?.pid === deps.pid) {
          fs.rmSync(lockFile, { force: true });
        }
      } catch {
        // already gone, or held by an antivirus scan: a dead pid makes the file stale for the next run
      }
    },
  };
}
