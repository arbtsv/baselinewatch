// The exit codes of monitor.bat on the demo portal: every outcome of a run reaches a scheduler as 0, 1 or 3
// with RESULT= as the last line, also on a machine without Node. Windows only.
//
// Run: npm run e2e -- test/e2e/launcher.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_ARTIFACTS_DIR,
  DEMO_DIR,
  REPO_ROOT,
  cleanArtifacts,
  demoEnv,
  expectNoDemoSecrets,
  hermeticEnv,
  readArtifactJson,
  withDemoEnv,
} from '../helpers/demo.ts';
import { envWithPath, runLauncher, systemDirectory, type LauncherRun } from '../helpers/launcher.ts';
import { startPortal, type PortalMode } from '../helpers/portal.ts';

const LAUNCHER = path.join(DEMO_DIR, 'monitor.bat');

// A run of the slow rows takes two passes, each with a browser start.
const RUN_TIMEOUT_MS = 170_000;

// A node address nothing listens on, for rows that never reach a browser.
const UNUSED_URL = 'http://127.0.0.1:9/';

type SummaryFile = {
  run_id: string;
  status: string;
  exit_code: number;
  nodes: { node: string; recheck: string | null }[];
  warnings: { code: string }[];
};

// One run of the demo launcher from outside the demo project; env.json holds one node, served by a portal in
// the given mode or only named. A null env.json is removed for the time of the run.
async function launch(
  opts: { mode?: PortalMode; args?: string[]; envFile?: 'present' | 'missing'; env?: NodeJS.ProcessEnv } = {},
): Promise<LauncherRun> {
  cleanArtifacts();
  const portal = opts.mode === undefined ? undefined : await startPortal(opts.mode);
  try {
    const env = await demoEnv({ 'node-1': portal?.url ?? UNUSED_URL });
    return await withDemoEnv(opts.envFile === 'missing' ? null : env, () =>
      runLauncher(LAUNCHER, opts.args ?? [], { env: opts.env ?? hermeticEnv(), cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }),
    );
  } finally {
    await portal?.stop();
  }
}

// What every row that ran the core has in common: not timed out, the exit code of the launcher is the exit
// code the core recorded, the demo launcher is current, and no demo value is left anywhere.
async function expectRan(run: LauncherRun, exit: number): Promise<SummaryFile> {
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.timedOut).toBe(false);
  expect(run.status, output).toBe(exit);
  const summary = readArtifactJson('summary.json') as unknown as SummaryFile;
  expect(summary.exit_code).toBe(exit);
  expect(summary.warnings.map((warning) => warning.code)).not.toContain('launcher_outdated');
  await expectNoDemoSecrets(run, summary.run_id);
  return summary;
}

type PortalRow = {
  name: string;
  mode: PortalMode;
  exit: 0 | 1;
  /** The REASON= line before RESULT=, or null when there is none. */
  reason: string | null;
  recheck?: string;
};

const PORTAL_ROWS: PortalRow[] = [
  { name: 'ok', mode: 'ok', exit: 0, reason: null },
  { name: 'slowOnce is rechecked ok and still fails', mode: 'slowOnce', exit: 1, reason: 'slow', recheck: 'ok' },
  { name: 'slowAlways stays slow', mode: 'slowAlways', exit: 1, reason: 'slow' },
  { name: 'loginError is an error', mode: 'loginError', exit: 1, reason: 'error' },
  { name: 'broken is an error', mode: 'broken', exit: 1, reason: 'error' },
];

test.describe('monitor.bat on the demo portal', () => {
  test.skip(process.platform !== 'win32', 'monitor.bat runs on Windows only');

  test.beforeAll(() => {
    // A portable Node next to the launcher would win over the Path and defeat the row without Node.
    expect(fs.existsSync(path.join(DEMO_DIR, 'node')), `${path.join(DEMO_DIR, 'node')} must not exist`).toBe(false);
  });

  for (const row of PORTAL_ROWS) {
    test(`${row.name}: exit ${row.exit}, RESULT= last`, async () => {
      const run = await launch({ mode: row.mode });
      const summary = await expectRan(run, row.exit);
      const result = row.exit === 0 ? 'RESULT=PASS' : 'RESULT=FAIL';
      expect(run.lines.at(-1), run.stdout).toBe(result);
      if (row.reason === null) {
        expect(run.lines.filter((line) => line.startsWith('REASON='))).toEqual([]);
        expect(summary.status).toBe('pass');
      } else {
        expect(run.lines.at(-2), run.stdout).toBe(`REASON=${row.reason}`);
      }
      if (row.recheck !== undefined) {
        expect(summary.nodes.map((node) => [node.node, node.recheck])).toEqual([['node-1', row.recheck]]);
      }
    });
  }

  test('a missing env.json exits 3 with REASON=config', async () => {
    const run = await launch({ envFile: 'missing' });
    await expectRan(run, 3);
    expect(run.lines.at(-2), run.stdout).toBe('REASON=config');
    expect(run.lines.at(-1), run.stdout).toBe('RESULT=FAIL');
  });

  test('a machine without Node exits 3 with REASON=node and runs nothing', async () => {
    const run = await launch({ env: envWithPath(systemDirectory(), hermeticEnv()) });
    expect(run.timedOut).toBe(false);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(3);
    expect(run.lines).toHaveLength(3);
    expect(run.lines[1]).toBe('REASON=node');
    expect(run.lines.at(-1)).toBe('RESULT=FAIL');
    // The launcher stopped before the core: no artifacts directory was made.
    expect(fs.existsSync(DEMO_ARTIFACTS_DIR)).toBe(false);
    await expectNoDemoSecrets(run, undefined);
  });

  test('an unknown option exits 3 with REASON=usage and reaches Node unchanged', async () => {
    const run = await launch({ args: ['--bogus'] });
    await expectRan(run, 3);
    expect(run.lines.at(-2), run.stdout).toBe('REASON=usage');
    expect(run.lines.at(-1), run.stdout).toBe('RESULT=FAIL');
    expect(run.lines.some((line) => line.includes('--bogus')), run.stdout).toBe(true);
  });
});
