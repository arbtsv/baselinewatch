// Tests for src/reporters/data.ts: the pass file and the CSV history that the data reporter writes.
// Playwright is not started; the reporter is driven with plain objects shaped like its arguments.
// Run: node --test test/data-reporter.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { Baselines } from '../src/baselines.ts';
import { historyErrorLogFor } from '../src/layout.ts';
import { METRIC_ANNOTATION, type PassFile } from '../src/protocol.ts';
import DataReporter, { type DataReporterOptions } from '../src/reporters/data.ts';

const HEADER = 'run_id,pass,ts,scenario,node,metric,ms,reference_ms,max_ratio,ratio,verdict,schema_version';
const RUN_ID = '20261020T123456Z';
const PLACEHOLDER_PASSWORD = 'placeholder-password-for-test';

const BASELINES: Baselines = {
  demo: {
    login_ms: { reference_ms: 1000, maxRatio: 3 },
    overview_ms: { reference_ms: 450, maxRatio: 3 },
    history_ms: { reference_ms: 1000, maxRatio: 3 },
  },
};

type FakeProject = { name: string; metadata: { scenario: string; node: string } };

function project(node: string): FakeProject {
  return { name: `demo--${node}`, metadata: { scenario: 'demo', node } };
}

function configOf(...nodes: string[]): FullConfig {
  return { projects: nodes.map(project) } as unknown as FullConfig;
}

function testCase(id: string, projectName: string): TestCase {
  return { id, parent: { project: () => ({ name: projectName }) } } as unknown as TestCase;
}

function suiteOf(...tests: TestCase[]): Suite {
  return { allTests: () => tests } as unknown as Suite;
}

function metricAnnotation(name: string, ms: number, referenceMs: number) {
  const ratio = ms / referenceMs;
  return {
    type: METRIC_ANNOTATION,
    description: JSON.stringify({
      name,
      ms,
      reference_ms: referenceMs,
      maxRatio: 3,
      ratio,
      verdict: ratio > 3 ? 'slow' : 'ok',
    }),
  };
}

function resultOf(
  status: TestResult['status'],
  annotations: ReturnType<typeof metricAnnotation>[],
  startTime: string,
  errors: { message?: string }[] = [],
): TestResult {
  return { status, errors, annotations, startTime: new Date(startTime) } as unknown as TestResult;
}

function finished(status: FullResult['status'] = 'passed'): FullResult {
  return { status, startTime: new Date('2026-10-20T12:34:56.000Z'), duration: 1000 };
}

function okResult(startTime: string): TestResult {
  return resultOf(
    'passed',
    [metricAnnotation('login_ms', 800, 1000), metricAnnotation('overview_ms', 500, 450), metricAnnotation('history_ms', 900, 1000)],
    startTime,
  );
}

function options(dir: string, overrides: Partial<DataReporterOptions> = {}): DataReporterOptions {
  return {
    runId: RUN_ID,
    pass: 1,
    manual: false,
    passFile: path.join(dir, 'runs', RUN_ID, 'pass-1.json'),
    metricsCsv: path.join(dir, 'metrics.csv'),
    baselines: BASELINES,
    ...overrides,
  };
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blw-data-reporter-'));
}

function readPass(file: string): PassFile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PassFile;
}

function csvLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
}

// Runs a whole pass: every test begins, then ends with its result, then the pass ends.
function runPass(
  opts: DataReporterOptions,
  config: FullConfig,
  ended: [TestCase, TestResult][],
  extraSeeded: TestCase[] = [],
  status: FullResult['status'] = 'passed',
): void {
  const reporter = new DataReporter(opts);
  reporter.onBegin(config, suiteOf(...ended.map(([test]) => test), ...extraSeeded));
  for (const [test, result] of ended) reporter.onTestEnd(test, result);
  reporter.onEnd(finished(status));
}

const NODE_1 = testCase('t1', 'demo--node-1');
const NODE_2 = testCase('t2', 'demo--node-2');
const NODE_1_RESULT = (): TestResult => okResult('2026-10-20T12:34:57.000Z');
const NODE_2_RESULT = (): TestResult =>
  resultOf(
    'failed',
    [metricAnnotation('login_ms', 1200.04, 1000)],
    '2026-10-20T12:34:59.000Z',
    [{ message: `Error: expected the heading, got ${PLACEHOLDER_PASSWORD}` }],
  );

describe('DataReporter: scheduled pass 1', () => {
  const dir = freshDir();
  const opts = options(dir);
  runPass(opts, configOf('node-1', 'node-2'), [
    [NODE_1, NODE_1_RESULT()],
    [NODE_2, NODE_2_RESULT()],
  ]);

  test('it does not print', () => {
    assert.equal(new DataReporter(opts).printsToStdio(), false);
  });

  test('the pass file lists both projects with their class and category', () => {
    const file = readPass(opts.passFile);
    assert.equal(file.run_id, RUN_ID);
    assert.equal(file.pass, 1);
    assert.deepEqual(
      file.projects.map((entry) => [entry.project, entry.class, entry.error_category]),
      [
        ['demo--node-1', 'ok', null],
        ['demo--node-2', 'error', 'other'],
      ],
    );
  });

  test('the first pass lists the baseline metrics that an error project did not measure', () => {
    const file = readPass(opts.passFile);
    assert.deepEqual(file.not_measured, [
      { scenario: 'demo', node: 'node-2', metric: 'overview_ms' },
      { scenario: 'demo', node: 'node-2', metric: 'history_ms' },
    ]);
    assert.deepEqual(file.unused_baselines, []);
  });

  test('metrics.csv has the header once and a row for every measured metric, error projects included', () => {
    const lines = csvLines(opts.metricsCsv);
    assert.equal(lines[0], HEADER);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.slice(1), [
      `${RUN_ID},1,2026-10-20T12:34:57.000Z,demo,node-1,login_ms,800.0,1000,3,0.800,ok,1`,
      `${RUN_ID},1,2026-10-20T12:34:57.000Z,demo,node-1,overview_ms,500.0,450,3,1.111,ok,1`,
      `${RUN_ID},1,2026-10-20T12:34:57.000Z,demo,node-1,history_ms,900.0,1000,3,0.900,ok,1`,
      `${RUN_ID},1,2026-10-20T12:34:59.000Z,demo,node-2,login_ms,1200.0,1000,3,1.200,ok,1`,
    ]);
  });

  test('no error text reaches the pass file or the CSV history', () => {
    assert.equal(fs.readFileSync(opts.passFile, 'utf8').includes(PLACEHOLDER_PASSWORD), false);
    assert.equal(fs.readFileSync(opts.metricsCsv, 'utf8').includes(PLACEHOLDER_PASSWORD), false);
  });

  test('no temporary file stays next to the pass file', () => {
    const names = fs.readdirSync(path.dirname(opts.passFile));
    assert.deepEqual(names, ['pass-1.json']);
  });
});

describe('DataReporter: scheduled pass 2', () => {
  const dir = freshDir();
  const first = options(dir);
  const second = options(dir, { pass: 2, passFile: path.join(dir, 'runs', RUN_ID, 'pass-2.json') });
  runPass(first, configOf('node-1', 'node-2'), [
    [NODE_1, NODE_1_RESULT()],
    [NODE_2, NODE_2_RESULT()],
  ]);
  // The second pass is filtered to one project, but the configuration still lists both.
  runPass(second, configOf('node-1', 'node-2'), [[NODE_1, okResult('2026-10-20T12:35:30.000Z')]]);

  test('the pass file holds only the project that ran, with empty gap lists', () => {
    const file = readPass(second.passFile);
    assert.equal(file.pass, 2);
    assert.deepEqual(
      file.projects.map((entry) => entry.project),
      ['demo--node-1'],
    );
    assert.deepEqual(file.not_measured, []);
    assert.deepEqual(file.unused_baselines, []);
  });

  test('three rows with pass 2 follow the earlier rows, under one header', () => {
    const lines = csvLines(first.metricsCsv);
    assert.equal(lines.filter((line) => line === HEADER).length, 1);
    assert.equal(lines.length, 1 + 4 + 3);
    const added = lines.slice(5);
    assert.deepEqual(
      added.map((line) => line.split(',').slice(0, 2)),
      [
        [RUN_ID, '2'],
        [RUN_ID, '2'],
        [RUN_ID, '2'],
      ],
    );
    assert.deepEqual(
      added.map((line) => line.split(',')[5]),
      ['login_ms', 'overview_ms', 'history_ms'],
    );
  });
});

describe('DataReporter: manual run', () => {
  test('it writes the pass file and leaves no metrics.csv', () => {
    const dir = freshDir();
    const opts = options(dir, { runId: 'manual', manual: true, passFile: path.join(dir, 'runs', 'manual', 'pass-1.json') });
    runPass(opts, configOf('node-1'), [[NODE_1, NODE_1_RESULT()]]);
    assert.equal(readPass(opts.passFile).run_id, 'manual');
    assert.equal(fs.existsSync(opts.metricsCsv), false);
  });

  test('it leaves an existing metrics.csv untouched', () => {
    const dir = freshDir();
    const opts = options(dir, { runId: 'manual', manual: true, passFile: path.join(dir, 'runs', 'manual', 'pass-1.json') });
    fs.writeFileSync(opts.metricsCsv, `${HEADER}\n`);
    runPass(opts, configOf('node-1'), [[NODE_1, NODE_1_RESULT()]]);
    assert.equal(fs.readFileSync(opts.metricsCsv, 'utf8'), `${HEADER}\n`);
  });
});

describe('DataReporter: a run that ends before every test does', () => {
  test('a seeded test without an end makes its project an error with the category timeout', () => {
    const dir = freshDir();
    const opts = options(dir);
    runPass(opts, configOf('node-1', 'node-2'), [[NODE_1, NODE_1_RESULT()]], [NODE_2], 'timedout');
    const file = readPass(opts.passFile);
    const node2 = file.projects.find((entry) => entry.project === 'demo--node-2');
    assert.equal(node2?.class, 'error');
    assert.equal(node2?.error_category, 'timeout');
    assert.equal(file.projects.find((entry) => entry.project === 'demo--node-1')?.class, 'ok');
  });

  test('without a timed out run the same project is an error with the category other', () => {
    const dir = freshDir();
    const opts = options(dir);
    runPass(opts, configOf('node-1', 'node-2'), [[NODE_1, NODE_1_RESULT()]], [NODE_2], 'interrupted');
    const node2 = readPass(opts.passFile).projects.find((entry) => entry.project === 'demo--node-2');
    assert.equal(node2?.class, 'error');
    assert.equal(node2?.error_category, 'other');
  });

  test('a first-pass project without any test is an error and writes no metric row', () => {
    const dir = freshDir();
    const opts = options(dir);
    runPass(opts, configOf('node-1', 'node-2'), [[NODE_1, NODE_1_RESULT()]]);
    const node2 = readPass(opts.passFile).projects.find((entry) => entry.project === 'demo--node-2');
    assert.equal(node2?.class, 'error');
    assert.equal(
      csvLines(opts.metricsCsv).filter((line) => line.includes(',node-2,')).length,
      0,
    );
  });
});

describe('DataReporter: a metrics.csv that cannot be written', () => {
  test('the history error file sits next to the pass file and is named after its pass', () => {
    assert.equal(
      historyErrorLogFor(path.join('r', 'runs', 'X', 'pass-2.json')),
      path.join('r', 'runs', 'X', 'pass-2.history-error.log'),
    );
  });

  test('a scheduled pass ends without an error, keeps the pass file and names the failure in a history error file', () => {
    // metrics.csv as a directory: every append to it fails.
    const opts = options(freshDir());
    fs.mkdirSync(opts.metricsCsv, { recursive: true });
    runPass(opts, configOf('node-1', 'node-2'), [
      [NODE_1, NODE_1_RESULT()],
      [NODE_2, NODE_2_RESULT()],
    ]);
    const file = readPass(opts.passFile);
    assert.deepEqual(
      file.projects.map((entry) => [entry.project, entry.class]),
      [
        ['demo--node-1', 'ok'],
        ['demo--node-2', 'error'],
      ],
    );
    const logFile = path.join(path.dirname(opts.passFile), 'pass-1.history-error.log');
    assert.equal(historyErrorLogFor(opts.passFile), logFile);
    const text = fs.readFileSync(logFile, 'utf8');
    assert.match(text, /^metrics\.csv: (E[A-Z]+|unknown)\n$/);
    assert.equal(text.includes(PLACEHOLDER_PASSWORD), false);
  });

  test('a manual run never appends, so it writes no history error file', () => {
    const dir = freshDir();
    const opts = options(dir, { runId: 'manual', manual: true, passFile: path.join(dir, 'runs', 'manual', 'pass-1.json') });
    fs.mkdirSync(opts.metricsCsv, { recursive: true });
    runPass(opts, configOf('node-1'), [[NODE_1, NODE_1_RESULT()]]);
    assert.equal(readPass(opts.passFile).run_id, 'manual');
    assert.equal(fs.existsSync(historyErrorLogFor(opts.passFile)), false);
  });

  test('a writable metrics.csv leaves no history error file', () => {
    const dir = freshDir();
    const opts = options(dir);
    runPass(opts, configOf('node-1'), [[NODE_1, NODE_1_RESULT()]]);
    assert.equal(fs.existsSync(historyErrorLogFor(opts.passFile)), false);
    assert.deepEqual(fs.readdirSync(path.dirname(opts.passFile)), ['pass-1.json']);
  });
});
