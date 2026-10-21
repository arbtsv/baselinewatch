// `blw run`: finds the project, checks it, runs Playwright and turns the pass files into the run
// files, the console lines and the exit code. Every outside effect (clock, sleep, output, the checks
// and the Playwright child) comes in through RunDeps, so the whole command can be driven in a test.
// The verdict comes from the pass files alone; the exit status of Playwright is never read. This
// module loads no Playwright module and no module that does.
import fs from 'node:fs';
import path from 'node:path';
import { parseRunArgs, USAGE_LINES, type RunArgs } from './args.ts';
import { appendCsv, RUNS_CSV_HEADER, runsCsvLine } from './csv.ts';
import type { Locale } from './env.ts';
import { catalogFor } from './i18n/index.ts';
import { runIdFrom, runLayout, type RunLayout } from './layout.ts';
import { decide, exitLines, notReady, slowProjects, toSummary, type Decision } from './outcome.ts';
import { readPassFile, writeFileAtomic } from './pass-file.ts';
import type { runPrechecks } from './precheck.ts';
import type { PassRun, PassRunOptions } from './process.ts';
import type { NotReadyReason, Summary } from './protocol.ts';
import { consoleSummary, internalErrorLines, notReadyLines, renderReport } from './report.ts';

export type RunDeps = {
  /** Absolute path of the running cli module. */
  cliFile: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
  prechecks: typeof runPrechecks;
  runPass: (options: PassRunOptions) => Promise<PassRun>;
  /** Registers a handler for the interrupt signals and returns the function that removes it. */
  onInterrupt: (handler: () => void) => () => void;
};

const PACKAGE_NAME = 'baselinewatch';
const MODULES_DIR = 'node_modules';
const MAX_RUN_ID_ATTEMPTS = 30;

// The package directory of the running cli: <package>/dist/cli.js.
function packageDirOf(cliFile: string): string {
  return path.dirname(path.dirname(cliFile));
}

/**
 * The project root: the directory whose node_modules holds the installed package that cliFile belongs
 * to, <root>/node_modules/baselinewatch/dist/cli.js. Undefined when the cli runs from anywhere else.
 */
export function projectRootFrom(cliFile: string): string | undefined {
  const packageDir = packageDirOf(cliFile);
  const modulesDir = path.dirname(packageDir);
  if (path.basename(packageDir) !== PACKAGE_NAME || path.basename(modulesDir) !== MODULES_DIR) {
    return undefined;
  }
  return path.dirname(modulesDir);
}

/** The version in the package.json of the package that cliFile belongs to. */
export function readCoreVersion(cliFile: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDirOf(cliFile), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Milliseconds from a moment to the start of the next whole second.
function untilNextSecond(moment: Date): number {
  return 1000 - (moment.getTime() % 1000);
}

// Creates the run directory without recursion, so an existing one means the id is taken; then the
// run waits for the next second. The run id is the start time, so a second start gives a second id.
async function claimRunDirectory(root: string, deps: RunDeps): Promise<{ runId: string; startedAt: Date }> {
  const runsDir = path.join(root, 'artifacts', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS; attempt += 1) {
    const startedAt = deps.now();
    const runId = runIdFrom(startedAt);
    try {
      fs.mkdirSync(path.join(runsDir, runId));
      return { runId, startedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    await deps.sleep(untilNextSecond(startedAt));
  }
  throw new Error('no free run id was found');
}

type Finish = { decision: Decision; message?: string };

/** What a run knows about itself once it has a run id. */
type RunInfo = {
  layout: RunLayout;
  runId: string;
  startedAt: Date;
  coreVersion: string;
  locale: Locale;
  /** The summary once part of it is on disk (the runs.csv row or summary.json); every later output agrees with it. */
  summary?: Summary;
};

function summaryOf(run: RunInfo, decision: Decision, deps: RunDeps): Summary {
  return toSummary(decision, {
    runId: run.runId,
    coreVersion: run.coreVersion,
    locale: run.locale,
    startedAt: run.startedAt,
    finishedAt: deps.now(),
  });
}

// Appends a failure of the history to cli-error.log; the log write never throws.
function logFailure(logFile: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${detail}\n`, 'utf8');
  } catch {
    // The warning in the summary still tells the operator that the history is incomplete.
  }
}

// The runs.csv row first, then summary.json and report.txt through a temp file. The CSV history is
// best effort: a failed append becomes the history_not_written warning instead of a different verdict.
// The row comes first so that this warning is in the record files on their only write.
function recordRun(run: RunInfo, summary: Summary): Summary {
  let recorded = summary;
  try {
    appendCsv(run.layout.runsCsv, RUNS_CSV_HEADER, [
      runsCsvLine({
        run_id: summary.run_id,
        ts_start: summary.started_at,
        ts_end: summary.finished_at,
        result: summary.result,
        exit_code: summary.exit_code,
        reason: summary.reason,
        core_version: summary.core_version,
      }),
    ]);
    run.summary = summary;
  } catch (error) {
    logFailure(run.layout.cliErrorLog, error);
    recorded = { ...summary, warnings: [...summary.warnings, { code: 'history_not_written' }] };
  }
  writeFileAtomic(run.layout.summaryJson, `${JSON.stringify(recorded, null, 2)}\n`);
  run.summary = recorded;
  writeFileAtomic(run.layout.reportTxt, renderReport(recorded, catalogFor(run.locale)));
  return recorded;
}

/**
 * The end of every run that has a run id: the run files, then the console lines. RESULT= comes last.
 */
function finishRun(run: RunInfo, end: Finish, deps: RunDeps): 0 | 1 | 3 {
  const { decision } = end;
  const catalog = catalogFor(run.locale);
  const summary = recordRun(run, summaryOf(run, decision, deps));
  const lines =
    decision.status === 'not_ready' && decision.reason !== null
      ? notReadyLines(decision.reason as NotReadyReason, end.message, catalog)
      : consoleSummary(summary, catalog, run.layout.reportTxt);
  for (const line of [...lines, ...exitLines(summary)]) {
    deps.print(line);
  }
  return summary.exit_code;
}

// The lines of a run that never got as far as a run id: no file is written.
function stopWithoutRun(reason: NotReadyReason, message: string, deps: RunDeps): 3 {
  const catalog = catalogFor('en');
  const decision = notReady(reason);
  for (const line of [...notReadyLines(reason, message, catalog), ...exitLines({ result: decision.result, reason })]) {
    deps.print(line);
  }
  return 3;
}

/**
 * An unexpected exception: the stack goes to cli-error.log, the run is recorded as a report that was
 * not built when that is still possible, and the console shows one generic line without the stack.
 */
function failInternally(root: string, error: unknown, run: RunInfo | undefined, deps: RunDeps): 1 {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const logFile = run === undefined ? path.join(root, 'artifacts', 'cli-error.log') : run.layout.cliErrorLog;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${detail}\n`, 'utf8');
  } catch {
    // The console line below still tells the operator that something went wrong.
  }
  const decision = decide({ pass1: { state: 'missing' }, requested: [] });
  let summary: Pick<Summary, 'result' | 'reason'> = { result: decision.result, reason: decision.reason };
  if (run !== undefined && run.summary === undefined) {
    const full = summaryOf(run, decision, deps);
    summary = full;
    try {
      recordRun(run, full);
    } catch {
      // Best effort: the files that could not be written stay missing.
    }
  }
  const catalog = catalogFor(run?.locale ?? 'en');
  for (const line of [...internalErrorLines(logFile, catalog), ...exitLines(summary)]) {
    deps.print(line);
  }
  return 1;
}

// The two passes: pass 1 over every project, pass 2 over the slow ones, unless an interrupt came.
async function runPasses(
  root: string,
  run: RunInfo,
  projects: readonly string[],
  deps: RunDeps,
): Promise<Decision> {
  const { runId } = run;
  const controller = new AbortController();
  let interrupted = false;
  const unregister = deps.onInterrupt(() => {
    interrupted = true;
    controller.abort();
  });
  try {
    const first = await deps.runPass({
      root,
      runId,
      pass: 1,
      projects: [],
      stderrLog: run.layout.stderrLog,
      print: deps.print,
      signal: controller.signal,
    });
    interrupted = interrupted || first.interrupted;
    const pass1 = readPassFile(run.layout.passFile, { runId, pass: 1, projects, requireAll: true });
    const requested = pass1.state === 'ok' && !interrupted ? slowProjects(pass1.file, projects) : [];
    if (requested.length === 0) {
      return decide({ pass1, requested });
    }
    const layout2 = runLayout(root, { runId, pass: 2, manual: false });
    await deps.runPass({
      root,
      runId,
      pass: 2,
      projects: requested,
      stderrLog: layout2.stderrLog,
      print: deps.print,
      signal: controller.signal,
    });
    const pass2 = readPassFile(layout2.passFile, { runId, pass: 2, projects: requested, requireAll: false });
    return decide({ pass1, pass2, requested });
  } finally {
    unregister();
  }
}

// Everything after the project root is known; the caller turns an exception into the internal error.
async function execute(root: string, args: RunArgs, deps: RunDeps, state: { run?: RunInfo }): Promise<0 | 1 | 3> {
  const { runId, startedAt } = await claimRunDirectory(root, deps);
  const layout = runLayout(root, { runId, pass: 1, manual: false });
  const run: RunInfo = { layout, runId, startedAt, coreVersion: readCoreVersion(deps.cliFile), locale: 'en' };
  state.run = run;
  // The last run's files are removed first, so a stale pair is never read as this run's.
  fs.rmSync(layout.reportTxt, { force: true });
  fs.rmSync(layout.summaryJson, { force: true });
  if (args.kind === 'usage') {
    return finishRun(run, { decision: notReady('usage'), message: args.problem }, deps);
  }
  const checked = await deps.prechecks(root, deps.cliFile);
  if (!checked.ok) {
    const { failure } = checked;
    run.locale = failure.locale ?? 'en';
    return finishRun(run, { decision: notReady(failure.reason), message: failure.message }, deps);
  }
  run.locale = checked.value.env.locale;
  return finishRun(run, { decision: await runPasses(root, run, checked.value.projects, deps) }, deps);
}

/** Runs the command line `blw <argv>` and returns the exit code. */
export async function main(argv: readonly string[], deps: RunDeps): Promise<0 | 1 | 3> {
  const args = parseRunArgs(argv);
  if (args.kind === 'help') {
    for (const line of USAGE_LINES) {
      deps.print(line);
    }
    return 0;
  }
  if (args.kind === 'version') {
    deps.print(`${PACKAGE_NAME} ${readCoreVersion(deps.cliFile)}`);
    return 0;
  }
  const root = projectRootFrom(deps.cliFile);
  if (root === undefined) {
    const problem = args.kind === 'usage' ? args.problem : undefined;
    return stopWithoutRun(
      problem === undefined ? 'config' : 'usage',
      problem ?? `baselinewatch must run from <project>/node_modules/${PACKAGE_NAME}/dist; this copy is in ${packageDirOf(deps.cliFile)}`,
      deps,
    );
  }
  const state: { run?: RunInfo } = {};
  try {
    return await execute(root, args, deps, state);
  } catch (error) {
    return failInternally(root, error, state.run, deps);
  }
}
