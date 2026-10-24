// The run lock through real processes: a second `blw run` started while the first one holds the lock is
// refused without touching the live run's files, and a run that starts after the first was killed hard
// takes the lock over. A lock that is too old, or whose process is gone, is taken over the same way.
//
// The hard-kill test runs on Windows only: taskkill /T ends the whole tree there, while elsewhere the
// Playwright child of a killed blw would live on in its own process group.
//
// Run: npm run e2e -- test/e2e/lock.spec.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_ARTIFACTS_DIR,
  REPO_ROOT,
  cleanArtifacts,
  demoEnv,
  outputLines,
  readArtifactJson,
  runBlw,
  startBlw,
  withBaselines,
  withDemoEnv,
  withScenario,
  type RunResult,
} from '../helpers/demo.ts';
import { startPortal } from '../helpers/portal.ts';

const LOCK_FILE = path.join(DEMO_ARTIFACTS_DIR, '.lock');

// A run that has finished its one pass takes about this long; the safety net for every run below.
const RUN_TIMEOUT_MS = 150_000;

type Summary = { run_id: string; warnings: { code: string }[] };
type Lock = { pid: number; started_at: string; run_id: string | null };

// A scenario that tells the test it is running and then stays in the test body for a long time.
const HOLD_SOURCE = `import fs from 'node:fs';
import { test } from 'baselinewatch';

test('hold the run open', async ({ page }) => {
  await page.goto('/');
  fs.writeFileSync(process.env.BLW_E2E_MARKER as string, 'started');
  await page.waitForTimeout(25_000);
});
`;

/** Polls until the condition holds; a fixed sleep would make the test slow or flaky. */
async function waitFor(what: string, condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readLock(): Lock | undefined {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as Lock;
  } catch {
    return undefined;
  }
}

/** One run of the demo scenario against an ok portal while the given lock file is in place. */
async function runWithLock(lock: Lock): Promise<{ run: RunResult; summary: Summary }> {
  cleanArtifacts();
  fs.mkdirSync(DEMO_ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock)}\n`);
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const run = await withDemoEnv(env, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }));
    expect(run.timedOut).toBe(false);
    return { run, summary: readArtifactJson('summary.json') as unknown as Summary };
  } finally {
    await portal.stop();
  }
}

test.describe('the run lock', () => {
  test('a second run is refused while the first holds the lock, and a run after a hard kill takes it over', async () => {
    test.skip(process.platform !== 'win32', 'the hard kill ends the whole process tree on Windows only');
    cleanArtifacts();
    const portal = await startPortal('ok');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-e2e-lock-'));
    const marker = path.join(scratch, 'started');
    let first: ReturnType<typeof startBlw> | undefined;
    try {
      const holdEnv = await demoEnv({}, { scenarios: { 'e2e-hold': { 'node-1': portal.url } } });
      const okEnv = await demoEnv({ 'node-1': portal.url });
      await withScenario('e2e-hold', HOLD_SOURCE, () =>
        withBaselines({ 'e2e-hold': { hold_ms: { reference_ms: 60_000, maxRatio: 1 } } }, () =>
          withDemoEnv(holdEnv, async () => {
            first = startBlw(['run'], { cwd: REPO_ROOT, env: { BLW_E2E_MARKER: marker }, timeoutMs: RUN_TIMEOUT_MS });
            await waitFor('the first run to reach its test and publish its run id', () => fs.existsSync(marker) && readLock()?.run_id != null);
            const held = fs.readFileSync(LOCK_FILE, 'utf8');
            expect(readLock()?.pid).toBe(first.pid);

            // The second run: refused, and it writes nothing.
            const second = await runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: 60_000 });
            const output = `${second.stdout}\n${second.stderr}`;
            expect(second.timedOut).toBe(false);
            expect(second.status, output).toBe(3);
            expect(outputLines(second).slice(-2), output).toEqual(['REASON=locked', 'RESULT=FAIL']);
            for (const name of ['summary.json', 'report.txt', 'runs.csv']) {
              expect(fs.existsSync(path.join(DEMO_ARTIFACTS_DIR, name)), `${name} was written by the refused run`).toBe(false);
            }
            expect(fs.readdirSync(path.join(DEMO_ARTIFACTS_DIR, 'runs'))).toHaveLength(1);
            expect(fs.readFileSync(LOCK_FILE, 'utf8')).toBe(held);

            // Kill the first run hard: it cannot release anything.
            first.kill();
            await first.result;
            expect(fs.existsSync(LOCK_FILE), 'a killed run cannot have removed its lock').toBe(true);

            // The third run takes the lock over and leaves none behind.
            const third = await withDemoEnv(okEnv, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }));
            const thirdOutput = `${third.stdout}\n${third.stderr}`;
            expect(third.timedOut).toBe(false);
            expect(third.status, thirdOutput).toBe(0);
            const summary = readArtifactJson('summary.json') as unknown as Summary;
            expect(summary.warnings.map((warning) => warning.code)).toContain('lock_taken_over');
            expect(fs.existsSync(LOCK_FILE), 'the third run left its lock behind').toBe(false);
          }),
        ),
      );
    } finally {
      first?.kill();
      await first?.result.catch(() => undefined);
      await portal.stop();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('a lock older than 3 hours is taken over even when its pid is alive', async () => {
    const { run, summary } = await runWithLock({
      pid: process.pid,
      started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      run_id: null,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(summary.warnings.map((warning) => warning.code)).toContain('lock_taken_over');
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  test('a lock whose process is gone is taken over', async () => {
    // The pid of a process that has just finished.
    const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    if (finished.pid === undefined || finished.pid <= 0) throw new Error('could not start a short process');
    const { run, summary } = await runWithLock({
      pid: finished.pid,
      started_at: new Date().toISOString(),
      run_id: null,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(summary.warnings.map((warning) => warning.code)).toContain('lock_taken_over');
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });
});
