// Tests for src/config.ts and src/layout.ts: project construction, the fixed run policy, secrets
// and configuration errors. Importing src/config.ts loads @playwright/test outside a Playwright run.
// Run: node --test test/config.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../src/config.ts';
import { buildMonitorConfig, defineMonitorConfig, DIRECT_CONNECTION_ARGS, POLICY } from '../src/config.ts';
import type { Baselines } from '../src/baselines.ts';
import type { MonitorEnv } from '../src/env.ts';
import { ConfigError } from '../src/errors.ts';
import { MANUAL_RUN_ID, runLayout } from '../src/layout.ts';

const LOGIN = 'login-value-for-test';
const SECRET = 'secret-value-for-test';

function memoryEnv(): MonitorEnv {
  return {
    environment: 'demo',
    locale: 'en',
    account: { login: LOGIN, password: SECRET },
    retention_days: 30,
    scenarios: {
      alpha: { nodes: { 'node-1': 'http://127.0.0.1:4101/app', 'node-2': 'http://127.0.0.1:4102/' } },
      beta: { nodes: { 'node-1': 'http://127.0.0.1:4101/', 'node-2': 'http://127.0.0.1:4102/' } },
    },
  };
}

const MEMORY_BASELINES: Baselines = {
  alpha: { login_ms: { reference_ms: 300, maxRatio: 3 } },
};

const ROOT = path.resolve(os.tmpdir(), 'blw-config-root');

function memoryInput() {
  return {
    env: memoryEnv(),
    baselines: MEMORY_BASELINES,
    rootDir: ROOT,
    envFile: path.join(ROOT, 'env.json'),
    baselinesFile: path.join(ROOT, 'baselines.json'),
  };
}

type ProjectFiles = {
  /** env.json content: an object is written as JSON, null leaves the file out. */
  env?: object | null;
  /** baselines.json content: an object is written as JSON, a string as is, null leaves it out. */
  baselines?: object | string | null;
  /** Names of the files to create inside scenarios/. */
  scenarios?: string[];
  /** File name for baselines.json, default "baselines.json". */
  baselinesName?: string;
};

function validEnv(): object {
  return {
    environment: 'demo',
    locale: 'en',
    account: { login: LOGIN, password: SECRET },
    scenarios: { demo: { nodes: { 'node-1': 'http://127.0.0.1:4101/' } } },
  };
}

function validBaselines(): object {
  return { demo: { login_ms: { reference_ms: 300, maxRatio: 3 } } };
}

function makeProject(files: ProjectFiles = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-config-'));
  const env = files.env === undefined ? validEnv() : files.env;
  if (env !== null) fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify(env));
  const baselines = files.baselines === undefined ? validBaselines() : files.baselines;
  if (baselines !== null) {
    const text = typeof baselines === 'string' ? baselines : JSON.stringify(baselines);
    fs.writeFileSync(path.join(root, files.baselinesName ?? 'baselines.json'), text);
  }
  const scenarios = files.scenarios ?? ['demo.spec.ts'];
  if (scenarios.length > 0) {
    fs.mkdirSync(path.join(root, 'scenarios'));
    for (const name of scenarios) fs.writeFileSync(path.join(root, 'scenarios', name), '');
  }
  return root;
}

function listing(dir: string): string[] {
  const names: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    names.push(path.relative(dir, full));
    if (item.isDirectory()) names.push(...listing(full).map((name) => path.join(item.name, name)));
  }
  return names.sort();
}

// A configuration error names the file and never carries the account values.
function assertConfigError(fn: () => unknown, pattern: RegExp): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    assert.equal(error.reason, 'config');
    assert.ok(error.message.startsWith('[config] '), `message starts with the prefix: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(SECRET), false, 'the message leaks the password');
    assert.equal(error.message.includes(LOGIN), false, 'the message leaks the login');
    return error;
  }
  assert.fail('expected a ConfigError but nothing was thrown');
}

describe('buildMonitorConfig: projects', () => {
  const built = buildMonitorConfig(memoryInput());
  const projects = built.projects ?? [];

  test('two scenarios on two nodes give four projects in env.json order', () => {
    assert.deepEqual(
      projects.map((project) => project.name),
      ['alpha--node-1', 'alpha--node-2', 'beta--node-1', 'beta--node-2'],
    );
  });

  test('each project runs its own scenario file from the scenarios directory', () => {
    assert.equal(built.testDir, path.join(ROOT, 'scenarios'));
    assert.deepEqual(
      projects.map((project) => project.testMatch),
      ['alpha.spec.ts', 'alpha.spec.ts', 'beta.spec.ts', 'beta.spec.ts'],
    );
    assert.deepEqual(projects[1]?.metadata, { scenario: 'alpha', node: 'node-2' });
  });

  test('the base URL is the string from env.json, character for character', () => {
    assert.equal(projects[0]?.use?.baseURL, 'http://127.0.0.1:4101/app');
    assert.equal(projects[1]?.use?.baseURL, 'http://127.0.0.1:4102/');
  });

  test('a project carries the baselines of its own scenario only, or an empty table', () => {
    assert.deepEqual(projects[0]?.use?.blwBaselines, MEMORY_BASELINES.alpha);
    assert.deepEqual(projects[2]?.use?.blwBaselines, {});
  });

  test('the env and baselines file paths are absolute', () => {
    for (const project of projects) {
      assert.ok(path.isAbsolute(project.use?.blwEnvFile ?? ''));
      assert.ok(path.isAbsolute(project.use?.blwBaselinesFile ?? ''));
    }
  });

  test('a project keeps launch options out of its own use block', () => {
    for (const project of projects) {
      assert.equal(project.use?.launchOptions, undefined);
    }
  });
});

describe('buildMonitorConfig: fixed run policy', () => {
  const built = buildMonitorConfig(memoryInput());
  const layout = runLayout(ROOT);

  test('nothing is retried, run in parallel or focused', () => {
    assert.equal(built.retries, 0);
    assert.equal(built.workers, 1);
    assert.equal(built.fullyParallel, false);
    assert.equal(built.forbidOnly, true);
  });

  test('timeouts come from the policy object', () => {
    assert.equal(built.timeout, 30_000);
    assert.equal(built.expect?.timeout, 5_000);
    assert.equal(built.use?.actionTimeout, 10_000);
    assert.equal(built.use?.navigationTimeout, 15_000);
    assert.equal(built.timeout, POLICY.testTimeoutMs);
    assert.equal(built.expect?.timeout, POLICY.expectTimeoutMs);
    assert.equal(built.use?.actionTimeout, POLICY.actionTimeoutMs);
    assert.equal(built.use?.navigationTimeout, POLICY.navigationTimeoutMs);
  });

  test('every policy value is a whole number of milliseconds', () => {
    for (const [name, value] of Object.entries(POLICY)) {
      assert.ok(Number.isInteger(value) && value > 0, `${name} is ${value}`);
    }
  });

  test('a test timeout plus the end-of-test budget stays inside 50 seconds', () => {
    // 15_000 is the time the measure fixture is allowed for its end-of-test work; the sum leaves
    // 10 seconds of the 60-second bound for the browser start and the report.
    assert.ok(POLICY.testTimeoutMs + 15_000 <= 50_000);
  });

  test('trace, video and the built-in screenshot are off', () => {
    assert.equal(built.use?.trace, 'off');
    assert.equal(built.use?.video, 'off');
    assert.equal(built.use?.screenshot, 'off');
  });

  test('the browser connects directly, without the system proxy', () => {
    assert.deepEqual(DIRECT_CONNECTION_ARGS, ['--no-proxy-server']);
    assert.deepEqual(built.use?.launchOptions?.args, ['--no-proxy-server']);
    assert.notEqual(built.use?.launchOptions?.args, DIRECT_CONNECTION_ARGS, 'the config gets its own copy');
  });

  test('output goes under the manual run and the only reporter is html that never opens', () => {
    assert.equal(MANUAL_RUN_ID, 'manual');
    assert.equal(layout.outputDir, path.join(ROOT, 'artifacts', 'runs', 'manual', 'pass-1', 'test-results'));
    assert.equal(built.outputDir, layout.outputDir);
    assert.deepEqual(built.reporter, [['html', { outputFolder: layout.htmlDir, open: 'never' }]]);
    assert.equal(layout.htmlDir, path.join(ROOT, 'artifacts', 'runs', 'manual', 'pass-1', 'html'));
  });
});

describe('buildMonitorConfig: secrets and determinism', () => {
  test('the serialized config holds neither the login nor the password', () => {
    const text = JSON.stringify(buildMonitorConfig(memoryInput()));
    assert.equal(text.includes(LOGIN), false);
    assert.equal(text.includes(SECRET), false);
  });

  test('two calls give deep-equal results', () => {
    assert.deepEqual(buildMonitorConfig(memoryInput()), buildMonitorConfig(memoryInput()));
  });
});

describe('defineMonitorConfig: files on disk', () => {
  test('a valid project gives one project', () => {
    const root = makeProject();
    const built = defineMonitorConfig({ rootDir: root });
    assert.deepEqual(
      (built.projects ?? []).map((project) => project.name),
      ['demo--node-1'],
    );
  });

  test('it neither prints nor writes anything', (t) => {
    const root = makeProject();
    const before = listing(root);
    const log = t.mock.method(console, 'log');
    const warn = t.mock.method(console, 'warn');
    const emit = t.mock.method(process, 'emitWarning');
    defineMonitorConfig({ rootDir: root });
    assert.equal(log.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
    assert.deepEqual(listing(root), before);
  });

  test('a missing env.json names the file', () => {
    const root = makeProject({ env: null });
    assertConfigError(() => defineMonitorConfig({ rootDir: root }), /env\.json/);
  });

  test('a broken baselines.json names the file', () => {
    const root = makeProject({ baselines: '{ not json' });
    assertConfigError(() => defineMonitorConfig({ rootDir: root }), /baselines\.json/);
  });

  test('the baselines option reads another file', () => {
    const root = makeProject({ baselines: validBaselines(), baselinesName: 'approved.json' });
    // Without the option the default file is missing ...
    assertConfigError(() => defineMonitorConfig({ rootDir: root }), /baselines\.json/);
    // ... and with it the approved file is used.
    const built = defineMonitorConfig({ rootDir: root, baselines: 'approved.json' });
    assert.deepEqual(built.projects?.[0]?.use?.blwBaselines, { login_ms: { reference_ms: 300, maxRatio: 3 } });
    assert.equal(built.projects?.[0]?.use?.blwBaselinesFile, path.join(root, 'approved.json'));
  });

  test('extra keys in a baselines entry load without a warning', (t) => {
    const root = makeProject({
      baselines: { demo: { login_ms: { reference_ms: 300, maxRatio: 3, approved_by: 'someone', note: 'extra' } } },
    });
    const warn = t.mock.method(console, 'warn');
    const emit = t.mock.method(process, 'emitWarning');
    const built = defineMonitorConfig({ rootDir: root });
    assert.deepEqual(built.projects?.[0]?.use?.blwBaselines, { login_ms: { reference_ms: 300, maxRatio: 3 } });
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
  });
});

describe('defineMonitorConfig: scenario files', () => {
  test('a scenario without its file is a configuration error that names the file', () => {
    const root = makeProject({ scenarios: [] });
    const error = assertConfigError(() => defineMonitorConfig({ rootDir: root }), /demo\.spec\.ts/);
    assert.equal(error.file, path.join(root, 'scenarios', 'demo.spec.ts'));
  });

  test('a scenarios directory without the right file is the same error', () => {
    const root = makeProject({ scenarios: ['other.spec.ts'] });
    assertConfigError(() => defineMonitorConfig({ rootDir: root }), /demo\.spec\.ts/);
  });

  test('the file name is compared case-exactly, so Demo.spec.ts does not satisfy scenario demo', () => {
    const root = makeProject({ scenarios: ['Demo.spec.ts'] });
    assertConfigError(() => defineMonitorConfig({ rootDir: root }), /demo\.spec\.ts/);
  });

  test('a scenario name that leaves the scenarios directory is a configuration error', () => {
    const root = makeProject();
    assertConfigError(() => config.checkScenarioFiles(root, ['../outside']), /outside/);
    assertConfigError(() => config.checkScenarioFiles(root, ['nested/name']), /outside/);
  });
});
