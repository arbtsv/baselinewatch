// Tests for src/layout.ts: the run context, the run id and every file path of a run.
// Run: node --test test/layout.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { isConfigError } from '../src/errors.ts';
import { MANUAL_RUN, RUN_ID_PATTERN, readRunContext, runIdFrom, runLayout } from '../src/layout.ts';

const ROOT = path.resolve(os.tmpdir(), 'blw-layout-root');

// readRunContext must throw a configuration error whose message matches the pattern.
function assertRejected(env: NodeJS.ProcessEnv, pattern: RegExp): Error {
  try {
    readRunContext(env);
  } catch (error) {
    assert.ok(isConfigError(error), `expected a ConfigError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected a ConfigError for ${JSON.stringify(env)}`);
}

describe('runLayout', () => {
  test('a scheduled pass 2 puts every file under its run directory', () => {
    const layout = runLayout(ROOT, { runId: '20261020T123456Z', pass: 2, manual: false });
    const artifacts = path.join(ROOT, 'artifacts');
    const runDir = path.join(artifacts, 'runs', '20261020T123456Z');
    const passDir = path.join(runDir, 'pass-2');
    assert.deepEqual(layout, {
      runId: '20261020T123456Z',
      pass: 2,
      artifactsDir: artifacts,
      runDir,
      passDir,
      outputDir: path.join(passDir, 'test-results'),
      htmlDir: path.join(passDir, 'html'),
      passFile: path.join(runDir, 'pass-2.json'),
      stderrLog: path.join(runDir, 'pass-2.stderr.log'),
      cliErrorLog: path.join(runDir, 'cli-error.log'),
      metricsCsv: path.join(artifacts, 'metrics.csv'),
      runsCsv: path.join(artifacts, 'runs.csv'),
      summaryJson: path.join(artifacts, 'summary.json'),
      reportTxt: path.join(artifacts, 'report.txt'),
    });
  });

  test('the cumulative files sit at the artifacts root, outside every run directory', () => {
    const layout = runLayout(ROOT, { runId: '20261020T123456Z', pass: 1, manual: false });
    assert.equal(layout.summaryJson, path.join(ROOT, 'artifacts', 'summary.json'));
    assert.equal(layout.reportTxt, path.join(ROOT, 'artifacts', 'report.txt'));
    for (const file of [layout.metricsCsv, layout.runsCsv, layout.summaryJson, layout.reportTxt]) {
      assert.equal(path.dirname(file), layout.artifactsDir);
    }
  });

  test('the manual run keeps runs/manual/pass-1', () => {
    assert.deepEqual(MANUAL_RUN, { runId: 'manual', pass: 1, manual: true });
    const layout = runLayout(ROOT, MANUAL_RUN);
    assert.equal(layout.passDir, path.join(ROOT, 'artifacts', 'runs', 'manual', 'pass-1'));
    assert.equal(layout.outputDir, path.join(ROOT, 'artifacts', 'runs', 'manual', 'pass-1', 'test-results'));
    assert.equal(layout.htmlDir, path.join(ROOT, 'artifacts', 'runs', 'manual', 'pass-1', 'html'));
  });
});

describe('readRunContext', () => {
  test('both variables unset is the manual run', () => {
    assert.deepEqual(readRunContext({}), MANUAL_RUN);
    assert.deepEqual(readRunContext({ BLW_RUN_ID: '', BLW_PASS: '' }), MANUAL_RUN);
  });

  test('a well-formed pair is a scheduled run', () => {
    assert.deepEqual(readRunContext({ BLW_RUN_ID: '20261020T123456Z', BLW_PASS: '1' }), {
      runId: '20261020T123456Z',
      pass: 1,
      manual: false,
    });
    assert.equal(readRunContext({ BLW_RUN_ID: '20261020T123456Z', BLW_PASS: '2' }).pass, 2);
  });

  const halfSet: [string, NodeJS.ProcessEnv][] = [
    ['only the run id', { BLW_RUN_ID: '20261020T123456Z' }],
    ['only the pass', { BLW_PASS: '1' }],
    ['an empty run id with a pass', { BLW_RUN_ID: '', BLW_PASS: '1' }],
    ['a run id with an empty pass', { BLW_RUN_ID: '20261020T123456Z', BLW_PASS: '' }],
  ];
  for (const [title, env] of halfSet) {
    test(`${title} is a configuration error that names both variables`, () => {
      assertRejected(env, /BLW_RUN_ID/);
      assertRejected(env, /BLW_PASS/);
    });
  }

  const badRunIds = [
    '20261020T123456',
    '20261020t123456Z',
    '2026-10-20T12:34:56Z',
    '..\\x',
    '../x',
    '20261020T123456Z/..',
    'manual',
  ];
  for (const runId of badRunIds) {
    test(`run id ${JSON.stringify(runId)} is refused and named as BLW_RUN_ID`, () => {
      assertRejected({ BLW_RUN_ID: runId, BLW_PASS: '1' }, /^\[config\] BLW_RUN_ID: .*UTC run id/);
    });
  }

  for (const pass of ['0', '3', '1.0', ' 1', 'one']) {
    test(`pass ${JSON.stringify(pass)} is refused and named as BLW_PASS`, () => {
      assertRejected({ BLW_RUN_ID: '20261020T123456Z', BLW_PASS: pass }, /^\[config\] BLW_PASS: must be 1 or 2/);
    });
  }

  test('a message names the variable and never echoes the rejected value', () => {
    const runIdError = assertRejected({ BLW_RUN_ID: 'zz-run-marker', BLW_PASS: '1' }, /BLW_RUN_ID/);
    assert.equal(runIdError.message.includes('zz-run-marker'), false);
    const passError = assertRejected({ BLW_RUN_ID: '20261020T123456Z', BLW_PASS: 'zz-pass-marker' }, /BLW_PASS/);
    assert.equal(passError.message.includes('zz-pass-marker'), false);
  });
});

describe('runIdFrom', () => {
  test('it is UTC, compact and whole seconds', () => {
    assert.equal(runIdFrom(new Date('2026-10-20T12:34:56.789Z')), '20261020T123456Z');
    assert.equal(runIdFrom(new Date('2026-01-02T03:04:05.000Z')), '20260102T030405Z');
  });

  test('the pattern accepts what runIdFrom returns', () => {
    assert.match(runIdFrom(new Date('2026-10-20T12:34:56.789Z')), RUN_ID_PATTERN);
    assert.match(runIdFrom(new Date('2026-01-02T03:04:05.000Z')), RUN_ID_PATTERN);
  });
});
