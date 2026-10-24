// Tests for src/lock.ts: the run lock over a temporary directory with a fixed clock.
// Run: node --test test/lock.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, LOCK_FILE, PARTIAL_GRACE_MS, processIsAlive, STALE_AFTER_MS, type LockContent, type LockDeps } from '../src/lock.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-lock-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const CLOCK = '2026-10-20T10:00:00.000Z';

let dirCounter = 0;

/** A fresh artifacts directory that does not exist yet. */
function freshDir(): string {
  dirCounter += 1;
  return path.join(WORK, `artifacts-${dirCounter}`);
}

function deps(pid: number, isAlive: (pid: number) => boolean = () => true): LockDeps {
  return { now: () => new Date(CLOCK), pid, isAlive };
}

const readLock = (dir: string): LockContent => JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')) as LockContent;

describe('acquireLock', () => {
  test('a free lock is held and the file names the pid, the start and no run yet', () => {
    const dir = freshDir();
    const lock = acquireLock(dir, deps(4242));
    assert.equal(lock.held, true);
    assert.deepEqual(readLock(dir), { pid: 4242, started_at: CLOCK, run_id: null });
    assert.deepEqual(fs.readdirSync(dir), [LOCK_FILE]);
  });

  test('setRunId writes the run id into the file', () => {
    const dir = freshDir();
    const lock = acquireLock(dir, deps(4242));
    assert.ok(lock.held);
    lock.setRunId('20261020T100000Z');
    assert.deepEqual(readLock(dir), { pid: 4242, started_at: CLOCK, run_id: '20261020T100000Z' });
  });

  test('release removes the file', () => {
    const dir = freshDir();
    const lock = acquireLock(dir, deps(4242));
    assert.ok(lock.held);
    lock.release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  });

  test('a second run while the first is alive is refused and learns who holds the lock', () => {
    const dir = freshDir();
    const first = acquireLock(dir, deps(4242));
    assert.ok(first.held);
    const before = fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8');
    const second = acquireLock(dir, deps(5151));
    assert.equal(second.held, false);
    assert.ok(!second.held);
    assert.equal(second.holder.pid, 4242);
    assert.equal(second.holder.started_at, CLOCK);
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), [LOCK_FILE]);
  });

  test('release by a pid that does not own the file leaves it', () => {
    const dir = freshDir();
    const lock = acquireLock(dir, deps(4242));
    assert.ok(lock.held);
    // Somebody else holds the lock file now.
    const foreign = `${JSON.stringify({ pid: 7777, started_at: CLOCK, run_id: null })}\n`;
    fs.writeFileSync(path.join(dir, LOCK_FILE), foreign);
    lock.setRunId('20261020T100000Z');
    lock.release();
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'), foreign);
  });

  test('an artifacts path whose parent is a file throws', () => {
    const blocker = path.join(WORK, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    assert.throws(() => acquireLock(path.join(blocker, 'artifacts'), deps(4242)));
    assert.throws(() => acquireLock(blocker, deps(4242)));
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
  });
});

describe('processIsAlive', () => {
  test('the running process is alive', () => {
    assert.equal(processIsAlive(process.pid), true);
  });

  test('the pid of a child that has exited is not alive', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(child.status, 0);
    assert.equal(typeof child.pid, 'number');
    assert.equal(processIsAlive(child.pid), false);
  });

  for (const pid of [0, -1, 1.5, Number.NaN]) {
    test(`${String(pid)} is not a pid`, () => {
      assert.equal(processIsAlive(pid), false);
    });
  }
});

describe('takeover', () => {
  const MINUTE = 60_000;
  const clockMs = Date.parse(CLOCK);

  /** Writes a lock file as another run left it. */
  function leave(dir: string, content: Partial<LockContent> | string, modifiedAgoMs = 0): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
    const modified = new Date(clockMs - modifiedAgoMs);
    fs.utimesSync(file, modified, modified);
    return file;
  }

  const startedAgo = (ms: number): string => new Date(clockMs - ms).toISOString();
  const aliveOnly =
    (...pids: number[]) =>
    (pid: number): boolean =>
      pids.includes(pid);
  const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name !== LOCK_FILE);

  test('a lock of a dead pid is taken over and the file holds the new pid', () => {
    const dir = freshDir();
    leave(dir, { pid: 7777, started_at: startedAgo(MINUTE), run_id: null });
    const lock = acquireLock(dir, deps(4242, aliveOnly(4242)));
    assert.ok(lock.held);
    assert.equal(lock.takenOver, true);
    assert.equal(readLock(dir).pid, 4242);
    assert.deepEqual(leftovers(dir), []);
  });

  test('a free lock is not a takeover', () => {
    const lock = acquireLock(freshDir(), deps(4242));
    assert.ok(lock.held);
    assert.equal(lock.takenOver, false);
  });

  test('a live pid whose start is exactly the stale age old is stale', () => {
    const dir = freshDir();
    leave(dir, { pid: 7777, started_at: startedAgo(STALE_AFTER_MS), run_id: null });
    const lock = acquireLock(dir, deps(4242, aliveOnly(4242, 7777)));
    assert.ok(lock.held);
    assert.equal(lock.takenOver, true);
  });

  test('a live pid one millisecond younger than the stale age still holds the lock', () => {
    const dir = freshDir();
    leave(dir, { pid: 7777, started_at: startedAgo(STALE_AFTER_MS - 1), run_id: null });
    const lock = acquireLock(dir, deps(4242, aliveOnly(4242, 7777)));
    assert.equal(lock.held, false);
    assert.equal(readLock(dir).pid, 7777);
    assert.deepEqual(leftovers(dir), []);
  });

  test('a lock that holds the pid of the acquiring run is stale', () => {
    const dir = freshDir();
    leave(dir, { pid: 4242, started_at: startedAgo(MINUTE), run_id: null });
    const lock = acquireLock(dir, deps(4242, aliveOnly(4242)));
    assert.ok(lock.held);
    assert.equal(lock.takenOver, true);
  });

  for (const [label, text] of [
    ['empty', ''],
    ['half written', '{"pid": 77'],
    ['without a pid', '{"started_at":"2026-10-20T09:59:00.000Z"}\n'],
  ] as const) {
    test(`a ${label} lock file younger than the grace period is busy`, () => {
      const dir = freshDir();
      const file = leave(dir, text, 2000);
      const lock = acquireLock(dir, deps(4242, aliveOnly(4242)));
      assert.equal(lock.held, false);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.deepEqual(leftovers(dir), []);
    });

    test(`a ${label} lock file older than the grace period is taken over`, () => {
      const dir = freshDir();
      leave(dir, text, PARTIAL_GRACE_MS + 1000);
      const lock = acquireLock(dir, deps(4242, aliveOnly(4242)));
      assert.ok(lock.held);
      assert.equal(lock.takenOver, true);
      assert.equal(readLock(dir).pid, 4242);
      assert.deepEqual(leftovers(dir), []);
    });
  }

  test('of two runs that judge the same stale lock exactly one holds it', () => {
    const dir = freshDir();
    leave(dir, { pid: 7777, started_at: startedAgo(MINUTE), run_id: null });
    const alive = aliveOnly(5151, 6161);
    let first: ReturnType<typeof acquireLock> | undefined;
    // The slower run (6161) has judged the lock stale; the faster one (5151) takes it over in between.
    const second = acquireLock(dir, {
      ...deps(6161, alive),
      afterJudge: () => {
        first = acquireLock(dir, deps(5151, alive));
      },
    });
    assert.ok(first?.held);
    assert.equal(second.held, false);
    assert.equal(readLock(dir).pid, 5151);
    assert.deepEqual(leftovers(dir), []);
    first.release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('without hard links the exclusive create takes a free lock and refuses the next run', () => {
    const noLink = (): void => {
      throw Object.assign(new Error('no hard links here'), { code: 'ENOSYS' });
    };
    const dir = freshDir();
    const first = acquireLock(dir, { ...deps(4242, aliveOnly(4242, 5151)), link: noLink });
    assert.ok(first.held);
    assert.deepEqual(readLock(dir), { pid: 4242, started_at: CLOCK, run_id: null });
    const second = acquireLock(dir, { ...deps(5151, aliveOnly(4242, 5151)), link: noLink });
    assert.equal(second.held, false);
    assert.equal(readLock(dir).pid, 4242);
    assert.deepEqual(leftovers(dir), []);
  });
});
