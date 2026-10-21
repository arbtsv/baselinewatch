// Tests for src/run.ts: blw run driven through fake dependencies over a temporary project root.
// Run: node --test test/run.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Baselines } from '../src/baselines.ts';
import { catalogFor } from '../src/i18n/index.ts';
import { runLayout } from '../src/layout.ts';
import { buildPassFile, passFileText, writeFileAtomic } from '../src/pass-file.ts';
import type { PrecheckOk, PrelaunchFailure } from '../src/precheck.ts';
import type { PassRun, PassRunOptions } from '../src/process.ts';
import type { PassProject, Summary } from '../src/protocol.ts';
import { main, projectRootFrom, readCoreVersion, type RunDeps } from '../src/run.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-run-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const FIRST_RUN_ID = '20261020T100000Z';
const SECOND_RUN_ID = '20261020T100001Z';
const PROJECTS = ['demo--node-1', 'demo--node-2'];
const PRINT_MARKER = 'marker-of-the-print';
const CLEAN_EXIT: PassRun = { status: 0, timedOut: false, interrupted: false };

let rootCounter = 0;

/** A project root with the package installed where `blw` expects it. */
function makeRoot(): { root: string; cliFile: string } {
  rootCounter += 1;
  const root = path.join(WORK, `project-${rootCounter}`);
  const packageDir = path.join(root, 'node_modules', 'baselinewatch');
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'baselinewatch', version: '9.9.9' }));
  return { root, cliFile: path.join(packageDir, 'dist', 'cli.js') };
}

function project(node: string, projectClass: PassProject['class']): PassProject {
  return {
    project: `demo--${node}`,
    scenario: 'demo',
    node,
    class: projectClass,
    metrics: [{ name: 'login_ms', ms: 900, reference_ms: 300, maxRatio: 3, ratio: 3, verdict: projectClass === 'slow' ? 'slow' : 'ok' }],
    error_category: projectClass === 'error' ? 'other' : null,
  };
}

function writePass(options: PassRunOptions, projects: PassProject[]): void {
  const layout = runLayout(options.root, { runId: options.runId, pass: options.pass, manual: false });
  const at = new Date('2026-10-20T10:00:05.000Z');
  writeFileAtomic(
    layout.passFile,
    passFileText(buildPassFile({ runId: options.runId, pass: options.pass, startedAt: at, finishedAt: at, projects })),
  );
}

function checked(locale: 'en' | 'ru' = 'en'): { ok: true; value: PrecheckOk } {
  return {
    ok: true,
    value: {
      env: {
        environment: 'demo',
        locale,
        account: { login: 'placeholder-login', password: 'placeholder-password' },
        retention_days: 30,
        scenarios: { demo: { nodes: { 'node-1': 'http://node-1.test/', 'node-2': 'http://node-2.test/' } } },
      },
      baselines: {} as Baselines,
      projects: PROJECTS,
    },
  };
}

type Harness = {
  root: string;
  cliFile: string;
  lines: string[];
  passCalls: PassRunOptions[];
  prechecksCalls: number;
  unregistered: number;
  sleeps: number[];
  /** How many prints threw on purpose. */
  printFailures: number;
  /** Calls the handler registered through onInterrupt, as a signal would. */
  interrupt: () => void;
  deps: RunDeps;
};

function harness(options: {
  runPass?: (options: PassRunOptions) => Promise<PassRun> | PassRun;
  prechecks?: { ok: true; value: PrecheckOk } | { ok: false; failure: PrelaunchFailure };
  cliFile?: string;
  root?: string;
  /** Makes print throw (the first `times` calls) for the lines that `match`; such a line is not recorded. */
  printFailure?: { match: (line: string) => boolean; times: number };
}): Harness {
  const made = options.root !== undefined && options.cliFile !== undefined ? { root: options.root, cliFile: options.cliFile } : makeRoot();
  let clock = Date.parse('2026-10-20T10:00:00.000Z');
  let handler: (() => void) | undefined;
  const state: Harness = {
    root: made.root,
    cliFile: options.cliFile ?? made.cliFile,
    lines: [],
    passCalls: [],
    prechecksCalls: 0,
    unregistered: 0,
    sleeps: [],
    printFailures: 0,
    interrupt: () => handler?.(),
    deps: undefined as unknown as RunDeps,
  };
  state.deps = {
    cliFile: state.cliFile,
    now: () => new Date(clock),
    sleep: async (ms) => {
      state.sleeps.push(ms);
      clock += ms;
    },
    print: (line) => {
      const failure = options.printFailure;
      if (failure !== undefined && state.printFailures < failure.times && failure.match(line)) {
        state.printFailures += 1;
        throw new Error(PRINT_MARKER);
      }
      state.lines.push(line);
    },
    prechecks: async () => {
      state.prechecksCalls += 1;
      return options.prechecks ?? checked();
    },
    runPass: async (passOptions) => {
      state.passCalls.push(passOptions);
      return options.runPass === undefined ? CLEAN_EXIT : options.runPass(passOptions);
    },
    onInterrupt: (next) => {
      handler = next;
      return () => {
        state.unregistered += 1;
        handler = undefined;
      };
    },
  };
  return state;
}

const artifacts = (root: string): string => path.join(root, 'artifacts');

function readSummary(root: string): Summary {
  return JSON.parse(fs.readFileSync(path.join(artifacts(root), 'summary.json'), 'utf8')) as Summary;
}

function runsCsvLines(root: string): string[] {
  return fs.readFileSync(path.join(artifacts(root), 'runs.csv'), 'utf8').trimEnd().split('\n');
}

describe('project root and version', () => {
  test('the root is the directory whose node_modules holds the package', () => {
    assert.equal(projectRootFrom(path.join('C:', 'p', 'node_modules', 'baselinewatch', 'dist', 'cli.js')), path.join('C:', 'p'));
  });

  test('a cli outside <root>/node_modules/baselinewatch has no root', () => {
    assert.equal(projectRootFrom(path.join('C:', 'p', 'baselinewatch', 'dist', 'cli.js')), undefined);
    assert.equal(projectRootFrom(path.join('C:', 'p', 'node_modules', 'other', 'dist', 'cli.js')), undefined);
    assert.equal(projectRootFrom(path.join('C:', 'p', 'src', 'cli.ts')), undefined);
  });

  test('the version comes from the package.json of the package', () => {
    const { cliFile } = makeRoot();
    assert.equal(readCoreVersion(cliFile), '9.9.9');
  });
});

describe('a passing run', () => {
  test('ok pass 1 gives exit 0, the run files and RESULT=PASS last', async () => {
    const h = harness({
      runPass: (options) => {
        options.print('[pass 1] demo--node-1: ok');
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.passCalls.length, 1);
    const [call] = h.passCalls as [PassRunOptions];
    assert.equal(call.pass, 1);
    assert.deepEqual(call.projects, []);
    assert.equal(call.runId, FIRST_RUN_ID);
    assert.equal(call.root, h.root);
    const summary = readSummary(h.root);
    assert.equal(summary.status, 'pass');
    assert.equal(summary.run_id, FIRST_RUN_ID);
    assert.equal(summary.core_version, '9.9.9');
    assert.ok(fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8').includes(FIRST_RUN_ID));
    const csv = runsCsvLines(h.root);
    assert.equal(csv.length, 2);
    assert.ok((csv[1] as string).startsWith(`${FIRST_RUN_ID},`));
    assert.ok((csv[1] as string).endsWith(',PASS,0,,9.9.9,1'));
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.ok(!h.lines.some((line) => line.startsWith('REASON=')));
    // The relayed pass line comes before the summary lines.
    assert.ok(h.lines.indexOf('[pass 1] demo--node-1: ok') < h.lines.indexOf(catalogFor('en').resultLine('PASS', null)));
  });
});

describe('the second pass', () => {
  test('a slow node is rechecked alone and the run still fails', async () => {
    const h = harness({
      runPass: (options) => {
        if (options.pass === 1) {
          writePass(options, [project('node-1', 'slow'), project('node-2', 'ok')]);
        } else {
          writePass(options, [project('node-1', 'ok')]);
        }
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 2);
    const second = h.passCalls[1] as PassRunOptions;
    assert.equal(second.pass, 2);
    assert.deepEqual(second.projects, ['demo--node-1']);
    assert.equal(second.stderrLog, path.join(artifacts(h.root), 'runs', FIRST_RUN_ID, 'pass-2.stderr.log'));
    const summary = readSummary(h.root);
    assert.deepEqual(
      summary.nodes.map((node) => [node.node, node.recheck]),
      [
        ['node-1', 'ok'],
        ['node-2', null],
      ],
    );
    assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    assert.ok((runsCsvLines(h.root)[1] as string).includes(',FAIL,1,slow,'));
  });

  test('an error in pass 1 is never repeated', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, [project('node-1', 'error'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=error', 'RESULT=FAIL']);
    assert.deepEqual(
      readSummary(h.root).nodes.map((node) => node.recheck),
      [null, null],
    );
  });

  test('slow and error together: only the slow project goes to pass 2 and the reason is error', async () => {
    const h = harness({
      runPass: (options) => {
        if (options.pass === 1) {
          writePass(options, [project('node-1', 'slow'), project('node-2', 'error')]);
        } else {
          writePass(options, [project('node-1', 'slow')]);
        }
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 2);
    assert.deepEqual((h.passCalls[1] as PassRunOptions).projects, ['demo--node-1']);
    assert.deepEqual(h.lines.slice(-2), ['REASON=error', 'RESULT=FAIL']);
    const summary = readSummary(h.root);
    assert.equal(summary.nodes[0]?.recheck, 'still_slow');
    assert.equal(summary.nodes[1]?.recheck, null);
  });

  test('no pass-1.json is a failed run with report_not_built and no nodes', async () => {
    const h = harness({});
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=report_not_built', 'RESULT=FAIL']);
    const summary = readSummary(h.root);
    assert.equal(summary.reason, 'report_not_built');
    assert.deepEqual(summary.nodes, []);
  });
});

describe('a run that is not ready', () => {
  test('failed prechecks stop before Playwright and print the message unchanged', async () => {
    const message = '[config] env.json: file not found (looked for C:/p/env.json). Create it.';
    const h = harness({ prechecks: { ok: false, failure: { reason: 'config', message } } });
    const code = await main(['run'], h.deps);
    assert.equal(code, 3);
    assert.equal(h.passCalls.length, 0);
    assert.ok(h.lines.includes(message));
    assert.deepEqual(h.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
    assert.equal(h.lines.indexOf(catalogFor('en').notReady('config')), 0);
    assert.equal(readSummary(h.root).status, 'not_ready');
    assert.ok((runsCsvLines(h.root)[1] as string).includes(',FAIL,3,config,'));
  });

  test('the framing line follows the locale that the failure carries', async () => {
    const h = harness({ prechecks: { ok: false, failure: { reason: 'browser', message: 'No browser.', locale: 'ru' } } });
    await main(['run'], h.deps);
    assert.equal(h.lines[0], catalogFor('ru').notReady('browser'));
    assert.equal(readSummary(h.root).locale, 'ru');
    assert.deepEqual(h.lines.slice(-2), ['REASON=browser', 'RESULT=FAIL']);
  });

  for (const argv of [['run', '--bogus'], [], ['init']]) {
    test(`arguments ${JSON.stringify(argv)} are a usage problem that still leaves a summary`, async () => {
      const h = harness({});
      const code = await main(argv, h.deps);
      assert.equal(code, 3);
      assert.equal(h.prechecksCalls, 0);
      assert.equal(h.passCalls.length, 0);
      assert.deepEqual(h.lines.slice(-2), ['REASON=usage', 'RESULT=FAIL']);
      const summary = readSummary(h.root);
      assert.equal(summary.status, 'not_ready');
      assert.equal(summary.reason, 'usage');
      assert.ok((runsCsvLines(h.root)[1] as string).includes(',FAIL,3,usage,'));
    });
  }

  test('a cli outside node_modules exits 3 with config and writes nothing', async () => {
    const outside = path.join(WORK, 'elsewhere');
    fs.mkdirSync(path.join(outside, 'dist'), { recursive: true });
    const h = harness({ root: outside, cliFile: path.join(outside, 'dist', 'cli.js') });
    const code = await main(['run'], h.deps);
    assert.equal(code, 3);
    assert.deepEqual(h.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
    assert.equal(fs.existsSync(path.join(outside, 'artifacts')), false);
    assert.equal(h.passCalls.length, 0);
  });
});

describe('help and version', () => {
  test('--help prints the usage lines, exits 0 and creates nothing', async () => {
    const h = harness({});
    assert.equal(await main(['run', '--help'], h.deps), 0);
    assert.ok(h.lines.length > 0);
    assert.ok(!h.lines.some((line) => line.startsWith('RESULT=')));
    assert.equal(fs.existsSync(artifacts(h.root)), false);
    assert.equal(h.prechecksCalls, 0);
  });

  test('--version prints the package version, exits 0 and creates nothing', async () => {
    const h = harness({});
    assert.equal(await main(['run', '--version'], h.deps), 0);
    assert.deepEqual(h.lines, ['baselinewatch 9.9.9']);
    assert.equal(fs.existsSync(artifacts(h.root)), false);
  });
});

describe('an unexpected failure', () => {
  test('exits 1 with report_not_built, keeps the stack in cli-error.log and off the console', async () => {
    const failure = new Error('marker-of-the-failure');
    const h = harness({
      runPass: () => {
        throw failure;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=report_not_built', 'RESULT=FAIL']);
    const log = fs.readFileSync(path.join(artifacts(h.root), 'runs', FIRST_RUN_ID, 'cli-error.log'), 'utf8');
    assert.ok(log.includes('marker-of-the-failure'));
    assert.ok(log.includes(String(failure.stack).split('\n')[1]?.trim() ?? 'at '));
    for (const line of h.lines) {
      assert.ok(!line.includes('marker-of-the-failure'), line);
      assert.ok(!line.includes('    at '), line);
    }
    assert.equal(readSummary(h.root).reason, 'report_not_built');
    assert.equal(runsCsvLines(h.root).length, 2);
    assert.equal(h.unregistered, 1);
  });
});

describe('a history file that cannot be written', () => {
  // runs.csv as a directory: every append to it fails.
  function blockRunsCsv(root: string): void {
    fs.mkdirSync(path.join(artifacts(root), 'runs.csv'), { recursive: true });
  }

  test('a clean pass 1 still passes when runs.csv cannot be written', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    blockRunsCsv(h.root);
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.ok(!h.lines.some((line) => line.startsWith('REASON=')));
    const summary = readSummary(h.root);
    assert.equal(summary.status, 'pass');
    assert.equal(summary.result, 'PASS');
    assert.equal(summary.exit_code, 0);
    assert.equal(summary.reason, null);
    assert.deepEqual(summary.warnings, [{ code: 'history_not_written' }]);
    const report = fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8');
    assert.ok(report.includes(catalogFor('en').warning({ code: 'history_not_written' })));
    const log = fs.readFileSync(path.join(artifacts(h.root), 'runs', FIRST_RUN_ID, 'cli-error.log'), 'utf8');
    assert.notEqual(log.trim(), '');
    assert.ok(fs.statSync(path.join(artifacts(h.root), 'runs.csv')).isDirectory());
    for (const line of h.lines) {
      assert.ok(!line.includes('    at '), line);
    }
  });

  test('a failing run keeps its own reason when runs.csv cannot be written', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, options.pass === 1 ? [project('node-1', 'slow'), project('node-2', 'ok')] : [project('node-1', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    blockRunsCsv(h.root);
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    const summary = readSummary(h.root);
    assert.equal(summary.reason, 'slow');
    assert.ok(summary.warnings.some((warning) => warning.code === 'history_not_written' && warning.pass === undefined));
  });
});

describe('an exception after the run is recorded', () => {
  const cleanPass = (options: PassRunOptions): PassRun => {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    return CLEAN_EXIT;
  };
  const reportLine = (line: string): boolean => line.startsWith('Report: ');
  const cliErrorLog = (root: string): string => path.join(artifacts(root), 'runs', FIRST_RUN_ID, 'cli-error.log');

  test('a print that throws after the files are written keeps the passing result', async () => {
    const h = harness({ runPass: cleanPass, printFailure: { match: reportLine, times: 1 } });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.printFailures, 1);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.equal(h.lines.at(-2), catalogFor('en').internalError(cliErrorLog(h.root)));
    assert.ok(!h.lines.includes('REASON=report_not_built'));
    assert.ok(!h.lines.some((line) => line.startsWith('REASON=')));
    const summary = readSummary(h.root);
    assert.equal(summary.status, 'pass');
    assert.equal(summary.reason, null);
    const csv = runsCsvLines(h.root);
    assert.equal(csv.length, 2);
    assert.ok((csv[1] as string).endsWith(',PASS,0,,9.9.9,1'));
    assert.ok(fs.readFileSync(cliErrorLog(h.root), 'utf8').includes(PRINT_MARKER));
  });

  test('the same failing print keeps the reason of a failing run', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, options.pass === 1 ? [project('node-1', 'slow'), project('node-2', 'ok')] : [project('node-1', 'ok')]);
        return CLEAN_EXIT;
      },
      printFailure: { match: reportLine, times: 1 },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    assert.equal(runsCsvLines(h.root).length, 2);
  });

  test('a print that throws on every call does not reject and keeps the exit code', async () => {
    const h = harness({ runPass: cleanPass, printFailure: { match: () => true, times: Number.POSITIVE_INFINITY } });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(readSummary(h.root).status, 'pass');
    assert.equal(runsCsvLines(h.root).length, 2);
  });

  test('a summary.json that cannot be written keeps the row of the run and its result', async () => {
    const h = harness({
      runPass: (options) => {
        // The start of the run has removed the old file; a directory in its place breaks the write.
        fs.mkdirSync(path.join(artifacts(h.root), 'summary.json'), { recursive: true });
        return cleanPass(options);
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    const csv = runsCsvLines(h.root);
    assert.equal(csv.length, 2);
    assert.ok((csv[1] as string).includes(',PASS,0,,'));
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.ok(!h.lines.some((line) => line.startsWith('REASON=')));
    assert.ok(h.lines.includes(catalogFor('en').internalError(cliErrorLog(h.root))));
    assert.ok(fs.readFileSync(cliErrorLog(h.root), 'utf8').includes('summary.json'));
  });
});

describe('run ids and old files', () => {
  test('an existing run directory makes the run wait for the next second', async () => {
    const made = makeRoot();
    fs.mkdirSync(path.join(artifacts(made.root), 'runs', FIRST_RUN_ID), { recursive: true });
    const h = harness({
      root: made.root,
      cliFile: made.cliFile,
      runPass: (options) => {
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    assert.equal(await main(['run'], h.deps), 0);
    assert.deepEqual(h.sleeps, [1000]);
    assert.equal(readSummary(h.root).run_id, SECOND_RUN_ID);
    assert.equal((h.passCalls[0] as PassRunOptions).runId, SECOND_RUN_ID);
  });

  test('a run that gets a run id replaces the old summary and report', async () => {
    const h = harness({});
    fs.mkdirSync(artifacts(h.root), { recursive: true });
    fs.writeFileSync(path.join(artifacts(h.root), 'summary.json'), 'STALE');
    fs.writeFileSync(path.join(artifacts(h.root), 'report.txt'), 'STALE');
    await main(['run', '--bogus'], h.deps);
    assert.ok(!fs.readFileSync(path.join(artifacts(h.root), 'summary.json'), 'utf8').includes('STALE'));
    assert.ok(!fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8').includes('STALE'));
  });
});

describe('an interrupt', () => {
  test('during pass 1 there is no pass 2, but the run still ends with its files and RESULT=FAIL', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, [project('node-1', 'slow'), project('node-2', 'ok')]);
        h.interrupt();
        return { status: null, timedOut: false, interrupted: true };
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 1);
    assert.equal(h.lines.at(-1), 'RESULT=FAIL');
    assert.equal(readSummary(h.root).status, 'fail');
    assert.equal(runsCsvLines(h.root).length, 2);
    assert.equal(h.unregistered, 1);
  });

  test('the signal handed to a pass is aborted by the interrupt', async () => {
    let aborted = false;
    const h = harness({
      runPass: (options) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        h.interrupt();
        return { status: null, timedOut: false, interrupted: true };
      },
    });
    await main(['run'], h.deps);
    assert.equal(aborted, true);
  });
});
