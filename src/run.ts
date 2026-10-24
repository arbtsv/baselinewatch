// `blw run`: finds the project, checks it, runs Playwright and turns the pass files into the run
// files, the console lines and the exit code. `blw init` is routed from here too, ahead of everything
// that belongs to a run. Every outside effect (clock, sleep, output, the checks
// and the Playwright child) comes in through RunDeps, so the whole command can be driven in a test.
// The verdict comes from the pass files alone; the exit status of Playwright is never read. The run
// lock (artifacts/.lock) is taken before the first write under artifacts/, so a second run that finds
// a live holder stops without writing anything; --help and --version take no lock. The account login
// and password are hidden from the console from the moment env.json is read, and from the text files
// of the run after every pass. On Windows a run that measured ends with report_<run id>.zip, built
// from the redacted run directory; a zip problem is a warning and never changes the exit code. This
// module loads no Playwright module and no module that does.
import fs from 'node:fs';
import path from 'node:path';
import { parseRunArgs, USAGE_LINES, type RunArgs } from './args.ts';
import { buildZip, isZipCandidate, tarPath, zipFileList, type TarRunner } from './archive.ts';
import { appendCsv, RUNS_CSV_HEADER, runsCsvLine } from './csv.ts';
import type { Account, Locale } from './env.ts';
import { catalogFor } from './i18n/index.ts';
import { runInit } from './init.ts';
import { historyErrorLogFor, runIdFrom, runLayout, tempZipName, type RunLayout } from './layout.ts';
import { acquireLock, LOCK_FILE, type LockContent, type LockResult } from './lock.ts';
import { decide, exitLines, notReady, slowProjects, toSummary, type Decision } from './outcome.ts';
import { readPassFile, writeFileAtomic } from './pass-file.ts';
import type { runPrechecks } from './precheck.ts';
import { applyRetention } from './retention.ts';
import type { PassRun, PassRunOptions } from './process.ts';
import { isMachineLine, type NotReadyReason, type RunWarning, type Summary } from './protocol.ts';
import { createRedactor, redactRunDirectory, type Redactor } from './redact.ts';
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
  /**
   * Registers a handler for the exit of the process and returns the function that removes it. The run
   * lock is released through it, so a process that ends without returning from main frees the lock.
   * On Windows only Ctrl+C, Ctrl+Break and SIGTERM reach the interrupt handlers; a scheduler stop or
   * taskkill /F ends the process at once and leaves a dead pid, which the next run takes over.
   */
  onExit: (handler: () => void) => () => void;
  /** The process id written into the run lock. */
  pid: number;
  /** True when the pid belongs to a live process; the run lock uses it to tell a holder from a leftover. */
  isAlive: (pid: number) => boolean;
  /**
   * Installs a line transform in front of the console sink and returns the function that removes it.
   * Every line printed from then on, the lines of this command and the relayed lines of the Playwright
   * child alike, goes through the transform first.
   */
  attachRedactor: (redact: (line: string) => string) => () => void;
  /** The platform the run is on; the zip is built on win32 only. */
  platform: NodeJS.Platform;
  /** Runs the system tar with the given executable and arguments; a test answers it without a real tar. */
  zip: TarRunner;
  /** The directory a relative init directory is resolved against; the caller's directory, also under npx. */
  cwd: () => string;
};

/** What main keeps for its cleanup: the run once it has an id, and the function that removes the redactor. */
type RunState = { run?: RunInfo; detach?: () => void };

type HeldLock = Extract<LockResult, { held: true }>;

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
  /** The warnings of the run itself, in the order the run met them; they follow those of the decision. */
  warnings: RunWarning[];
  /** Hides the account values; set once env.json is loaded, so a run that never got that far has none. */
  redactor?: Redactor;
  /** True once the pre-launch checks passed: only such a run is scanned for leftovers and packed into a zip. */
  measured: boolean;
  /** The summary once part of it is on disk (the runs.csv row or summary.json); every later output agrees with it. */
  summary?: Summary;
};

function summaryOf(run: RunInfo, decision: Decision, deps: RunDeps): Summary {
  return toSummary(withRunWarnings(decision, run.warnings), {
    runId: run.runId,
    coreVersion: run.coreVersion,
    locale: run.locale,
    startedAt: run.startedAt,
    finishedAt: deps.now(),
  });
}

// Appends the detail of a failure to a log file; the write never throws.
function logFailure(logFile: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${detail}\n`, 'utf8');
  } catch {
    // The console line or the warning in the summary still tells the operator that something went wrong.
  }
}

// summary.json and report.txt, each through a temp file: the root files describe the last run, and the
// copies in the run directory go into the run's zip. The copies are written on every OS. The summary
// is on record (run.summary) once its own file is written, before the report text.
function writeReportFiles(run: RunInfo, summary: Summary): void {
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const reportText = renderReport(summary, catalogFor(run.locale));
  writeFileAtomic(run.layout.summaryJson, summaryText);
  run.summary = summary;
  writeFileAtomic(run.layout.reportTxt, reportText);
  writeFileAtomic(path.join(run.layout.runDir, 'summary.json'), summaryText);
  writeFileAtomic(path.join(run.layout.runDir, 'report.txt'), reportText);
}

// The runs.csv row first, then the report files. The CSV history is best effort: a failed append
// becomes the history_not_written warning instead of a different verdict. The row comes first so that
// this warning is in the record files on their only write. A later rewrite of the report files goes
// through writeReportFiles alone, so a run never gets a second row.
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
  writeReportFiles(run, recorded);
  return recorded;
}

/** What the last look at the run directory found: what the zip must leave out, and what it may take. */
type Sealed = {
  /** Files that still hold a value or could not be read, and directories that could not be listed. */
  tainted: ReadonlySet<string>;
  /** The files that were read and are free of a value; empty when there was no redactor to check with. */
  verified: ReadonlySet<string>;
};

// A directory that could not be listed counts as one file left out when the zip would have held
// something from it.
const ZIP_DIRECTORY = /^pass-\d+(?:\/test-results(?:\/|$)|$)/;

// The last look at the run directory before anything is packed. It changes the run: the text files are
// redacted once more, and the warnings of the run are added to run.warnings, which the summary then
// carries, so it has to run before the summary is built. The files that still hold a value (binary, in
// another encoding, or too stubborn to rewrite) and the directories that could not be listed are
// returned, with the files that were verified, so the zip leaves out everything else. The warning counts
// only what the zip would have held, never by path or name, and only where a zip is built. Off Windows
// the zip is skipped, and that is said now, so the copies of the report already carry it. A run that did
// not measure has nothing to scan and builds no zip.
function sealRunDirectory(run: RunInfo, deps: RunDeps): Sealed {
  if (!run.measured) {
    return { tainted: new Set(), verified: new Set() };
  }
  const walk = run.redactor === undefined ? undefined : redactRunDirectory(run.layout.runDir, run.redactor);
  const tainted = [...(walk?.tainted ?? []), ...(walk?.unlisted ?? [])];
  if (deps.platform === 'win32') {
    const leftOut = (walk?.tainted ?? []).filter(isZipCandidate).length + (walk?.unlisted ?? []).filter((dir) => ZIP_DIRECTORY.test(dir)).length;
    if (leftOut > 0) {
      run.warnings.push({ code: 'binary_left_out', count: leftOut });
    }
  } else {
    run.warnings.push({ code: 'zip_skipped' });
  }
  // Without a redactor nothing was read, so nothing is verified: the zip then takes the fixed files only.
  return { tainted: new Set(tainted), verified: new Set(walk?.clean ?? []) };
}

// Builds report_<run id>.zip from the redacted run directory. A zip that fails adds a warning and
// rewrites the report files and their copies, never the runs.csv row; the exit code is the summary's own.
async function packRun(run: RunInfo, summary: Summary, sealed: Sealed, deps: RunDeps): Promise<Summary> {
  if (!run.measured || deps.platform !== 'win32') {
    return summary;
  }
  const outcome = await buildZip({
    runDir: run.layout.runDir,
    tempZip: path.join(run.layout.artifactsDir, tempZipName(run.runId, deps.pid)),
    finalZip: run.layout.reportZip,
    files: zipFileList(run.layout.runDir, sealed.tainted, sealed.verified),
    run: deps.zip,
    tar: tarPath(),
  });
  if (outcome === 'built') {
    return summary;
  }
  const failed: Summary = { ...summary, warnings: [...summary.warnings, { code: 'zip_failed' }] };
  writeReportFiles(run, failed);
  return failed;
}

/**
 * The end of every run that has a run id. The order: the final redaction and the scan for files that
 * must stay out of the zip, the platform check, the verdict into the runs.csv row and the report files
 * with their copies, the zip, and last the console lines with RESULT= at the end.
 */
async function finishRun(run: RunInfo, end: Finish, deps: RunDeps): Promise<0 | 1 | 3> {
  const { decision } = end;
  const catalog = catalogFor(run.locale);
  const sealed = sealRunDirectory(run, deps);
  const summary = await packRun(run, recordRun(run, summaryOf(run, decision, deps)), sealed, deps);
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

// The line of a run that found the lock held: the lock file, who holds it when that is known, and the
// fact that this run left every file as it was.
function lockedMessage(lockFile: string, holder: Partial<LockContent>): string {
  const who =
    holder.pid === undefined
      ? 'by a run that cannot be identified'
      : `by process ${holder.pid}${holder.started_at === undefined ? '' : ` since ${holder.started_at}`}`;
  return `Another run holds the lock ${lockFile} ${who}. This run started nothing and wrote nothing.`;
}

// Prints the lines one by one; a sink that throws costs that line, never the exit code.
function printAll(lines: readonly string[], deps: RunDeps): void {
  for (const line of lines) {
    try {
      deps.print(line);
    } catch {
      // The exit code and the files carry the result when the console cannot.
    }
  }
}

/**
 * An unexpected exception: the stack goes to cli-error.log and the console shows one generic line
 * without the stack. From the first part of the summary on disk, every output follows that summary;
 * before that, an exception means the report was not built, and the run is recorded as such when that
 * is still possible.
 */
function failInternally(root: string, error: unknown, run: RunInfo | undefined, deps: RunDeps): 0 | 1 | 3 {
  const logFile = run === undefined ? path.join(root, 'artifacts', 'cli-error.log') : run.layout.cliErrorLog;
  logFailure(logFile, error);
  if (run?.redactor !== undefined) {
    // The stack may quote a value; the log stays in the run directory, redacted like the other logs.
    redactRunDirectory(run.layout.runDir, run.redactor);
  }
  const catalog = catalogFor(run?.locale ?? 'en');
  if (run?.summary !== undefined) {
    printAll([...internalErrorLines(logFile, catalog), ...exitLines(run.summary)], deps);
    return run.summary.exit_code;
  }
  const decision = decide({ pass1: { state: 'missing' }, requested: [] });
  let summary: Pick<Summary, 'result' | 'reason'> = { result: decision.result, reason: decision.reason };
  if (run !== undefined) {
    const full = summaryOf(run, decision, deps);
    summary = full;
    try {
      recordRun(run, full);
    } catch {
      // Best effort: the files that could not be written stay missing.
    }
  }
  printAll([...internalErrorLines(logFile, catalog), ...exitLines(summary)], deps);
  return 1;
}

// A pass whose data reporter could not append its metrics.csv rows left a history error file next to
// its pass file. The file only adds a warning; the verdict still comes from the pass files alone.
function withHistoryWarnings(decision: Decision, passes: readonly { pass: 1 | 2; passFile: string }[]): Decision {
  const warnings: RunWarning[] = passes
    .filter(({ passFile }) => fs.existsSync(historyErrorLogFor(passFile)))
    .map(({ pass }) => ({ code: 'history_not_written', pass }));
  return warnings.length === 0 ? decision : { ...decision, warnings: [...decision.warnings, ...warnings] };
}

// The warnings of the run itself go after those of the decision.
function withRunWarnings(decision: Decision, warnings: readonly RunWarning[]): Decision {
  return warnings.length === 0 ? decision : { ...decision, warnings: [...decision.warnings, ...warnings] };
}

// Redacts the text files of the run after a pass, before anything reads that pass's files back. The
// pass files, the html report and the report copies are never rewritten.
function hideValues(run: RunInfo): void {
  if (run.redactor !== undefined) {
    redactRunDirectory(run.layout.runDir, run.redactor);
  }
}

/** An interrupt that came, and the signal that tells the Playwright child to stop. */
type Interrupt = { requested: boolean; controller: AbortController };

// The two passes: pass 1 over every project, pass 2 over the slow ones, unless an interrupt came.
async function runPasses(
  root: string,
  run: RunInfo,
  projects: readonly string[],
  deps: RunDeps,
  interrupt: Interrupt,
): Promise<Decision> {
  const { runId } = run;
  // An interrupt that came before the first pass starts no child: the run has no pass 1.
  if (interrupt.requested) {
    return decide({ pass1: { state: 'missing' }, requested: [] });
  }
  const first = await deps.runPass({
    root,
    runId,
    pass: 1,
    projects: [],
    stderrLog: run.layout.stderrLog,
    print: deps.print,
    signal: interrupt.controller.signal,
  });
  hideValues(run);
  interrupt.requested = interrupt.requested || first.interrupted;
  const pass1 = readPassFile(run.layout.passFile, { runId, pass: 1, projects, requireAll: true });
  const requested = pass1.state === 'ok' && !interrupt.requested ? slowProjects(pass1.file, projects) : [];
  if (requested.length === 0) {
    return withHistoryWarnings(decide({ pass1, requested }), [{ pass: 1, passFile: run.layout.passFile }]);
  }
  const layout2 = runLayout(root, { runId, pass: 2, manual: false });
  await deps.runPass({
    root,
    runId,
    pass: 2,
    projects: requested,
    stderrLog: layout2.stderrLog,
    print: deps.print,
    signal: interrupt.controller.signal,
  });
  hideValues(run);
  const pass2 = readPassFile(layout2.passFile, { runId, pass: 2, projects: requested, requireAll: false });
  return withHistoryWarnings(decide({ pass1, pass2, requested }), [
    { pass: 1, passFile: run.layout.passFile },
    { pass: 2, passFile: layout2.passFile },
  ]);
}

// Builds the redactor from the account and puts it in front of the console sink. The pre-launch
// checks call this right after env.json is parsed, before baselines.json is read and before the child
// starts, so no later line can carry a value. A value that is too short to hide becomes a warning that
// names the field and never the value.
function hideAccount(run: RunInfo, account: Account, deps: RunDeps, state: RunState): void {
  const redactor = createRedactor(account);
  run.redactor = redactor;
  // The machine lines (RESULT=, REASON=) pass unchanged: see isMachineLine.
  state.detach = deps.attachRedactor((line) => (isMachineLine(line) ? line : redactor.text(line)));
  for (const field of redactor.tooShort) {
    run.warnings.push({ code: 'secret_too_short', field });
  }
}

// Everything after the lock is held; the caller turns an exception into the internal error.
// The order: claim, checks (the redactor is attached right after env.json), retention, the passes
// (each followed by a redaction of the run directory), the end of the run (see finishRun).
async function executeRun(
  root: string,
  args: RunArgs,
  deps: RunDeps,
  state: RunState,
  lock: HeldLock,
  interrupt: Interrupt,
): Promise<0 | 1 | 3> {
  const { runId, startedAt } = await claimRunDirectory(root, deps);
  lock.setRunId(runId);
  const layout = runLayout(root, { runId, pass: 1, manual: false });
  const run: RunInfo = {
    layout,
    runId,
    startedAt,
    coreVersion: readCoreVersion(deps.cliFile),
    locale: 'en',
    warnings: [],
    measured: false,
  };
  state.run = run;
  if (lock.takenOver) {
    run.warnings.push({ code: 'lock_taken_over' });
  }
  // The last run's files are removed first, so a stale pair is never read as this run's.
  fs.rmSync(layout.reportTxt, { force: true });
  fs.rmSync(layout.summaryJson, { force: true });
  if (args.kind === 'usage') {
    return finishRun(run, { decision: notReady('usage'), message: args.problem }, deps);
  }
  const checked = await deps.prechecks(root, deps.cliFile, undefined, {
    onEnv: (env) => {
      hideAccount(run, env.account, deps, state);
    },
  });
  if (!checked.ok) {
    const { failure } = checked;
    run.locale = failure.locale ?? 'en';
    return finishRun(run, { decision: notReady(failure.reason), message: failure.message }, deps);
  }
  run.locale = checked.value.env.locale;
  run.measured = true;
  // Retention needs retention_days from env.json, so it runs once the checks have passed; the current
  // run is newer than any cutoff and is kept by name as well. A run that was interrupted by now ends
  // without deleting anything.
  if (!interrupt.requested) {
    const { failed } = applyRetention({
      artifactsDir: layout.artifactsDir,
      startedAt,
      days: checked.value.env.retention_days,
      keep: runId,
    });
    if (failed > 0) {
      run.warnings.push({ code: 'retention_failed', count: failed });
    }
  }
  return finishRun(run, { decision: await runPasses(root, run, checked.value.projects, deps, interrupt) }, deps);
}

// The interrupt handler comes right after the lock, before the first file is written, so a signal
// during the claim, the checks or the passes ends the run through the ordinary path: no pass is
// started after it, the files are written and the lock is released by the caller.
async function execute(
  root: string,
  args: RunArgs,
  deps: RunDeps,
  state: RunState,
  lock: HeldLock,
): Promise<0 | 1 | 3> {
  const interrupt: Interrupt = { requested: false, controller: new AbortController() };
  const unregister = deps.onInterrupt(() => {
    interrupt.requested = true;
    interrupt.controller.abort();
  });
  try {
    return await executeRun(root, args, deps, state, lock, interrupt);
  } finally {
    unregister();
  }
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
  // Init is not a run. It is routed before the project root because, under npx, the cache directory
  // looks like a project root and a run would take a lock there; it prints no machine lines and
  // leaves no run record.
  if (args.kind === 'init_usage') {
    printAll([`blw init: ${args.problem}`, ...USAGE_LINES], deps);
    return 1;
  }
  if (args.kind === 'init') {
    return runInit(args, {
      packageDir: packageDirOf(deps.cliFile),
      version: readCoreVersion(deps.cliFile),
      cwd: deps.cwd(),
      print: (line) => {
        printAll([line], deps);
      },
    });
  }
  const root = projectRootFrom(deps.cliFile);
  if (root === undefined) {
    const problem = args.kind === 'usage' ? args.problem : undefined;
    return stopWithoutRun(
      problem === undefined ? 'config' : 'usage',
      problem ??
        `baselinewatch must be installed from its packed .tgz into <project>/${MODULES_DIR}/${PACKAGE_NAME}, the only supported install; this copy runs from ${packageDirOf(deps.cliFile)}`,
      deps,
    );
  }
  const artifactsDir = path.join(root, 'artifacts');
  let lock: LockResult;
  try {
    lock = acquireLock(artifactsDir, { now: deps.now, pid: deps.pid, isAlive: deps.isAlive });
  } catch (error) {
    // The cause goes to the log when the directory exists, and its code, which is never a value, to the line.
    logFailure(path.join(artifactsDir, 'cli-error.log'), error);
    const code = (error as NodeJS.ErrnoException).code;
    return stopWithoutRun(
      'config',
      `the artifacts directory cannot be created or written${typeof code === 'string' ? ` (${code})` : ''}: ${artifactsDir}`,
      deps,
    );
  }
  if (!lock.held) {
    return stopWithoutRun('locked', lockedMessage(path.join(artifactsDir, LOCK_FILE), lock.holder), deps);
  }
  // A process that ends without returning from here still frees the lock through the exit hook.
  const forgetExit = deps.onExit(lock.release);
  const state: RunState = {};
  try {
    return await execute(root, args, deps, state, lock);
  } catch (error) {
    return failInternally(root, error, state.run, deps);
  } finally {
    // The lock goes first and the rest never skips it: release() does not throw, forgetExit might.
    try {
      lock.release();
    } finally {
      try {
        forgetExit();
      } catch {
        // The hook is gone with the process anyway; the outcome of the run is decided.
      } finally {
        // After the last line is printed, whichever way the run ended.
        state.detach?.();
      }
    }
  }
}
