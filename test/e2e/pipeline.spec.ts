// The run pipeline end to end: the guards of the fixture on a bare Playwright run, a manual run, and
// `blw run` through every outcome row of the demo project.
//
// Run: npm run e2e -- test/e2e/pipeline.spec.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_ARTIFACTS_DIR,
  DEMO_BASELINES_FILE,
  DEMO_DIR,
  DEMO_ENV_FILE,
  REPO_ROOT,
  cleanArtifacts,
  csvLinesFor,
  demoEnv,
  expectNoDemoSecrets,
  outputLines,
  parseJsonReport,
  readArtifactJson,
  runBlw,
  runDemoPlaywright,
  withBaselines,
  withDemoEnv,
  withPlaywrightStub,
  withRawFile,
  withScenario,
  type BaselineMap,
  type JsonTest,
  type RunResult,
} from '../helpers/demo.ts';
import { loadPortalModule, startPortal, type PortalMode, type RunningPortal } from '../helpers/portal.ts';

// Playwright puts the error name in front of the message; the slow marker follows it.
const SLOW_MESSAGE = /^(?:Error: )?\[slow\] /;

// A step that is slower than its one millisecond limit, then a failure of the test itself.
const SLOW_THEN_FAIL_SOURCE = `import { test } from 'baselinewatch';

test('a slow step, then a failure', async ({ page, measure }) => {
  await page.goto('/');
  await measure('wait_ms', async () => {
    await page.waitForTimeout(50);
  });
  throw new Error('boom after a slow step');
});
`;

function verdicts(item: JsonTest): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (const annotation of item.annotations) {
    if (annotation.type !== 'blw.metric') continue;
    const entry = JSON.parse(annotation.description ?? '{}') as { name: string; verdict: unknown };
    found[entry.name] = entry.verdict;
  }
  return found;
}

test.describe('fixture guards on a bare Playwright run', () => {
  test('a slow step followed by a failure ends with one error without the slow prefix', async () => {
    const portal = await startPortal('ok');
    try {
      const env = await demoEnv({}, { scenarios: { 'e2e-slowfail': { 'node-1': portal.url } } });
      const run = await withScenario('e2e-slowfail', SLOW_THEN_FAIL_SOURCE, () =>
        withBaselines({ 'e2e-slowfail': { wait_ms: { reference_ms: 1, maxRatio: 1 } } }, () =>
          withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json'])),
        ),
      );
      expect(run.timedOut).toBe(false);
      const report = parseJsonReport(run);
      expect(report.tests).toHaveLength(1);
      const [item] = report.tests as [JsonTest];
      expect(item.status).toBe('failed');
      expect(item.errors).toHaveLength(1);
      const [message] = item.errors as [string];
      expect(message).toContain('boom after a slow step');
      expect(message).not.toMatch(SLOW_MESSAGE);
      expect(verdicts(item)).toEqual({ wait_ms: 'slow' });
    } finally {
      await portal.stop();
    }
  });

  test('with --retries=1 the retry of a failed sign-in stops before the test body', async () => {
    const portal = await startPortal('loginError');
    try {
      const env = await demoEnv({ 'node-1': portal.url });
      const run = await withDemoEnv(env, () =>
        runDemoPlaywright(['test', '--retries=1', '--reporter=json'], { timeoutMs: 120_000 }),
      );
      expect(run.timedOut).toBe(false);
      expect(run.status).not.toBe(0);
      const report = parseJsonReport(run);
      expect(report.tests).toHaveLength(1);
      const [item] = report.tests as [JsonTest];
      expect(item.resultsCount).toBe(2);
      expect(item.retry).toBe(1);
      expect(item.errors).toHaveLength(1);
      const [message] = item.errors as [string];
      expect(message).toContain('retries are off');
      expect(message).not.toMatch(SLOW_MESSAGE);
      expect(item.annotations.filter((annotation) => annotation.type === 'blw.metric')).toEqual([]);
    } finally {
      await portal.stop();
    }
  });
});

test.describe('manual Playwright runs', () => {
  test('a manual run writes runs/manual/pass-1.json and leaves the CSV history alone', async () => {
    const { DEMO_ACCOUNT } = await loadPortalModule();
    const artifacts = path.join(DEMO_DIR, 'artifacts');
    const passFile = path.join(artifacts, 'runs', 'manual', 'pass-1.json');
    const metricsCsv = path.join(artifacts, 'metrics.csv');
    fs.rmSync(path.join(artifacts, 'runs', 'manual'), { recursive: true, force: true });
    fs.rmSync(metricsCsv, { force: true });
    const portal = await startPortal('ok');
    try {
      const env = await demoEnv({ 'node-1': portal.url });
      // No reporter flag: the reporters come from the configuration itself.
      const run = await withDemoEnv(env, () => runDemoPlaywright(['test']));
      expect(run.timedOut).toBe(false);
      expect(run.status, `${run.stdout}
${run.stderr}`).toBe(0);

      const text = fs.readFileSync(passFile, 'utf8');
      const file = JSON.parse(text) as {
        run_id: string;
        pass: number;
        projects: { project: string; class: string; error_category: string | null; metrics: { name: string }[] }[];
      };
      expect(file.run_id).toBe('manual');
      expect(file.pass).toBe(1);
      expect(file.projects).toHaveLength(1);
      const [project] = file.projects as [(typeof file.projects)[number]];
      expect(project.project).toBe('demo--node-1');
      expect(project.class).toBe('ok');
      expect(project.error_category).toBeNull();
      expect(project.metrics.map((metric) => metric.name)).toEqual(['login_ms', 'overview_ms', 'history_ms']);

      expect(fs.existsSync(metricsCsv)).toBe(false);

      // The console reporter prints one line per project and reports itself as printing, so
      // Playwright adds no line or list reporter of its own.
      const lines = run.stdout.split('\n').map((line) => line.replace(/\r$/, ''));
      expect(lines).toContain('[pass 1] demo--node-1: ok');
      expect(lines.filter((line) => /^Running \d+ tests? using \d+ workers?/.test(line))).toEqual([]);

      for (const output of [text, run.stdout, run.stderr]) {
        expect(output).not.toContain(DEMO_ACCOUNT.login);
        expect(output).not.toContain(DEMO_ACCOUNT.password);
      }
    } finally {
      await portal.stop();
    }
  });
});

const RUN_ID = /^\d{8}T\d{6}Z$/;

// A node address nothing listens on, for rows that never reach a browser.
const UNUSED_URL = 'http://127.0.0.1:9/';

// A run of the slow rows takes two passes, each with a browser start.
const RUN_TIMEOUT_MS = 170_000;

type SummaryFile = {
  run_id: string;
  status: string;
  result: string;
  exit_code: number;
  reason: string | null;
  nodes: { scenario: string; node: string; class: string; recheck: string | null }[];
  not_measured: { scenario: string; node: string; metric: string }[];
  unused_baselines: { scenario: string; node: string; metric: string }[];
};

type PassFileJson = {
  projects: { project: string; class: string; error_category: string | null; metrics: { name: string }[] }[];
};

// A node is served by a demo portal in the given mode, or is only named in env.json.
type NodeMode = PortalMode | 'unused';

type RowContext = {
  run: RunResult;
  summary: SummaryFile;
  runId: string;
  runDir: string;
  lines: string[];
};

type Row = {
  name: string;
  /** scenario -> node -> how the node is served */
  scenarios: Record<string, Record<string, NodeMode>>;
  /** scenario name -> source written to the demo project for the time of the row */
  sources?: Record<string, string>;
  baselines?: BaselineMap;
  /** The command line after blw; defaults to ['run']. */
  args?: string[];
  /** Wraps the run itself, for fixtures that change files; env is the environment passed to blw. */
  wrap?: <T>(context: { env: NodeJS.ProcessEnv }, fn: () => Promise<T>) => Promise<T>;
  exit: 0 | 1 | 3;
  result: 'PASS' | 'FAIL';
  /** The REASON= token, or null for a passing run. */
  reason: string | null;
  status: 'pass' | 'fail' | 'not_ready';
  /** Expected recheck per node of summary.json, in node order. */
  recheck?: Record<string, string | null>;
  /** 'rows': metrics.csv has rows of this run; 'none': it has none. */
  metrics?: 'rows' | 'none';
  check?: (context: RowContext) => void | Promise<void>;
};

function withSources<T>(sources: [string, string][], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = sources;
  if (first === undefined) return fn();
  return withScenario(first[0], first[1], () => withSources(rest, fn));
}

function exists(...parts: string[]): boolean {
  return fs.existsSync(path.join(...parts));
}

function readPass(runDir: string, pass: number): PassFileJson {
  return JSON.parse(fs.readFileSync(path.join(runDir, `pass-${pass}.json`), 'utf8')) as PassFileJson;
}

function metricCells(runId: string): string[][] {
  return csvLinesFor('metrics.csv', runId).map((line) => line.split(','));
}

function countRows(cells: string[][], pass: string, node: string): number {
  return cells.filter((row) => row[1] === pass && row[4] === node).length;
}

const NOBASELINE_SOURCE = `import { test } from 'baselinewatch';

test('a metric without a baseline', async ({ page, measure }) => {
  await page.goto('/');
  await measure('missing_ms', async () => {
    await page.waitForTimeout(10);
  });
});
`;

const MULTI_SOURCE = `import { test } from 'baselinewatch';

test('quick', async ({ page, measure }) => {
  await measure('quick_ms', async () => {
    await page.goto('/');
  });
});

test('pause', async ({ page, measure }) => {
  await page.goto('/');
  await measure('pause_ms', async () => {
    await page.waitForTimeout(50);
  });
});
`;

const CRASH_SOURCE = 'process.exit(7);\n';

// What every row that stops before Playwright starts has in common.
const NOT_READY = {
  exit: 3,
  result: 'FAIL',
  status: 'not_ready',
  recheck: {},
  metrics: 'none',
} as const;

// Rows that stop early still need a valid env.json, unless the row is about env.json itself.
const UNUSED_SCENARIOS: Row['scenarios'] = { demo: { 'node-1': 'unused' } };

// The message of a not-ready run is on the console, a configuration message exactly once and
// unchanged, and no pass was started.
function notReadyCheck(expected: string[], configMessage: boolean): (context: RowContext) => void {
  return ({ run, runDir }) => {
    const output = `${run.stdout}\n${run.stderr}`;
    for (const part of expected) {
      expect(output).toContain(part);
    }
    expect(output.split('[config]').length - 1).toBe(configMessage ? 1 : 0);
    expect(exists(runDir, 'pass-1.json')).toBe(false);
    expect(exists(runDir, 'pass-2.json')).toBe(false);
  };
}

const ROWS: Row[] = [
  {
    name: 'ok portal passes',
    scenarios: { demo: { 'node-1': 'ok' } },
    exit: 0,
    result: 'PASS',
    reason: null,
    status: 'pass',
    recheck: { 'node-1': null },
    metrics: 'rows',
    check: ({ runDir, summary }) => {
      expect(exists(runDir, 'pass-1.json')).toBe(true);
      expect(exists(runDir, 'pass-2.json')).toBe(false);
      expect(summary.not_measured).toEqual([]);
      expect(summary.unused_baselines).toEqual([]);
    },
  },
  {
    name: 'ok portal with an unused baseline passes and lists it',
    scenarios: { demo: { 'node-1': 'ok' } },
    baselines: { demo: { extra_ms: { reference_ms: 100, maxRatio: 3 } } },
    exit: 0,
    result: 'PASS',
    reason: null,
    status: 'pass',
    recheck: { 'node-1': null },
    metrics: 'rows',
    check: ({ summary }) => {
      expect(summary.unused_baselines).toEqual([{ scenario: 'demo', node: 'node-1', metric: 'extra_ms' }]);
      expect(summary.not_measured).toEqual([]);
      const report = fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, 'report.txt'), 'utf8');
      expect(report).toContain('extra_ms');
    },
  },
  {
    name: 'slowOnce on one node is rechecked ok and still fails',
    scenarios: { demo: { 'node-1': 'slowOnce', 'node-2': 'ok' } },
    exit: 1,
    result: 'FAIL',
    reason: 'slow',
    status: 'fail',
    recheck: { 'node-1': 'ok', 'node-2': null },
    metrics: 'rows',
    check: ({ runDir, runId }) => {
      expect(readPass(runDir, 2).projects.map((item) => item.project)).toEqual(['demo--node-1']);
      const cells = metricCells(runId);
      expect(countRows(cells, '1', 'node-1')).toBe(3);
      expect(countRows(cells, '1', 'node-2')).toBe(3);
      expect(countRows(cells, '2', 'node-1')).toBe(3);
      expect(countRows(cells, '2', 'node-2')).toBe(0);
      expect(cells.every((row) => row.at(-1) === '1')).toBe(true);
    },
  },
  {
    name: 'slowAlways stays slow',
    scenarios: { demo: { 'node-1': 'slowAlways' } },
    exit: 1,
    result: 'FAIL',
    reason: 'slow',
    status: 'fail',
    recheck: { 'node-1': 'still_slow' },
    metrics: 'rows',
    check: ({ runDir }) => {
      expect(readPass(runDir, 2).projects.map((item) => [item.project, item.class])).toEqual([['demo--node-1', 'slow']]);
    },
  },
  {
    name: 'loginError is an error and is not repeated',
    scenarios: { demo: { 'node-1': 'loginError' } },
    exit: 1,
    result: 'FAIL',
    reason: 'error',
    status: 'fail',
    recheck: { 'node-1': null },
    check: ({ runDir, summary }) => {
      expect(exists(runDir, 'pass-1.json')).toBe(true);
      expect(exists(runDir, 'pass-2.json')).toBe(false);
      expect(exists(runDir, 'pass-2')).toBe(false);
      expect(summary.not_measured.map((ref) => `${ref.scenario}/${ref.node}/${ref.metric}`).sort()).toEqual([
        'demo/node-1/history_ms',
        'demo/node-1/login_ms',
        'demo/node-1/overview_ms',
      ]);
    },
  },
  {
    name: 'broken page is an error and is not repeated',
    scenarios: { demo: { 'node-1': 'broken' } },
    exit: 1,
    result: 'FAIL',
    reason: 'error',
    status: 'fail',
    recheck: { 'node-1': null },
    check: ({ runDir }) => {
      expect(exists(runDir, 'pass-1.json')).toBe(true);
      expect(exists(runDir, 'pass-2.json')).toBe(false);
      expect(exists(runDir, 'pass-2')).toBe(false);
    },
  },
  {
    name: 'a metric without baseline is an error',
    scenarios: { 'e2e-nobaseline': { 'node-1': 'ok' } },
    sources: { 'e2e-nobaseline': NOBASELINE_SOURCE },
    exit: 1,
    result: 'FAIL',
    reason: 'error',
    status: 'fail',
    recheck: { 'node-1': null },
    check: ({ runDir }) => {
      const [project] = readPass(runDir, 1).projects;
      expect(project?.class).toBe('error');
      expect(project?.error_category).toBe('config');
      expect(exists(runDir, 'pass-2.json')).toBe(false);
    },
  },
  {
    name: 'a slow step then a failure is an error',
    scenarios: { 'e2e-slowfail': { 'node-1': 'ok' } },
    sources: { 'e2e-slowfail': SLOW_THEN_FAIL_SOURCE },
    baselines: { 'e2e-slowfail': { wait_ms: { reference_ms: 1, maxRatio: 1 } } },
    exit: 1,
    result: 'FAIL',
    reason: 'error',
    status: 'fail',
    recheck: { 'node-1': null },
    check: ({ runDir }) => {
      expect(readPass(runDir, 1).projects.map((item) => item.class)).toEqual(['error']);
      expect(exists(runDir, 'pass-2.json')).toBe(false);
      expect(exists(runDir, 'pass-2')).toBe(false);
    },
  },
  {
    name: 'two tests in one project fold to slow',
    scenarios: { 'e2e-multi': { 'node-1': 'ok' } },
    sources: { 'e2e-multi': MULTI_SOURCE },
    baselines: {
      'e2e-multi': {
        quick_ms: { reference_ms: 60_000, maxRatio: 1 },
        pause_ms: { reference_ms: 1, maxRatio: 1 },
      },
    },
    exit: 1,
    result: 'FAIL',
    reason: 'slow',
    status: 'fail',
    recheck: { 'node-1': 'still_slow' },
    metrics: 'rows',
    check: ({ runDir }) => {
      const [project] = readPass(runDir, 1).projects;
      expect(readPass(runDir, 1).projects).toHaveLength(1);
      expect(project?.class).toBe('slow');
      expect(project?.metrics.map((metric) => metric.name).sort()).toEqual(['pause_ms', 'quick_ms']);
    },
  },
  {
    name: 'a scenario that exits while loading leaves no report',
    scenarios: { 'e2e-crash': { 'node-1': 'unused' } },
    sources: { 'e2e-crash': CRASH_SOURCE },
    exit: 1,
    result: 'FAIL',
    reason: 'report_not_built',
    status: 'fail',
    recheck: {},
    metrics: 'none',
    check: ({ runDir }) => {
      expect(exists(runDir, 'pass-1.json')).toBe(false);
      expect(exists(runDir, 'pass-2.json')).toBe(false);
    },
  },
  {
    ...NOT_READY,
    name: 'missing env.json',
    scenarios: UNUSED_SCENARIOS,
    wrap: (_context, fn) => withDemoEnv(null, fn),
    reason: 'config',
    check: notReadyCheck(['env.json', DEMO_DIR], true),
  },
  {
    ...NOT_READY,
    name: 'broken env.json',
    scenarios: UNUSED_SCENARIOS,
    wrap: (_context, fn) => withRawFile(DEMO_ENV_FILE, '{ "environment": ', fn),
    reason: 'config',
    check: notReadyCheck(['env.json'], true),
  },
  {
    ...NOT_READY,
    name: 'missing baselines.json',
    scenarios: UNUSED_SCENARIOS,
    wrap: (_context, fn) => withRawFile(DEMO_BASELINES_FILE, null, fn),
    reason: 'config',
    check: notReadyCheck(['baselines.json'], true),
  },
  {
    ...NOT_READY,
    name: 'broken baselines.json',
    scenarios: UNUSED_SCENARIOS,
    wrap: (_context, fn) => withRawFile(DEMO_BASELINES_FILE, '{ nope', fn),
    reason: 'config',
    check: notReadyCheck(['baselines.json'], true),
  },
  {
    ...NOT_READY,
    name: 'scenario without its file',
    scenarios: { 'e2e-ghost': { 'node-1': 'unused' } },
    reason: 'config',
    check: notReadyCheck(['e2e-ghost.spec.ts', 'looked in'], true),
  },
  {
    ...NOT_READY,
    name: 'browser not installed',
    scenarios: UNUSED_SCENARIOS,
    wrap: async (context, fn) => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-e2e-browsers-'));
      context.env.PLAYWRIGHT_BROWSERS_PATH = empty;
      try {
        return await fn();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    },
    reason: 'browser',
    check: notReadyCheck(['npx playwright install'], false),
  },
  {
    ...NOT_READY,
    name: 'two copies of Playwright',
    scenarios: UNUSED_SCENARIOS,
    wrap: (_context, fn) => withPlaywrightStub(fn),
    reason: 'playwright_copies',
    check: notReadyCheck(['@playwright/test'], false),
  },
  {
    ...NOT_READY,
    name: 'unknown argument',
    scenarios: UNUSED_SCENARIOS,
    args: ['run', '--bogus'],
    reason: 'usage',
    check: notReadyCheck(['--bogus'], false),
  },
];

// One run of blw in the demo project, started from outside it, with every file the row needs in
// place for the time of the run and removed or restored afterwards.
async function runRow(row: Row): Promise<void> {
  cleanArtifacts();
  const portals: RunningPortal[] = [];
  try {
    const scenarios: Record<string, Record<string, string>> = {};
    for (const [scenario, nodes] of Object.entries(row.scenarios)) {
      const urls: Record<string, string> = {};
      for (const [node, mode] of Object.entries(nodes)) {
        if (mode === 'unused') {
          urls[node] = UNUSED_URL;
        } else {
          const portal = await startPortal(mode);
          portals.push(portal);
          urls[node] = portal.url;
        }
      }
      scenarios[scenario] = urls;
    }
    const env = await demoEnv({}, { scenarios });
    const context = { env: {} as NodeJS.ProcessEnv };
    const go = (): Promise<RunResult> =>
      runBlw(row.args ?? ['run'], { cwd: REPO_ROOT, env: context.env, timeoutMs: RUN_TIMEOUT_MS });
    const inner = (): Promise<RunResult> => (row.wrap === undefined ? go() : row.wrap(context, go));
    const withFiles = (): Promise<RunResult> => withDemoEnv(env, inner);
    const withBase = (): Promise<RunResult> =>
      row.baselines === undefined ? withFiles() : withBaselines(row.baselines, withFiles);
    const run = await withSources(Object.entries(row.sources ?? {}), withBase);

    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.timedOut).toBe(false);
    expect(run.status, output).toBe(row.exit);

    const lines = outputLines(run);
    expect(lines.at(-1), output).toBe(`RESULT=${row.result}`);
    if (row.reason === null) {
      expect(lines.filter((line) => line.startsWith('REASON='))).toEqual([]);
    } else {
      expect(lines.at(-2), output).toBe(`REASON=${row.reason}`);
    }

    const summary = readArtifactJson('summary.json') as unknown as SummaryFile;
    expect(summary.status).toBe(row.status);
    expect(summary.result).toBe(row.result);
    expect(summary.exit_code).toBe(row.exit);
    expect(summary.reason).toBe(row.reason);
    expect(summary.run_id).toMatch(RUN_ID);
    const runId = summary.run_id;
    const runDir = path.join(DEMO_ARTIFACTS_DIR, 'runs', runId);

    const runsLines = csvLinesFor('runs.csv', runId);
    expect(runsLines).toHaveLength(1);
    expect(runsLines[0]).toContain(`,${row.result},${row.exit},${row.reason ?? ''},`);

    if (row.recheck !== undefined) {
      expect(summary.nodes.map((node) => [node.node, node.recheck])).toEqual(Object.entries(row.recheck));
    }
    const cells = metricCells(runId);
    if (row.metrics === 'rows') {
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell.at(-1) === '1')).toBe(true);
    } else if (row.metrics === 'none') {
      expect(cells).toEqual([]);
    }

    await row.check?.({ run, summary, runId, runDir, lines });
    await expectNoDemoSecrets(run, runId);
  } finally {
    for (const portal of portals) {
      await portal.stop();
    }
  }
}

test.describe('outcome table', () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      await runRow(row);
    });
  }
});

// The Cyrillic block, written as a range so that no Russian text is committed outside the files
// that are allowed to hold it.
const CYRILLIC = /[Ѐ-ӿ]/;

// One run against a demo portal with the given locale in env.json; the report text and the lines.
async function runWithLocale(mode: PortalMode, locale: 'en' | 'ru'): Promise<{ lines: string[]; report: string }> {
  cleanArtifacts();
  const portal = await startPortal(mode);
  try {
    const env = { ...(await demoEnv({ 'node-1': portal.url })), locale };
    const run = await withDemoEnv(env, () => runBlw(['run'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS }));
    expect(run.timedOut).toBe(false);
    const summary = readArtifactJson('summary.json') as unknown as SummaryFile;
    expect(summary.run_id).toMatch(RUN_ID);
    await expectNoDemoSecrets(run, summary.run_id);
    return { lines: outputLines(run), report: fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, 'report.txt'), 'utf8') };
  } finally {
    await portal.stop();
  }
}

test('locale ru changes the report text but not the machine lines', async () => {
  const english = await runWithLocale('ok', 'en');
  const russian = await runWithLocale('ok', 'ru');
  expect(english.lines.at(-1)).toBe('RESULT=PASS');
  expect(russian.lines.at(-1)).toBe('RESULT=PASS');
  expect(CYRILLIC.test(english.report)).toBe(false);
  expect(CYRILLIC.test(russian.report)).toBe(true);

  const failed = await runWithLocale('loginError', 'ru');
  expect(failed.lines.slice(-2)).toEqual(['REASON=error', 'RESULT=FAIL']);
  const failedEnglish = await runWithLocale('loginError', 'en');
  expect(failedEnglish.lines.slice(-2)).toEqual(failed.lines.slice(-2));
});

test('fixtures are restored when the wrapped code throws', async () => {
  const snapshot = (file: string): Buffer | null => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  const envBefore = snapshot(DEMO_ENV_FILE);
  const baselinesBefore = snapshot(DEMO_BASELINES_FILE);
  const nested = path.join(DEMO_DIR, 'node_modules', 'baselinewatch', 'node_modules');
  const stubManifest = path.join(nested, '@playwright', 'test', 'package.json');
  const boom = async (): Promise<never> => {
    throw new Error('boom');
  };

  await expect(
    withPlaywrightStub(async () => {
      if (!fs.existsSync(stubManifest)) throw new Error('the stub was not written');
      return boom();
    }),
  ).rejects.toThrow('boom');
  await expect(
    withRawFile(DEMO_BASELINES_FILE, '{ nope', async () => {
      if (fs.readFileSync(DEMO_BASELINES_FILE, 'utf8') !== '{ nope') throw new Error('the file was not replaced');
      return boom();
    }),
  ).rejects.toThrow('boom');
  await expect(
    withDemoEnv(null, async () => {
      if (fs.existsSync(DEMO_ENV_FILE)) throw new Error('env.json was not removed');
      return boom();
    }),
  ).rejects.toThrow('boom');

  expect(fs.existsSync(nested)).toBe(false);
  expect(snapshot(DEMO_ENV_FILE)).toEqual(envBefore);
  expect(snapshot(DEMO_BASELINES_FILE)).toEqual(baselinesBefore);
});
