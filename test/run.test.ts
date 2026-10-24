// Tests for src/run.ts: blw run driven through fake dependencies over a temporary project root.
// Run: node --test test/run.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Baselines } from '../src/baselines.ts';
import { catalogFor } from '../src/i18n/index.ts';
import { runLayout } from '../src/layout.ts';
import { buildPassFile, passFileText, writeFileAtomic } from '../src/pass-file.ts';
import type { PrecheckOk, PrelaunchFailure } from '../src/precheck.ts';
import type { PassRun, PassRunOptions } from '../src/process.ts';
import type { TarResult } from '../src/archive.ts';
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
const RUN_PID = 4242;

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

const ACCOUNT = { login: 'placeholder-login', password: 'placeholder-password' };

function checked(
  locale: 'en' | 'ru' = 'en',
  retentionDays = 30,
  account: { login: string; password: string } = ACCOUNT,
): { ok: true; value: PrecheckOk } {
  return {
    ok: true,
    value: {
      env: {
        environment: 'demo',
        locale,
        account,
        retention_days: retentionDays,
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
  /** The line transform that attachRedactor installed, and how often it was installed and removed again. */
  transform: ((line: string) => string) | undefined;
  redactorAttached: number;
  redactorRemoved: number;
  /** The calls of the fake tar runner. */
  zipCalls: { file: string; args: string[] }[];
  /** Calls the handler registered through onInterrupt, as a signal would. */
  interrupt: () => void;
  /** How many handlers were registered through onExit, and how many of them were removed again. */
  exitRegistrations: number;
  exitRemovals: number;
  /** Calls the handlers that onExit holds, as the exit of the process would. */
  fireExit: () => void;
  deps: RunDeps;
};

function harness(options: {
  runPass?: (options: PassRunOptions) => Promise<PassRun> | PassRun;
  prechecks?: { ok: true; value: PrecheckOk } | { ok: false; failure: PrelaunchFailure };
  cliFile?: string;
  root?: string;
  /** Makes print throw (the first `times` calls) for the lines that `match`; such a line is not recorded. */
  printFailure?: { match: (line: string) => boolean; times: number };
  /** The pids that count as alive for the run lock; the run's own pid is 4242. */
  livePids?: readonly number[];
  /** Runs inside the fake pre-launch checks, before they answer. */
  duringPrechecks?: () => void;
  /** A failing fake check still calls the onEnv hook first, as a check that fails after env.json loaded does. */
  accountKnown?: boolean;
  /** With accountKnown: the account the failed checks already knew (the default one when not given). */
  knownAccount?: { login: string; password: string };
  /** A passing fake check that never calls the onEnv hook, so no redactor is built. */
  noRedactor?: boolean;
  /** The function onExit returns, which removes the exit hook, throws. */
  forgetExitThrows?: boolean;
  /** The platform the run believes it is on; win32 by default, so the zip step runs everywhere. */
  platform?: NodeJS.Platform;
  /** What the fake tar does: write a zip (default), leave a partial zip and exit 1, or write a plain tar and exit 0. */
  zip?: 'ok' | 'fail' | 'plain';
}): Harness {
  const made = options.root !== undefined && options.cliFile !== undefined ? { root: options.root, cliFile: options.cliFile } : makeRoot();
  let clock = Date.parse('2026-10-20T10:00:00.000Z');
  let handler: (() => void) | undefined;
  const exitHandlers = new Set<() => void>();
  const state: Harness = {
    root: made.root,
    cliFile: options.cliFile ?? made.cliFile,
    lines: [],
    passCalls: [],
    prechecksCalls: 0,
    unregistered: 0,
    sleeps: [],
    printFailures: 0,
    transform: undefined,
    redactorAttached: 0,
    redactorRemoved: 0,
    zipCalls: [],
    interrupt: () => handler?.(),
    exitRegistrations: 0,
    exitRemovals: 0,
    fireExit: () => {
      for (const exitHandler of [...exitHandlers]) {
        exitHandler();
      }
    },
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
      state.lines.push(state.transform === undefined ? line : state.transform(line));
    },
    prechecks: async (_root, _cliFile, _deps, hooks) => {
      state.prechecksCalls += 1;
      options.duringPrechecks?.();
      const result = options.prechecks ?? checked();
      if (result.ok) {
        if (options.noRedactor !== true) {
          hooks?.onEnv?.(result.value.env);
        }
      } else if (options.accountKnown === true) {
        hooks?.onEnv?.(checked('en', 30, options.knownAccount).value.env);
      }
      return result;
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
    onExit: (exitHandler) => {
      state.exitRegistrations += 1;
      exitHandlers.add(exitHandler);
      return () => {
        if (options.forgetExitThrows === true) {
          throw new Error('the exit hook cannot be removed');
        }
        state.exitRemovals += 1;
        exitHandlers.delete(exitHandler);
      };
    },
    pid: RUN_PID,
    isAlive: (pid) => (options.livePids ?? [RUN_PID]).includes(pid),
    attachRedactor: (transform) => {
      state.redactorAttached += 1;
      state.transform = transform;
      return () => {
        state.redactorRemoved += 1;
        state.transform = undefined;
      };
    },
    platform: options.platform ?? 'win32',
    cwd: () => made.root,
    zip: async (file, args): Promise<TarResult> => {
      state.zipCalls.push({ file, args: [...args] });
      const output = args[args.indexOf('-f') + 1] as string;
      const names = args.slice(args.indexOf('--') + 1).join('\n');
      if (options.zip === 'plain') {
        fs.writeFileSync(output, `plain tar\0${names}`);
        return { status: 0, timedOut: false };
      }
      fs.writeFileSync(output, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(names)]));
      return { status: options.zip === 'fail' ? 1 : 0, timedOut: false };
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

  for (const argv of [['run', '--bogus'], [], ['report']]) {
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

  test('the message for an unsupported install location names the supported install and the copy', async () => {
    const outside = path.join(WORK, 'elsewhere-named');
    fs.mkdirSync(path.join(outside, 'dist'), { recursive: true });
    const h = harness({ root: outside, cliFile: path.join(outside, 'dist', 'cli.js') });
    assert.equal(await main(['run'], h.deps), 3);
    const message = h.lines.find((line) => line.includes('node_modules/baselinewatch')) ?? '';
    assert.ok(message.includes('.tgz'), h.lines.join('\n'));
    assert.ok(message.includes(outside), message);
    assert.deepEqual(h.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
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

  for (const argv of [['--help'], ['-h'], ['--version'], ['-v']]) {
    test(`${JSON.stringify(argv)} as the first argument answers with exit 0 and no run`, async () => {
      const h = harness({});
      assert.equal(await main(argv, h.deps), 0);
      assert.ok(h.lines.length > 0);
      assert.ok(!h.lines.some((line) => line.startsWith('RESULT=')));
      assert.equal(h.prechecksCalls, 0);
      assert.equal(h.passCalls.length, 0);
      assert.equal(fs.existsSync(artifacts(h.root)), false);
    });
  }

  test('top-level help and version leave existing run files untouched', async () => {
    const h = harness({});
    const files = {
      'summary.json': '{"sentinel":"summary"}\n',
      'report.txt': 'sentinel report\n',
      'runs.csv': 'run_id,result\nsentinel-run,PASS\n',
    };
    fs.mkdirSync(artifacts(h.root), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(artifacts(h.root), name), text);
    }
    assert.equal(await main(['--version'], h.deps), 0);
    assert.equal(await main(['-h'], h.deps), 0);
    for (const [name, text] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(artifacts(h.root), name), 'utf8'), text, name);
    }
    assert.equal(fs.existsSync(path.join(artifacts(h.root), 'runs')), false);
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

  // The data reporter in the child leaves this file next to the pass file when the append of its metric rows failed.
  function writeHistoryError(options: PassRunOptions): void {
    const layout = runLayout(options.root, { runId: options.runId, pass: options.pass, manual: false });
    fs.writeFileSync(path.join(path.dirname(layout.passFile), `pass-${options.pass}.history-error.log`), 'metrics.csv: EISDIR\n');
  }

  test('a history error file of pass 1 becomes a warning of that pass and leaves the pass verdict', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        writeHistoryError(options);
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.ok(!h.lines.some((line) => line.startsWith('REASON=')));
    const summary = readSummary(h.root);
    assert.equal(summary.status, 'pass');
    assert.deepEqual(summary.warnings, [{ code: 'history_not_written', pass: 1 }]);
    const report = fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8');
    assert.ok(report.includes(catalogFor('en').warning({ code: 'history_not_written', pass: 1 })));
  });

  test('a history error file of pass 2 alone names pass 2 and the failing run keeps its reason', async () => {
    const h = harness({
      runPass: (options) => {
        if (options.pass === 1) {
          writePass(options, [project('node-1', 'slow'), project('node-2', 'ok')]);
        } else {
          writePass(options, [project('node-1', 'ok')]);
          writeHistoryError(options);
        }
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    assert.deepEqual(readSummary(h.root).warnings, [{ code: 'history_not_written', pass: 2 }]);
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

describe('the run lock', () => {
  const lockPath = (root: string): string => path.join(artifacts(root), '.lock');
  const HOLDER = { pid: 7777, started_at: '2026-10-20T09:59:00.000Z', run_id: '20261020T095900Z' };
  const SENTINELS = {
    'summary.json': '{"sentinel":"summary"}\n',
    'report.txt': 'sentinel report\n',
    'runs.csv': 'run_id,result\nsentinel-run,PASS\n',
  };

  // A live run of pid 7777 that has written its lock and the files of its previous run.
  function holdWithPeer(h: Harness): string {
    fs.mkdirSync(artifacts(h.root), { recursive: true });
    for (const [name, text] of Object.entries(SENTINELS)) {
      fs.writeFileSync(path.join(artifacts(h.root), name), text);
    }
    const text = `${JSON.stringify(HOLDER)}\n`;
    fs.writeFileSync(lockPath(h.root), text);
    return text;
  }

  function expectUntouched(h: Harness, lockText: string): void {
    for (const [name, text] of Object.entries(SENTINELS)) {
      assert.equal(fs.readFileSync(path.join(artifacts(h.root), name), 'utf8'), text, name);
    }
    assert.equal(fs.readFileSync(lockPath(h.root), 'utf8'), lockText);
    assert.equal(fs.existsSync(path.join(artifacts(h.root), 'runs')), false);
    assert.deepEqual(fs.readdirSync(artifacts(h.root)).sort(), ['.lock', 'report.txt', 'runs.csv', 'summary.json']);
  }

  test('a live holder makes the run exit 3 with locked and writes nothing', async () => {
    const h = harness({ livePids: [RUN_PID, HOLDER.pid] });
    const lockText = holdWithPeer(h);
    const code = await main(['run'], h.deps);
    assert.equal(code, 3);
    assert.deepEqual(h.lines.slice(-2), ['REASON=locked', 'RESULT=FAIL']);
    assert.ok(h.lines.some((line) => line.includes('.lock')), h.lines.join('\n'));
    assert.ok(h.lines.some((line) => line.includes(String(HOLDER.pid))), h.lines.join('\n'));
    expectUntouched(h, lockText);
    assert.equal(h.prechecksCalls, 0);
    assert.equal(h.passCalls.length, 0);
  });

  test('a usage problem under a live lock is locked as well and leaves no summary of its own', async () => {
    const h = harness({ livePids: [RUN_PID, HOLDER.pid] });
    const lockText = holdWithPeer(h);
    const code = await main(['run', '--bogus'], h.deps);
    assert.equal(code, 3);
    assert.deepEqual(h.lines.slice(-2), ['REASON=locked', 'RESULT=FAIL']);
    expectUntouched(h, lockText);
    assert.equal(h.prechecksCalls, 0);
  });

  test('help and version take no lock and leave a held lock alone', async () => {
    const h = harness({ livePids: [RUN_PID, HOLDER.pid] });
    const lockText = holdWithPeer(h);
    assert.equal(await main(['--help'], h.deps), 0);
    assert.equal(await main(['run', '--version'], h.deps), 0);
    expectUntouched(h, lockText);
  });

  test('a run holds the lock with its pid and run id while the pass works, and leaves none behind', async () => {
    let seen: unknown;
    const h = harness({
      runPass: (options) => {
        seen = JSON.parse(fs.readFileSync(lockPath(h.root), 'utf8'));
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
    });
    assert.equal(await main(['run'], h.deps), 0);
    assert.deepEqual(seen, { pid: RUN_PID, started_at: '2026-10-20T10:00:00.000Z', run_id: FIRST_RUN_ID });
    assert.equal(fs.existsSync(lockPath(h.root)), false);
    assert.deepEqual(fs.readdirSync(artifacts(h.root)).filter((name) => name.startsWith('.lock')), []);
  });

  test('a pass that throws still ends with report_not_built and no lock', async () => {
    const h = harness({
      runPass: () => {
        throw new Error('marker-of-the-failure');
      },
    });
    assert.equal(await main(['run'], h.deps), 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=report_not_built', 'RESULT=FAIL']);
    assert.equal(fs.existsSync(lockPath(h.root)), false);
  });

  test('an artifacts path that is a file ends with config, names the path and writes nothing', async () => {
    const h = harness({});
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(artifacts(h.root), 'not a directory');
    const code = await main(['run'], h.deps);
    assert.equal(code, 3);
    assert.deepEqual(h.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
    assert.ok(h.lines.some((line) => line.includes(artifacts(h.root))), h.lines.join('\n'));
    assert.ok(h.lines.some((line) => /\(E[A-Z]+\)/.test(line)), `the line names no error code: ${h.lines.join('\n')}`);
    assert.equal(fs.readFileSync(artifacts(h.root), 'utf8'), 'not a directory');
    assert.equal(h.prechecksCalls, 0);
    assert.equal(h.passCalls.length, 0);
  });
});

describe('cleanup at the end of a run never changes its outcome', () => {
  const cleanPass = (options: PassRunOptions): PassRun => {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    return CLEAN_EXIT;
  };

  test('an exit hook that cannot be removed still lets the lock go and the redactor detach', async () => {
    const h = harness({ runPass: cleanPass, prechecks: checked('en', 1), forgetExitThrows: true });
    assert.equal(await main(['run'], h.deps), 0);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    assert.equal(fs.existsSync(path.join(artifacts(h.root), '.lock')), false);
    assert.equal(h.redactorRemoved, 1);
  });

});

describe('a taken over lock and the interrupt paths', () => {
  const lockPath = (root: string): string => path.join(artifacts(root), '.lock');
  const cleanPass = (options: PassRunOptions): PassRun => {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    return CLEAN_EXIT;
  };
  // The lock of a run that died: its pid is not among the live ones.
  function leaveDeadLock(root: string): void {
    fs.mkdirSync(artifacts(root), { recursive: true });
    fs.writeFileSync(lockPath(root), `${JSON.stringify({ pid: 7777, started_at: '2026-10-20T09:59:00.000Z', run_id: '20261020T095900Z' })}\n`);
  }

  test('a lock of a dead process is taken over: the run passes and the report carries one warning', async () => {
    const h = harness({ runPass: cleanPass });
    leaveDeadLock(h.root);
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    const summary = readSummary(h.root);
    assert.equal(summary.warnings.filter((warning) => warning.code === 'lock_taken_over').length, 1);
    assert.deepEqual(summary.warnings, [{ code: 'lock_taken_over' }]);
    const report = fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8');
    assert.ok(report.includes(catalogFor('en').warning({ code: 'lock_taken_over' })));
    assert.equal(fs.existsSync(lockPath(h.root)), false);
    assert.deepEqual(fs.readdirSync(artifacts(h.root)).filter((name) => name.startsWith('.lock')), []);
  });

  test('the warning of the lock comes after the warnings of the passes', async () => {
    const h = harness({
      runPass: (options) => {
        const layout = runLayout(options.root, { runId: options.runId, pass: options.pass, manual: false });
        fs.writeFileSync(path.join(path.dirname(layout.passFile), `pass-${options.pass}.history-error.log`), 'metrics.csv: EISDIR\n');
        return cleanPass(options);
      },
    });
    leaveDeadLock(h.root);
    assert.equal(await main(['run'], h.deps), 0);
    assert.deepEqual(readSummary(h.root).warnings, [{ code: 'history_not_written', pass: 1 }, { code: 'lock_taken_over' }]);
  });

  test('a lock that was taken fresh carries no warning', async () => {
    const h = harness({ runPass: cleanPass });
    assert.equal(await main(['run'], h.deps), 0);
    assert.deepEqual(readSummary(h.root).warnings, []);
  });

  test('an interrupt during the pre-launch checks starts no pass, ends with report_not_built and frees the lock', async () => {
    const h = harness({ runPass: cleanPass, duringPrechecks: () => h.interrupt() });
    const code = await main(['run'], h.deps);
    assert.equal(code, 1);
    assert.equal(h.passCalls.length, 0);
    assert.deepEqual(h.lines.slice(-2), ['REASON=report_not_built', 'RESULT=FAIL']);
    assert.equal(readSummary(h.root).reason, 'report_not_built');
    assert.equal(runsCsvLines(h.root).length, 2);
    assert.equal(fs.existsSync(lockPath(h.root)), false);
    assert.equal(h.unregistered, 1);
  });

  test('the exit hook is registered once, removes the lock when it fires and is removed before main resolves', async () => {
    let lockDuringPass: boolean | undefined;
    let lockAfterExit: boolean | undefined;
    const h = harness({
      runPass: (options) => {
        lockDuringPass = fs.existsSync(lockPath(h.root));
        h.fireExit();
        lockAfterExit = fs.existsSync(lockPath(h.root));
        return cleanPass(options);
      },
    });
    assert.equal(await main(['run'], h.deps), 0);
    assert.equal(lockDuringPass, true);
    assert.equal(lockAfterExit, false);
    assert.equal(h.exitRegistrations, 1);
    assert.equal(h.exitRemovals, 1);
    h.fireExit();
    assert.equal(fs.existsSync(lockPath(h.root)), false);
  });

  test('a locked run registers no exit hook and no interrupt handler', async () => {
    const h = harness({ livePids: [RUN_PID, 7777] });
    leaveDeadLock(h.root);
    assert.equal(await main(['run'], h.deps), 3);
    assert.equal(h.exitRegistrations, 0);
    assert.equal(h.unregistered, 0);
  });
});

describe('retention', () => {
  const OLD = '20261018T100000Z';
  const RECENT = '20261020T090000Z';
  // Two more recent runs: the newest runs are kept whatever their age, so an old run goes only when
  // enough newer ones are there (the current run and the two before it).
  const RECENT_TOO = ['20261020T080000Z', '20261020T070000Z'];
  const cleanPass = (options: PassRunOptions): PassRun => {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    return CLEAN_EXIT;
  };

  // Old and recent run directories and zips, the history files and the manual run, as an earlier week left them.
  function leaveHistory(root: string): { old: string[]; kept: string[] } {
    const dir = artifacts(root);
    const runDir = (id: string): string => {
      const target = path.join(dir, 'runs', id, 'pass-1');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'trace.txt'), 'trace');
      return path.join(dir, 'runs', id);
    };
    const file = (...parts: string[]): string => {
      const target = path.join(dir, ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x');
      return target;
    };
    const old = [runDir(OLD), file(`report_${OLD}.zip`), file(`.report_${OLD}.77.tmp.zip`)];
    const kept = [
      runDir(RECENT),
      file(`report_${RECENT}.zip`),
      ...RECENT_TOO.map(runDir),
      runDir('manual'),
      file('metrics.csv'),
      file('cli-error.log'),
    ];
    fs.writeFileSync(path.join(dir, 'runs.csv'), 'run_id,result\nearlier-run,PASS\n');
    return { old, kept };
  }

  test('a run removes the old run directories and zips and keeps the recent ones and the history files', async () => {
    const h = harness({ runPass: cleanPass, prechecks: checked('en', 1) });
    const { old, kept } = leaveHistory(h.root);
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    for (const target of old) {
      assert.equal(fs.existsSync(target), false, target);
    }
    for (const target of kept) {
      assert.equal(fs.existsSync(target), true, target);
    }
    assert.deepEqual(readSummary(h.root).warnings, []);
    const csv = runsCsvLines(h.root);
    assert.equal(csv.length, 3);
    assert.deepEqual(csv.slice(0, 2), ['run_id,result', 'earlier-run,PASS']);
    assert.ok((csv[2] as string).startsWith(`${FIRST_RUN_ID},`));
    assert.equal(fs.existsSync(path.join(artifacts(h.root), 'runs', FIRST_RUN_ID)), true);
  });

  test('retention_days 0 keeps everything', async () => {
    const h = harness({ runPass: cleanPass, prechecks: checked('en', 0) });
    const { old, kept } = leaveHistory(h.root);
    assert.equal(await main(['run'], h.deps), 0);
    for (const target of [...old, ...kept]) {
      assert.equal(fs.existsSync(target), true, target);
    }
  });

  test('a run that is not ready deletes nothing', async () => {
    const h = harness({ prechecks: { ok: false, failure: { reason: 'config', message: '[config] env.json: not found' } } });
    const { old, kept } = leaveHistory(h.root);
    assert.equal(await main(['run'], h.deps), 3);
    for (const target of [...old, ...kept]) {
      assert.equal(fs.existsSync(target), true, target);
    }
  });

  test('a usage problem deletes nothing', async () => {
    const h = harness({ prechecks: checked('en', 1) });
    const { old } = leaveHistory(h.root);
    assert.equal(await main(['run', '--bogus'], h.deps), 3);
    assert.equal(h.prechecksCalls, 0);
    for (const target of old) {
      assert.equal(fs.existsSync(target), true, target);
    }
  });

  test('an interrupt before the passes deletes nothing', async () => {
    const h = harness({ runPass: cleanPass, prechecks: checked('en', 1), duringPrechecks: () => h.interrupt() });
    const { old } = leaveHistory(h.root);
    assert.equal(await main(['run'], h.deps), 1);
    assert.equal(h.passCalls.length, 0);
    for (const target of old) {
      assert.equal(fs.existsSync(target), true, target);
    }
  });
});

// A directory that a live process uses as its working directory cannot be deleted on Windows.
describe('retention while a process holds a run directory', { skip: process.platform !== 'win32' }, () => {
  test('the removal that fails is counted in one warning and the verdict does not change', async () => {
    const h = harness({
      runPass: (options) => {
        writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
        return CLEAN_EXIT;
      },
      prechecks: checked('en', 1),
    });
    for (const recent of ['20261020T090000Z', '20261020T080000Z']) {
      fs.mkdirSync(path.join(artifacts(h.root), 'runs', recent), { recursive: true });
    }
    const held = path.join(artifacts(h.root), 'runs', '20261018T100000Z', 'pass-1');
    fs.mkdirSync(held, { recursive: true });
    fs.writeFileSync(path.join(held, 'trace.txt'), 'trace');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: held, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const code = await main(['run'], h.deps);
      assert.equal(code, 0);
      assert.equal(h.lines.at(-1), 'RESULT=PASS');
      assert.deepEqual(readSummary(h.root).warnings, [{ code: 'retention_failed', count: 1 }]);
      const report = fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8');
      assert.ok(report.includes(catalogFor('en').warning({ code: 'retention_failed', count: 1 })));
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
        } else {
          child.once('exit', () => resolve());
        }
      });
    }
  });
});

describe('redaction', () => {
  const { login: LOGIN, password: PASSWORD } = ACCOUNT;
  const SECRET_TEXT = `- textbox "Login": ${LOGIN}\n- textbox "Password": ${PASSWORD}\n`;
  const cleanPass = (options: PassRunOptions): PassRun => {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    return CLEAN_EXIT;
  };
  const layoutOf = (options: PassRunOptions) => runLayout(options.root, { runId: options.runId, pass: options.pass, manual: false });
  const contextFile = (options: PassRunOptions): string => path.join(layoutOf(options).outputDir, 'test', 'error-context.md');
  const htmlFile = (options: PassRunOptions): string => path.join(layoutOf(options).htmlDir, 'data', 'x.md');

  // What a broken scenario leaves: an error context that quotes the typed values, and html report data.
  function leaveSecretFiles(options: PassRunOptions): void {
    for (const file of [contextFile(options), htmlFile(options)]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, SECRET_TEXT);
    }
  }

  test('no console line holds a value, the error context is redacted and the html data and the pass file keep their bytes', async () => {
    let passBytes: Buffer | undefined;
    const h = harness({
      runPass: (options) => {
        options.print(`typing ${LOGIN} then ${PASSWORD}`);
        cleanPass(options);
        leaveSecretFiles(options);
        passBytes = fs.readFileSync(layoutOf(options).passFile);
        return CLEAN_EXIT;
      },
    });
    const code = await main(['run'], h.deps);
    assert.equal(code, 0);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
    for (const line of h.lines) {
      assert.ok(!line.includes(LOGIN) && !line.includes(PASSWORD), line);
    }
    assert.ok(h.lines.includes('typing *** then ***'), h.lines.join('\n'));
    const [call] = h.passCalls as [PassRunOptions];
    const context = fs.readFileSync(contextFile(call), 'utf8');
    assert.equal(context, '- textbox "Login": ***\n- textbox "Password": ***\n');
    assert.equal(fs.readFileSync(htmlFile(call), 'utf8'), SECRET_TEXT);
    assert.ok(fs.readFileSync(layoutOf(call).passFile).equals(passBytes as Buffer));
  });

  test('the error context of pass 1 is already redacted while pass 2 runs', async () => {
    let seenInPass2: string | undefined;
    const h = harness({
      runPass: (options) => {
        if (options.pass === 1) {
          writePass(options, [project('node-1', 'slow'), project('node-2', 'ok')]);
          leaveSecretFiles(options);
        } else {
          const first = runLayout(options.root, { runId: options.runId, pass: 1, manual: false });
          seenInPass2 = fs.readFileSync(path.join(first.outputDir, 'test', 'error-context.md'), 'utf8');
          writePass(options, [project('node-1', 'ok')]);
        }
        return CLEAN_EXIT;
      },
    });
    assert.equal(await main(['run'], h.deps), 1);
    assert.equal(h.passCalls.length, 2);
    assert.equal(seenInPass2, '- textbox "Login": ***\n- textbox "Password": ***\n');
  });

  test('a login shorter than the minimum is not redacted and is named in a warning without its value', async () => {
    const h = harness({
      runPass: (options) => {
        options.print(`typing ab then ${PASSWORD}`);
        return cleanPass(options);
      },
      prechecks: checked('en', 30, { login: 'ab', password: PASSWORD }),
    });
    assert.equal(await main(['run'], h.deps), 0);
    const summary = readSummary(h.root);
    assert.deepEqual(summary.warnings, [{ code: 'secret_too_short', field: 'login' }]);
    for (const warning of summary.warnings) {
      assert.ok(!Object.values(warning).includes('ab'));
    }
    assert.ok(h.lines.includes('typing ab then ***'), h.lines.join('\n'));
    const report = fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8');
    assert.ok(report.includes(catalogFor('en').warning({ code: 'secret_too_short', field: 'login' })));
  });

  test('both values too short give one warning each, login first', async () => {
    const h = harness({ runPass: cleanPass, prechecks: checked('en', 30, { login: 'ab', password: 'xy' }) });
    assert.equal(await main(['run'], h.deps), 0);
    assert.deepEqual(readSummary(h.root).warnings, [
      { code: 'secret_too_short', field: 'login' },
      { code: 'secret_too_short', field: 'password' },
    ]);
  });

  test('a login that is a word of the pass file keeps the pass file and the verdict intact', async () => {
    let passBytes: Buffer | undefined;
    const h = harness({
      runPass: (options) => {
        writePass(options, options.pass === 1 ? [project('node-1', 'slow'), project('node-2', 'ok')] : [project('node-1', 'ok')]);
        passBytes ??= fs.readFileSync(layoutOf(options).passFile);
        return CLEAN_EXIT;
      },
      prechecks: checked('en', 30, { login: 'node', password: PASSWORD }),
    });
    assert.equal(await main(['run'], h.deps), 1);
    assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    const first = runLayout(h.root, { runId: FIRST_RUN_ID, pass: 1, manual: false });
    assert.ok(fs.readFileSync(first.passFile).equals(passBytes as Buffer));
    assert.ok(fs.readFileSync(first.passFile, 'utf8').includes('"node"'));
    assert.equal(readSummary(h.root).nodes[0]?.recheck, 'ok');
  });

  // The machine lines are what a scheduler reads: a login or password that is a substring of one of
  // their words must not rewrite them, whatever else is redacted.
  for (const login of ['slow', 'low', 'FAIL', 'REASON', 'RESULT', 'AIL']) {
    test(`a login "${login}" that sits inside the machine lines leaves RESULT= and REASON= as they are`, async () => {
      const h = harness({
        runPass: (options) => {
          writePass(options, options.pass === 1 ? [project('node-1', 'slow'), project('node-2', 'ok')] : [project('node-1', 'ok')]);
          return CLEAN_EXIT;
        },
        prechecks: checked('en', 30, { login, password: PASSWORD }),
      });
      assert.equal(await main(['run'], h.deps), 1);
      assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
    });
  }

  test('a login that sits inside a not-ready reason leaves REASON= as it is and still hides the login elsewhere', async () => {
    const message = '[config] baselines.json: the config of lock is unknown';
    const h = harness({
      prechecks: { ok: false, failure: { reason: 'config', message } },
      accountKnown: true,
      knownAccount: { login: 'config', password: PASSWORD },
    });
    assert.equal(await main(['run'], h.deps), 3);
    assert.deepEqual(h.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
    assert.ok(h.lines.some((line) => line.startsWith('[***]')), h.lines.join('\n'));
  });

  test('a configuration failure after env.json loaded prints its message with the login replaced', async () => {
    const message = `[config] baselines.json: the metric of ${LOGIN} is unknown`;
    const h = harness({ prechecks: { ok: false, failure: { reason: 'config', message } }, accountKnown: true });
    assert.equal(await main(['run'], h.deps), 3);
    assert.ok(h.lines.includes('[config] baselines.json: the metric of *** is unknown'), h.lines.join('\n'));
    for (const line of h.lines) {
      assert.ok(!line.includes(LOGIN), line);
    }
  });

  test('a failure before env.json loaded attaches no redactor', async () => {
    const message = '[config] env.json: file not found';
    const h = harness({ prechecks: { ok: false, failure: { reason: 'config', message } } });
    assert.equal(await main(['run'], h.deps), 3);
    assert.equal(h.redactorAttached, 0);
    assert.equal(h.redactorRemoved, 0);
    assert.ok(h.lines.includes(message));
  });

  test('the redactor is attached once and removed once after the last line', async () => {
    const h = harness({ runPass: cleanPass });
    assert.equal(await main(['run'], h.deps), 0);
    assert.equal(h.redactorAttached, 1);
    assert.equal(h.redactorRemoved, 1);
    assert.equal(h.transform, undefined);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
  });

  test('the redactor is removed after an internal error as well', async () => {
    const h = harness({
      runPass: () => {
        throw new Error('marker-of-the-failure');
      },
    });
    assert.equal(await main(['run'], h.deps), 1);
    assert.equal(h.redactorAttached, 1);
    assert.equal(h.redactorRemoved, 1);
  });
});

describe('the zip', () => {
  const SCREENSHOT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  const layoutOf = (options: PassRunOptions) => runLayout(options.root, { runId: options.runId, pass: options.pass, manual: false });
  const runDirOf = (root: string): string => path.join(artifacts(root), 'runs', FIRST_RUN_ID);
  const reportZip = (root: string): string => path.join(artifacts(root), `report_${FIRST_RUN_ID}.zip`);
  const tempZip = (root: string): string => path.join(artifacts(root), `.report_${FIRST_RUN_ID}.${RUN_PID}.tmp.zip`);

  // What one pass leaves besides its pass file: an error context, a masked screenshot, the html report and the stderr log.
  function leaveFiles(options: PassRunOptions, extra?: (resultsDir: string, runDir: string) => void): void {
    const layout = layoutOf(options);
    const put = (file: string, content: string | Buffer): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    put(path.join(layout.outputDir, 't', 'error-context.md'), '- page snapshot\n');
    put(path.join(layout.outputDir, 't', 'attachments', 'screenshot-1.png'), SCREENSHOT);
    put(path.join(layout.htmlDir, 'index.html'), '<html></html>');
    put(layout.stderrLog, 'a warning\n');
    extra?.(layout.outputDir, path.dirname(layout.passFile));
  }

  function leaveClean(options: PassRunOptions, extra?: (resultsDir: string, runDir: string) => void): PassRun {
    writePass(options, [project('node-1', 'ok'), project('node-2', 'ok')]);
    leaveFiles(options, extra);
    return CLEAN_EXIT;
  }

  const slowThenOk = (options: PassRunOptions): PassRun => {
    writePass(options, options.pass === 1 ? [project('node-1', 'slow'), project('node-2', 'ok')] : [project('node-1', 'ok')]);
    return CLEAN_EXIT;
  };

  test('a clean run on Windows packs the report, the summary, the pass file and the test results with the system tar', async () => {
    const h = harness({ runPass: (options) => leaveClean(options) });
    assert.equal(await main(['run'], h.deps), 0);
    assert.equal(h.zipCalls.length, 1);
    const [call] = h.zipCalls as [{ file: string; args: string[] }];
    assert.ok(call.file.endsWith('System32\\tar.exe'), call.file);
    assert.deepEqual(call.args, [
      '-a',
      '-c',
      '-f',
      tempZip(h.root),
      '-C',
      runDirOf(h.root),
      '--',
      'report.txt',
      'summary.json',
      'pass-1.json',
      'pass-1/test-results/t/attachments/screenshot-1.png',
      'pass-1/test-results/t/error-context.md',
    ]);
    assert.ok(fs.readFileSync(reportZip(h.root)).subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
    assert.equal(fs.existsSync(tempZip(h.root)), false);
    assert.deepEqual(readSummary(h.root).warnings, []);
    assert.equal(h.lines.at(-1), 'RESULT=PASS');
  });

  test('the zip holds the second pass files as well, and never the html report or a log', async () => {
    const h = harness({
      runPass: (options) => {
        slowThenOk(options);
        if (options.pass === 1) {
          leaveFiles(options);
        } else {
          const layout = layoutOf(options);
          fs.mkdirSync(path.join(layout.outputDir, 'u'), { recursive: true });
          fs.writeFileSync(path.join(layout.outputDir, 'u', 'error-context.md'), 'second\n');
          fs.mkdirSync(layout.htmlDir, { recursive: true });
          fs.writeFileSync(path.join(layout.htmlDir, 'index.html'), '<html></html>');
        }
        return CLEAN_EXIT;
      },
    });
    assert.equal(await main(['run'], h.deps), 1);
    const names = (h.zipCalls[0] as { args: string[] }).args.slice(7);
    assert.ok(names.includes('pass-2.json'));
    assert.ok(names.includes('pass-2/test-results/u/error-context.md'));
    for (const name of names) {
      assert.ok(!name.includes('html/'), name);
      assert.ok(!name.endsWith('.log'), name);
    }
  });

  for (const platform of ['win32', 'linux'] as const) {
    test(`the per-run copies of the summary and the report equal the root files on ${platform}`, async () => {
      const h = harness({ runPass: (options) => leaveClean(options), platform });
      await main(['run'], h.deps);
      for (const name of ['summary.json', 'report.txt']) {
        const copy = fs.readFileSync(path.join(runDirOf(h.root), name));
        assert.ok(copy.length > 0, name);
        assert.ok(copy.equals(fs.readFileSync(path.join(artifacts(h.root), name))), name);
      }
    });
  }

  test('off Windows the runner is never called, the run says so and keeps the exit code of the Windows run', async () => {
    const onWindows = harness({ runPass: slowThenOk });
    const windowsCode = await main(['run'], onWindows.deps);
    const elsewhere = harness({ runPass: slowThenOk, platform: 'linux' });
    const code = await main(['run'], elsewhere.deps);
    assert.equal(code, windowsCode);
    assert.equal(code, 1);
    assert.equal(elsewhere.zipCalls.length, 0);
    assert.deepEqual(elsewhere.lines.slice(-2), onWindows.lines.slice(-2));
    const warnings = readSummary(elsewhere.root).warnings;
    assert.deepEqual(warnings.at(-1), { code: 'zip_skipped' });
    assert.equal(fs.existsSync(reportZip(elsewhere.root)), false);
    const report = fs.readFileSync(path.join(artifacts(elsewhere.root), 'report.txt'), 'utf8');
    assert.ok(report.includes(catalogFor('en').warning({ code: 'zip_skipped' })));
    assert.ok(fs.readFileSync(path.join(runDirOf(elsewhere.root), 'summary.json'), 'utf8').includes('zip_skipped'));
  });

  for (const [name, mode] of [
    ['a tar that exits with status 1', 'fail'],
    ['a tar that writes a plain tar archive', 'plain'],
  ] as const) {
    test(`${name} adds zip_failed in all four report files and changes nothing else`, async () => {
      const working = harness({ runPass: slowThenOk });
      const workingCode = await main(['run'], working.deps);
      const h = harness({ runPass: slowThenOk, zip: mode });
      const code = await main(['run'], h.deps);
      assert.equal(code, workingCode);
      assert.deepEqual(h.lines.slice(-2), working.lines.slice(-2));
      assert.deepEqual(h.lines.slice(-2), ['REASON=slow', 'RESULT=FAIL']);
      const summary = readSummary(h.root);
      assert.deepEqual(summary.warnings.at(-1), { code: 'zip_failed' });
      const copy = JSON.parse(fs.readFileSync(path.join(runDirOf(h.root), 'summary.json'), 'utf8')) as Summary;
      assert.deepEqual(copy, summary);
      const sentence = catalogFor('en').warning({ code: 'zip_failed' });
      assert.ok(fs.readFileSync(path.join(artifacts(h.root), 'report.txt'), 'utf8').includes(sentence));
      assert.ok(fs.readFileSync(path.join(runDirOf(h.root), 'report.txt'), 'utf8').includes(sentence));
      assert.equal(runsCsvLines(h.root).length, 2);
      assert.equal(fs.existsSync(reportZip(h.root)), false);
      assert.equal(fs.existsSync(tempZip(h.root)), false);
    });
  }

  test('a binary file that holds the login stays on disk, stays out of the zip and is counted', async () => {
    const h = harness({
      runPass: (options) =>
        leaveClean(options, (resultsDir) => {
          fs.writeFileSync(path.join(resultsDir, 't', 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(ACCOUNT.login), Buffer.from([0])]));
        }),
    });
    assert.equal(await main(['run'], h.deps), 0);
    const summary = readSummary(h.root);
    assert.ok(summary.warnings.some((warning) => warning.code === 'binary_left_out' && warning.count === 1), JSON.stringify(summary.warnings));
    const names = (h.zipCalls[0] as { args: string[] }).args.slice(7);
    assert.ok(!names.some((name) => name.includes('blob.bin')), names.join('\n'));
    assert.ok(names.includes('pass-1/test-results/t/attachments/screenshot-1.png'));
    assert.equal(fs.existsSync(path.join(runDirOf(h.root), 'pass-1', 'test-results', 't', 'blob.bin')), true);
    const copy = JSON.parse(fs.readFileSync(path.join(runDirOf(h.root), 'summary.json'), 'utf8')) as Summary;
    assert.deepEqual(copy.warnings, summary.warnings);
    const sentence = catalogFor('en').warning({ code: 'binary_left_out', count: 1 });
    assert.ok(fs.readFileSync(path.join(runDirOf(h.root), 'report.txt'), 'utf8').includes(sentence));
  });

  test('a UTF-16 text file that holds the password stays out of the zip, stays on disk and is counted', async () => {
    const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`password=${ACCOUNT.password}\r\n`, 'utf16le')]);
    const h = harness({
      runPass: (options) =>
        leaveClean(options, (resultsDir) => {
          fs.writeFileSync(path.join(resultsDir, 't', 'notes.txt'), text);
        }),
    });
    assert.equal(await main(['run'], h.deps), 0);
    assert.ok(readSummary(h.root).warnings.some((warning) => warning.code === 'binary_left_out' && warning.count === 1));
    const names = (h.zipCalls[0] as { args: string[] }).args.slice(7);
    assert.ok(!names.some((name) => name.includes('notes.txt')), names.join('\n'));
    assert.ok(fs.readFileSync(path.join(runDirOf(h.root), 'pass-1', 'test-results', 't', 'notes.txt')).equals(text));
  });

  test('without a redactor nothing under test-results is verified, so the zip takes the fixed files only', async () => {
    const h = harness({ runPass: (options) => leaveClean(options), noRedactor: true });
    assert.equal(await main(['run'], h.deps), 0);
    assert.equal(h.zipCalls.length, 1);
    const names = (h.zipCalls[0] as { args: string[] }).args.slice(7);
    assert.ok(names.includes('report.txt') && names.includes('summary.json'), names.join('\n'));
    assert.ok(!names.some((name) => name.startsWith('pass-1/test-results/')), names.join('\n'));
    // The same run with a redactor does pack the screenshot, so the check above can fail.
    const withRedactor = harness({ runPass: (options) => leaveClean(options) });
    assert.equal(await main(['run'], withRedactor.deps), 0);
    const packed = (withRedactor.zipCalls[0] as { args: string[] }).args.slice(7);
    assert.ok(packed.some((name) => name.startsWith('pass-1/test-results/')), packed.join('\n'));
  });

  test('off Windows no file is reported as left out of a zip that is never built', async () => {
    const h = harness({
      platform: 'linux',
      runPass: (options) =>
        leaveClean(options, (resultsDir) => {
          fs.writeFileSync(path.join(resultsDir, 't', 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(ACCOUNT.login), Buffer.from([0])]));
        }),
    });
    assert.equal(await main(['run'], h.deps), 0);
    const codes = readSummary(h.root).warnings.map((warning) => warning.code);
    assert.ok(codes.includes('zip_skipped'), codes.join());
    assert.ok(!codes.includes('binary_left_out'), codes.join());
    assert.equal(h.zipCalls.length, 0);
  });

  test('a stderr log in a single-byte code page that holds the login is not counted and stays on disk', async () => {
    const stderr = Buffer.concat([Buffer.from([0xc0, 0xe9]), Buffer.from(ACCOUNT.login), Buffer.from([0xff])]);
    const h = harness({
      runPass: (options) => {
        const code = leaveClean(options);
        fs.writeFileSync(layoutOf(options).stderrLog, stderr);
        return code;
      },
    });
    assert.equal(await main(['run'], h.deps), 0);
    assert.ok(!readSummary(h.root).warnings.some((warning) => warning.code === 'binary_left_out'));
    assert.ok(fs.readFileSync(path.join(runDirOf(h.root), 'pass-1.stderr.log')).equals(stderr));
  });

  test('a run that is not ready builds no zip, adds no zip warning and still writes its report copies', async () => {
    const h = harness({ prechecks: { ok: false, failure: { reason: 'config', message: '[config] env.json: file not found' } } });
    assert.equal(await main(['run'], h.deps), 3);
    assert.equal(h.zipCalls.length, 0);
    assert.deepEqual(readSummary(h.root).warnings, []);
    assert.equal(fs.existsSync(reportZip(h.root)), false);
    for (const name of ['summary.json', 'report.txt']) {
      assert.ok(fs.readFileSync(path.join(runDirOf(h.root), name)).equals(fs.readFileSync(path.join(artifacts(h.root), name))), name);
    }
  });

  test('a usage problem builds no zip and adds no zip warning', async () => {
    const h = harness({});
    assert.equal(await main(['run', '--bogus'], h.deps), 3);
    assert.equal(h.zipCalls.length, 0);
    assert.deepEqual(readSummary(h.root).warnings, []);
    assert.equal(fs.existsSync(path.join(runDirOf(h.root), 'summary.json')), true);
  });

  test('a run that fails with an internal error builds no zip', async () => {
    const h = harness({
      runPass: () => {
        throw new Error('marker-of-the-failure');
      },
    });
    assert.equal(await main(['run'], h.deps), 1);
    assert.equal(h.zipCalls.length, 0);
  });
});
