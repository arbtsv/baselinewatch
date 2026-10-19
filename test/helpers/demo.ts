// Helpers for e2e tests that run the in-repo demo project as a separate
// Playwright process: a hermetic nested runner, env.json and scenario fixtures
// that restore the working tree, and a reader for Playwright's JSON report.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPortalModule } from './portal.ts';

export const REPO_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_DIR: string = path.join(REPO_ROOT, 'examples', 'demo-portal');
export const DEMO_ENV_FILE: string = path.join(DEMO_DIR, 'env.json');
export const DEMO_SCENARIOS_DIR: string = path.join(DEMO_DIR, 'scenarios');

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

const HERMETIC_DROP = /^(CI|NODE_OPTIONS|FORCE_COLOR|NO_COLOR|PLAYWRIGHT_.*|PW_.*|TEST_.*)$/;

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

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

/**
 * Runs node with the given arguments inside the demo project: hermetic
 * environment, no stdin, and the whole process tree killed on timeout.
 */
export function runInDemo(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise<RunResult>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: DEMO_DIR,
      env: hermeticEnv(),
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
}

/** Runs the demo project's own Playwright CLI (a second copy, in a separate process). */
export function runDemoPlaywright(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const cli = path.join(DEMO_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
  return runInDemo([cli, ...args], opts);
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
