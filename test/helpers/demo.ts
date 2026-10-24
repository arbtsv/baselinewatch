// Helpers for e2e tests that run the in-repo demo project as a separate
// Playwright process: a hermetic nested runner, env.json and scenario fixtures
// that restore the working tree, and a reader for Playwright's JSON report.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { loadPortalModule } from './portal.ts';
import { embeddedZipTexts, unzipEntries } from './zip.ts';

export const REPO_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_DIR: string = path.join(REPO_ROOT, 'examples', 'demo-portal');
export const DEMO_ENV_FILE: string = path.join(DEMO_DIR, 'env.json');
export const DEMO_SCENARIOS_DIR: string = path.join(DEMO_DIR, 'scenarios');
export const DEMO_ARTIFACTS_DIR: string = path.join(DEMO_DIR, 'artifacts');

export type DemoEnv = {
  environment: string;
  locale: 'en' | 'ru';
  account: { login: string; password: string };
  retention_days?: number;
  scenarios: Record<string, { nodes: Record<string, string> }>;
};

/**
 * Builds an env.json value. By default one scenario named "demo" gets the given
 * nodes; opts.scenarios replaces the whole scenario map.
 */
export async function demoEnv(
  nodes: Record<string, string>,
  opts: { scenarios?: Record<string, Record<string, string>> } = {},
): Promise<DemoEnv> {
  const portal = await loadPortalModule();
  const scenarios: DemoEnv['scenarios'] = {};
  for (const [name, scenarioNodes] of Object.entries(opts.scenarios ?? { demo: nodes })) {
    scenarios[name] = { nodes: { ...scenarioNodes } };
  }
  return {
    environment: 'demo',
    locale: 'en',
    account: { login: portal.DEMO_ACCOUNT.login, password: portal.DEMO_ACCOUNT.password },
    retention_days: 30,
    scenarios,
  };
}

/**
 * Writes (or removes, for null) the demo env.json while fn runs and restores
 * the previous bytes, or the previous absence, afterwards.
 */
export async function withDemoEnv<T>(env: DemoEnv | null, fn: () => Promise<T>): Promise<T> {
  const previous = fs.existsSync(DEMO_ENV_FILE) ? fs.readFileSync(DEMO_ENV_FILE) : null;
  try {
    if (env === null) fs.rmSync(DEMO_ENV_FILE, { force: true });
    else fs.writeFileSync(DEMO_ENV_FILE, `${JSON.stringify(env, null, 2)}\n`);
    return await fn();
  } finally {
    if (previous === null) fs.rmSync(DEMO_ENV_FILE, { force: true });
    else fs.writeFileSync(DEMO_ENV_FILE, previous);
  }
}

const SCENARIO_NAME = /^e2e-[a-z0-9-]+$/;

/**
 * Writes scenarios/<name>.spec.ts into the demo project while fn runs and
 * removes it afterwards. Only names the repository ignores are accepted.
 */
export async function withScenario<T>(name: string, source: string, fn: () => Promise<T>): Promise<T> {
  if (!SCENARIO_NAME.test(name)) {
    throw new Error(`scenario name "${name}" must match ${SCENARIO_NAME.source}`);
  }
  const createdDir = !fs.existsSync(DEMO_SCENARIOS_DIR);
  fs.mkdirSync(DEMO_SCENARIOS_DIR, { recursive: true });
  const file = path.join(DEMO_SCENARIOS_DIR, `${name}.spec.ts`);
  try {
    fs.writeFileSync(file, source);
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
    if (createdDir) {
      try {
        fs.rmdirSync(DEMO_SCENARIOS_DIR);
      } catch {
        // not empty: another file lives there, leave it
      }
    }
  }
}

export const DEMO_BASELINES_FILE: string = path.join(DEMO_DIR, 'baselines.json');

export type BaselineMap = Record<string, Record<string, { reference_ms: number; maxRatio: number }>>;

/**
 * Adds baseline entries to the demo baselines.json while fn runs: for every scenario of extra,
 * its metric map is merged over the existing one. The previous bytes are restored afterwards.
 */
export async function withBaselines<T>(extra: BaselineMap, fn: () => Promise<T>): Promise<T> {
  const previous = fs.readFileSync(DEMO_BASELINES_FILE);
  try {
    const current = JSON.parse(previous.toString('utf8')) as BaselineMap;
    for (const [scenario, metrics] of Object.entries(extra)) {
      current[scenario] = { ...current[scenario], ...metrics };
    }
    fs.writeFileSync(DEMO_BASELINES_FILE, `${JSON.stringify(current, null, 2)}\n`);
    return await fn();
  } finally {
    fs.writeFileSync(DEMO_BASELINES_FILE, previous);
  }
}

/**
 * Writes the given text to a file (or removes the file, for null) while fn runs and restores the
 * previous bytes, or the previous absence, afterwards.
 */
export async function withRawFile<T>(file: string, text: string | null, fn: () => Promise<T>): Promise<T> {
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    if (text === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text);
    return await fn();
  } finally {
    if (previous === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, previous);
  }
}

/**
 * Puts a second @playwright/test package under the installed core while fn runs, so the core and the
 * project no longer share one copy. Refuses to run when the core already has a node_modules of its
 * own, and removes that directory afterwards even when fn throws.
 */
export async function withPlaywrightStub<T>(fn: () => Promise<T>): Promise<T> {
  const nested = path.join(DEMO_DIR, 'node_modules', 'baselinewatch', 'node_modules');
  if (fs.existsSync(nested)) {
    throw new Error(`${nested} already exists; refusing to replace it with a stub`);
  }
  try {
    const stub = path.join(nested, '@playwright', 'test');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'package.json'), `${JSON.stringify({ name: '@playwright/test', version: '0.0.0-stub' })}\n`);
    return await fn();
  } finally {
    fs.rmSync(nested, { recursive: true, force: true });
  }
}

/** Removes everything a run left in the demo artifacts directory. */
export function cleanArtifacts(): void {
  fs.rmSync(DEMO_ARTIFACTS_DIR, { recursive: true, force: true });
}

/** Reads and parses a JSON file under the demo artifacts directory, for example summary.json. */
export function readArtifactJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(DEMO_ARTIFACTS_DIR, name), 'utf8')) as Record<string, unknown>;
}

/** The data lines of metrics.csv or runs.csv that belong to one run id; none when the file is missing. */
export function csvLinesFor(file: 'metrics.csv' | 'runs.csv', runId: string): string[] {
  const target = path.join(DEMO_ARTIFACTS_DIR, file);
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${runId},`));
}

/** The non-empty lines of the stdout of a run, without a trailing carriage return. */
export function outputLines(run: RunResult): string[] {
  return run.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
}

const BINARY_FILE = /\.(?:png|jpe?g|gif|webm|mp4|zip|zst|gz|pdf)$/i;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The text of a file as the command line sees it, or null for a binary one (a NUL byte, not strict UTF-8). */
function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The text of every file under a directory, with the zip data inside an html report decoded. blw run
 * redacts the test results, so they are covered; a file with a binary suffix or binary content is
 * never text in the run files and is left out. The html report stays outside the promise: unless
 * snapshots are included, the attachment copies in html/data are left out, because when an expect
 * fails Playwright itself writes a snapshot of the page there, with the value of every field.
 */
function directoryTexts(root: string, snapshots: boolean, dir: string = root): [string, string][] {
  const texts: [string, string][] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!snapshots && relative.endsWith('html/data')) continue;
      texts.push(...directoryTexts(root, snapshots, file));
    } else if (!BINARY_FILE.test(entry.name)) {
      const label = path.relative(root, file);
      const text = textOf(fs.readFileSync(file));
      if (text === null) continue;
      texts.push([label, text]);
      if (entry.name === 'index.html') {
        const inner = embeddedZipTexts(text);
        // A report whose data cannot be found would make this check pass for the wrong reason.
        if (inner.length === 0) throw new Error(`no zip data found in ${label}: the report format changed`);
        for (const [name, content] of inner) texts.push([`${label}:${name}`, content]);
      }
    }
  }
  return texts;
}

/**
 * Checks that neither the demo login nor the demo password occurs in the output of a run or, when the
 * run id is known, in the files of that run: summary.json, report.txt, both CSV files, every text file
 * under the run directory (the test results included, which blw run redacts) with the data packed
 * inside the html report, and the bytes of every entry of the run zip when there is one. The page
 * snapshots that Playwright writes for a failed expect into the html report are checked only with
 * opts.snapshots.
 */
export async function expectNoDemoSecrets(
  run: RunResult,
  runId: string | undefined,
  opts: { snapshots?: boolean } = {},
): Promise<void> {
  const { DEMO_ACCOUNT } = await loadPortalModule();
  const texts: [string, string][] = [
    ['stdout', run.stdout],
    ['stderr', run.stderr],
  ];
  if (runId !== undefined) {
    const files = ['summary.json', 'report.txt', 'metrics.csv', 'runs.csv'].map((name) => path.join(DEMO_ARTIFACTS_DIR, name));
    for (const file of files) {
      if (fs.existsSync(file)) texts.push([path.basename(file), fs.readFileSync(file, 'utf8')]);
    }
    const runDir = path.join(DEMO_ARTIFACTS_DIR, 'runs', runId);
    if (fs.existsSync(runDir)) texts.push(...directoryTexts(runDir, opts.snapshots === true));
  }
  for (const [label, text] of texts) {
    expect(text.includes(DEMO_ACCOUNT.login), `the demo login is in ${label}`).toBe(false);
    expect(text.includes(DEMO_ACCOUNT.password), `the demo password is in ${label}`).toBe(false);
  }
  const archive = runId === undefined ? undefined : path.join(DEMO_ARTIFACTS_DIR, `report_${runId}.zip`);
  if (archive !== undefined && fs.existsSync(archive)) {
    const login = Buffer.from(DEMO_ACCOUNT.login);
    const password = Buffer.from(DEMO_ACCOUNT.password);
    for (const [name, bytes] of unzipEntries(fs.readFileSync(archive))) {
      expect(bytes.includes(login), `the demo login is in the zip entry ${name}`).toBe(false);
      expect(bytes.includes(password), `the demo password is in the zip entry ${name}`).toBe(false);
    }
  }
}

const HERMETIC_DROP =/^(CI|NODE_OPTIONS|FORCE_COLOR|NO_COLOR|PLAYWRIGHT_.*|PW_.*|TEST_.*)$/;

/** The parent environment without the variables that change a nested Playwright run. */
export function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (HERMETIC_DROP.test(key)) delete env[key];
  }
  return env;
}

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

// taskkill.exe by its full path under the system directory, never through PATH or the working directory.
function taskkillExe(): string {
  const systemRoot = [process.env.SystemRoot, process.env.windir].find((value) => value !== undefined && value !== '') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'taskkill.exe');
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync(taskkillExe(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

export type StartedRun = {
  pid: number;
  /** Settles when the process and its output pipes are closed. */
  result: Promise<RunResult>;
  /** Kills the whole process tree, hard. */
  kill: () => void;
};

/**
 * Starts node with the given arguments and returns at once: hermetic environment (opts.env is merged
 * over it), no stdin, the demo project as working directory unless opts.cwd says otherwise, and the
 * whole process tree killed on timeout or through kill().
 */
function startNode(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): StartedRun {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd ?? DEMO_DIR,
    env: { ...hermeticEnv(), ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, durationMs: performance.now() - started, timedOut });
    });
  });
  if (child.pid === undefined) {
    // The process did not start; the error event settles result.
    void result.catch(() => undefined);
    throw new Error(`could not start ${process.execPath}`);
  }
  return { pid: child.pid, result, kill: () => killTree(child.pid) };
}

/**
 * Runs node with the given arguments: hermetic environment (opts.env is merged over it), no stdin,
 * the demo project as working directory unless opts.cwd says otherwise, and the whole process tree
 * killed on timeout.
 */
export function runInDemo(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  return startNode(args, opts).result;
}

/** Runs the demo project's own Playwright CLI (a second copy, in a separate process). */
export function runDemoPlaywright(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const cli = path.join(DEMO_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
  return runInDemo([cli, ...args], opts);
}

const BLW_CLI: string = path.join(DEMO_DIR, 'node_modules', 'baselinewatch', 'dist', 'cli.js');

/** Starts `blw` as the demo project has it installed without waiting for it; kill() ends its whole tree. */
export function startBlw(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): StartedRun {
  return startNode([BLW_CLI, ...args], opts);
}

/** Runs `blw` as the demo project has it installed, the way a scheduler would start it. */
export function runBlw(
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  return startBlw(args, opts).result;
}

export type JsonTest = {
  project: string;
  title: string;
  status: string;
  resultsCount: number;
  retry: number;
  errors: string[];
  annotations: { type: string; description?: string }[];
  /** body is the base64 text of an attachment that was attached from memory. */
  attachments: { name: string; contentType: string; path?: string; body?: string }[];
};

type RawAnnotation = { type: string; description?: string };
type RawResult = {
  status?: string;
  retry?: number;
  errors?: { message?: string }[];
  attachments?: { name: string; contentType: string; path?: string; body?: string }[];
  annotations?: RawAnnotation[];
};
type RawTest = { projectName?: string; annotations?: RawAnnotation[]; results?: RawResult[] };
type RawSpec = { title: string; tests?: RawTest[] };
type RawSuite = { specs?: RawSpec[]; suites?: RawSuite[] };
type RawReport = {
  suites?: RawSuite[];
  stats?: Record<string, number>;
  errors?: { message?: string }[];
};

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Reads the JSON reporter output of a nested run into a flat list of tests. */
export function parseJsonReport(run: RunResult): {
  tests: JsonTest[];
  stats: Record<string, number>;
  errors: string[];
} {
  let report: RawReport;
  try {
    report = JSON.parse(run.stdout) as RawReport;
  } catch {
    throw new Error(`the nested run did not print a JSON report; stderr: ${run.stderr.slice(0, 2000)}`);
  }
  const tests: JsonTest[] = [];
  const walk = (suite: RawSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        tests.push({
          project: test.projectName ?? '',
          title: spec.title,
          status: last?.status ?? 'skipped',
          resultsCount: results.length,
          retry: last?.retry ?? 0,
          errors: (last?.errors ?? []).map((error) => stripAnsi(error.message ?? '')),
          // The runner repeats a test's annotations on its last result; take one copy of them.
          annotations: last?.annotations ?? test.annotations ?? [],
          attachments: last?.attachments ?? [],
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return {
    tests,
    stats: report.stats ?? {},
    errors: (report.errors ?? []).map((error) => stripAnsi(error.message ?? '')),
  };
}
