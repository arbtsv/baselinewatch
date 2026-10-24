// The safeguards of a run through real `blw run` processes on the demo portal: the redacted test
// results and the zip of the run, a binary file that holds the login, and the removal of old runs.
// The zip is built with the system tar.exe, so the zip checks run on Windows only; every other check
// runs on every OS and an other OS must say that the zip was skipped.
//
// Run: npm run e2e -- test/e2e/safeguards.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_ARTIFACTS_DIR,
  REPO_ROOT,
  cleanArtifacts,
  demoEnv,
  expectNoDemoSecrets,
  outputLines,
  readArtifactJson,
  runBlw,
  withBaselines,
  withDemoEnv,
  withScenario,
  type RunResult,
} from '../helpers/demo.ts';
import { decodePng } from '../helpers/png.ts';
import { reportZipName, runIdFrom, tempZipName } from '../../src/layout.ts';
import { loadPortalModule, startPortal, type PortalMode } from '../helpers/portal.ts';
import { unzipEntries } from '../helpers/zip.ts';

// A run takes a browser start per pass; the rows of this file run one pass.
const RUN_TIMEOUT_MS = 170_000;

const RUN_ID = /^\d{8}T\d{6}Z$/;

type Summary = {
  run_id: string;
  warnings: { code: string; count?: number }[];
};

/** Every file under a directory, as a slash-separated path relative to it; none for a missing one. */
function filesUnder(root: string, dir: string = root): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(root, file));
    else found.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return found.sort();
}

/**
 * One `blw run` against a demo portal in the given mode, with the demo scenario bound to it. The
 * artifacts are cleaned first unless opts.keep says the run follows an earlier one.
 */
async function runAgainst(
  mode: PortalMode,
  opts: { keep?: boolean; retentionDays?: number } = {},
): Promise<{ run: RunResult; summary: Summary; runId: string; runDir: string }> {
  if (opts.keep !== true) cleanArtifacts();
  const portal = await startPortal(mode);
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    if (opts.retentionDays !== undefined) env.retention_days = opts.retentionDays;
    const run = await withDemoEnv(env, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }));
    expect(run.timedOut).toBe(false);
    const summary = readArtifactJson('summary.json') as unknown as Summary;
    expect(summary.run_id).toMatch(RUN_ID);
    return { run, summary, runId: summary.run_id, runDir: path.join(DEMO_ARTIFACTS_DIR, 'runs', summary.run_id) };
  } finally {
    await portal.stop();
  }
}

test.describe('zip and redaction', () => {
  test('a login that is a word of the machine lines leaves RESULT= and REASON= intact', async () => {
    // The portal refuses the login, so the run ends with REASON=error after env.json was loaded and the
    // console redactor was attached; a login "error" must not rewrite the line the scheduler reads.
    cleanArtifacts();
    const portal = await startPortal('loginError');
    try {
      const env = await demoEnv({ 'node-1': portal.url });
      env.account.login = 'error';
      const run = await withDemoEnv(env, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }));
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.timedOut).toBe(false);
      expect(run.status, output).toBe(1);
      expect(outputLines(run).slice(-2), output).toEqual(['REASON=error', 'RESULT=FAIL']);
    } finally {
      await portal.stop();
    }
  });

  test('a broken page run redacts the page snapshot and packs a zip without the html report', async () => {
    const { DEMO_ACCOUNT } = await loadPortalModule();
    const { run, summary, runId, runDir } = await runAgainst('broken');
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(1);
    expect(outputLines(run).slice(-2), output).toEqual(['REASON=error', 'RESULT=FAIL']);

    // The failed test leaves a snapshot of the page; the command line replaced the values in it.
    const results = path.join(runDir, 'pass-1', 'test-results');
    const snapshots = filesUnder(results).filter((name) => name.endsWith('/error-context.md'));
    expect(snapshots, `no page snapshot under ${results}`).toHaveLength(1);
    const snapshot = fs.readFileSync(path.join(results, snapshots[0] as string), 'utf8');
    expect(snapshot).toContain('***');
    expect(snapshot).not.toContain(DEMO_ACCOUNT.login);
    expect(snapshot).not.toContain(DEMO_ACCOUNT.password);

    const archive = path.join(DEMO_ARTIFACTS_DIR, `report_${runId}.zip`);
    if (process.platform === 'win32') {
      expect(fs.existsSync(archive), `no ${archive}`).toBe(true);
      const entries = unzipEntries(fs.readFileSync(archive));
      const names = entries.map(([name]) => name);
      expect(names).toContain('report.txt');
      expect(names).toContain('summary.json');
      expect(names).toContain('pass-1.json');
      expect(names.some((name) => name.startsWith('pass-1/test-results/') && name.endsWith('/error-context.md'))).toBe(true);
      expect(names.some((name) => name.startsWith('pass-1/test-results/') && name.endsWith('.png'))).toBe(true);
      expect(names.filter((name) => name.startsWith('pass-1/html/'))).toEqual([]);
      expect(names.filter((name) => name.endsWith('.stderr.log') || name === 'cli-error.log')).toEqual([]);
      const packed = entries.find(([name]) => name === 'summary.json');
      const inside = JSON.parse((packed?.[1] ?? Buffer.alloc(0)).toString('utf8')) as Summary;
      expect(inside.run_id).toBe(runId);
      expect(inside.warnings.map((warning) => warning.code)).not.toContain('zip_failed');
      expect(summary.warnings.map((warning) => warning.code)).not.toContain('zip_failed');
    } else {
      expect(fs.existsSync(archive)).toBe(false);
      expect(summary.warnings.map((warning) => warning.code)).toContain('zip_skipped');
    }
    await expectNoDemoSecrets(run, runId);
  });

  test('an ok run packs the masked screenshot and copies the report into the run directory', async () => {
    const { run, runId, runDir } = await runAgainst('ok');
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(0);

    for (const name of ['report.txt', 'summary.json']) {
      const copy = path.join(runDir, name);
      expect(fs.existsSync(copy), `no ${copy}`).toBe(true);
      expect(fs.readFileSync(copy).equals(fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, name))), `${name} differs from its copy`).toBe(true);
    }

    if (process.platform === 'win32') {
      const archive = path.join(DEMO_ARTIFACTS_DIR, `report_${runId}.zip`);
      expect(fs.existsSync(archive), `no ${archive}`).toBe(true);
      const shots = unzipEntries(fs.readFileSync(archive)).filter(
        ([name]) => name.startsWith('pass-1/test-results/') && name.endsWith('.png'),
      );
      expect(shots).toHaveLength(1);
      const image = decodePng((shots[0] as [string, Buffer])[1]);
      expect([image.width, image.height]).toEqual([1280, 720]);
    }
    await expectNoDemoSecrets(run, runId);
  });

  test('a binary file that holds the login stays on disk and out of the zip', async () => {
    const { DEMO_ACCOUNT } = await loadPortalModule();
    cleanArtifacts();
    const portal = await startPortal('ok');
    try {
      const env = await demoEnv({}, { scenarios: { 'e2e-blob': { 'node-1': portal.url } } });
      const run = await withScenario('e2e-blob', BLOB_SOURCE, () =>
        withBaselines({ 'e2e-blob': { blob_ms: { reference_ms: 60_000, maxRatio: 1 } } }, () =>
          withDemoEnv(env, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS })),
        ),
      );
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.timedOut).toBe(false);
      expect(run.status, output).toBe(0);
      const summary = readArtifactJson('summary.json') as unknown as Summary;
      const runId = summary.run_id;
      expect(runId).toMatch(RUN_ID);
      expect(summary.warnings).toContainEqual({ code: 'binary_left_out', count: 1 });
      expect(fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, 'report.txt'), 'utf8')).toContain('left out of the zip');

      const results = path.join(DEMO_ARTIFACTS_DIR, 'runs', runId, 'pass-1', 'test-results');
      const blobs = filesUnder(results).filter((name) => name.endsWith('blob.bin'));
      expect(blobs).toHaveLength(1);
      // The file is left alone on disk, so the secret is still in it.
      const bytes = fs.readFileSync(path.join(results, blobs[0] as string));
      expect(bytes.includes(Buffer.from(DEMO_ACCOUNT.login))).toBe(true);

      if (process.platform === 'win32') {
        const archive = path.join(DEMO_ARTIFACTS_DIR, reportZipName(runId));
        expect(fs.existsSync(archive), `no ${archive}`).toBe(true);
        const entries = unzipEntries(fs.readFileSync(archive));
        expect(entries.filter(([name]) => name.endsWith('blob.bin'))).toEqual([]);
        for (const [name, content] of entries) {
          expect(content.includes(Buffer.from(DEMO_ACCOUNT.login)), `the login is in the zip entry ${name}`).toBe(false);
        }
      }
      await expectNoDemoSecrets(run, runId);
    } finally {
      await portal.stop();
    }
  });
});

// A scenario that leaves a binary file with the account login in the test output.
const BLOB_SOURCE = `import fs from 'node:fs';
import { test } from 'baselinewatch';

test('a file with binary content that holds the login', async ({ page, account, measure }, testInfo) => {
  await measure('blob_ms', async () => {
    await page.goto('/');
  });
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  fs.writeFileSync(testInfo.outputPath('blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(account.login)]));
});
`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a run of an earlier time would have left in the artifacts directory, written by hand. */
function seedOldAndRecent(): { old: string[]; kept: string[] } {
  const now = Date.now();
  const oldId = runIdFrom(new Date(now - 3 * DAY_MS));
  const recentId = runIdFrom(new Date(now - 60 * 60 * 1000));
  const write = (...parts: string[]): string => {
    const target = path.join(DEMO_ARTIFACTS_DIR, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x\n');
    return target;
  };
  const old = [
    path.dirname(write('runs', oldId, 'x.txt')),
    write(reportZipName(oldId)),
    write(tempZipName(oldId, 4242)),
  ];
  const kept = [
    path.dirname(write('runs', recentId, 'x.txt')),
    write(reportZipName(recentId)),
    write('runs', 'manual', 'keep.txt'),
    write('runs', 'notes.txt'),
  ];
  return { old, kept };
}

test.describe('retention', () => {
  test('blw run removes old run directories and zips and keeps the history', async () => {
    const first = await runAgainst('ok');
    expect(first.run.status, `${first.run.stdout}\n${first.run.stderr}`).toBe(0);
    const history = new Map(
      ['metrics.csv', 'runs.csv'].map((name) => [name, fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, name))]),
    );
    const { old, kept } = seedOldAndRecent();
    for (const target of [...old, ...kept]) expect(fs.existsSync(target), `${target} was not seeded`).toBe(true);

    const second = await runAgainst('ok', { keep: true, retentionDays: 1 });
    expect(second.run.status, `${second.run.stdout}\n${second.run.stderr}`).toBe(0);
    expect(second.runId).not.toBe(first.runId);

    for (const target of old) expect(fs.existsSync(target), `${target} was kept`).toBe(false);
    for (const target of [...kept, first.runDir]) expect(fs.existsSync(target), `${target} was removed`).toBe(true);
    expect(second.summary.warnings.map((warning) => warning.code)).not.toContain('retention_failed');
    for (const [name, before] of history) {
      const after = fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, name));
      expect(after.length, `${name} did not grow`).toBeGreaterThan(before.length);
      expect(after.subarray(0, before.length).equals(before), `${name} changed`).toBe(true);
    }
    await expectNoDemoSecrets(second.run, second.runId);
  });

  test('retention_days 0 keeps everything', async () => {
    cleanArtifacts();
    const { old, kept } = seedOldAndRecent();
    const result = await runAgainst('ok', { keep: true, retentionDays: 0 });
    expect(result.run.status, `${result.run.stdout}\n${result.run.stderr}`).toBe(0);
    for (const target of [...old, ...kept]) expect(fs.existsSync(target), `${target} was removed`).toBe(true);
    await expectNoDemoSecrets(result.run, result.runId);
  });
});
