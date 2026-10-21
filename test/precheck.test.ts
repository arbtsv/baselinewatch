// Tests for src/precheck.ts: the checks that stop a run with exit code 3 before Playwright starts.
// Run: node --test test/precheck.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_PROBE_TIMEOUT_MS,
  checkBrowser,
  checkPlaywrightCopies,
  checkProjectFiles,
  probeChromium,
  runPrechecks,
  type PrecheckDeps,
} from '../src/precheck.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-precheck-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

type ProjectFiles = {
  /** env.json content: an object is written as JSON, null leaves the file out. */
  env?: object | null;
  /** baselines.json content: a string is written as is, null leaves the file out. */
  baselines?: object | string | null;
  /** Names of the files to create inside scenarios/. */
  scenarios?: string[];
  /** False leaves playwright.config.ts out. */
  config?: boolean;
};

function validEnv(locale: 'en' | 'ru' = 'en'): object {
  return {
    environment: 'demo',
    locale,
    account: { login: 'login-for-test', password: 'password-for-test' },
    scenarios: { demo: { nodes: { 'node-1': 'http://127.0.0.1:4101/' } } },
  };
}

let counter = 0;

function makeProject(files: ProjectFiles = {}): string {
  counter += 1;
  const root = path.join(WORK, `project-${counter}`);
  fs.mkdirSync(root);
  const env = files.env === undefined ? validEnv() : files.env;
  if (env !== null) fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify(env));
  const baselines = files.baselines === undefined ? { demo: { login_ms: { reference_ms: 300, maxRatio: 3 } } } : files.baselines;
  if (baselines !== null) {
    fs.writeFileSync(path.join(root, 'baselines.json'), typeof baselines === 'string' ? baselines : JSON.stringify(baselines));
  }
  const scenarios = files.scenarios ?? ['demo.spec.ts'];
  if (scenarios.length > 0) {
    fs.mkdirSync(path.join(root, 'scenarios'));
    for (const name of scenarios) fs.writeFileSync(path.join(root, 'scenarios', name), '');
  }
  if (files.config !== false) fs.writeFileSync(path.join(root, 'playwright.config.ts'), '');
  return root;
}

const CORE_FILE = path.join(REPO_ROOT, 'src', 'cli.ts');

// Dependencies that all say "fine", with a call log so a test can see what was asked.
function fakeDeps(calls: string[] = [], overrides: Partial<PrecheckDeps> = {}): Partial<PrecheckDeps> {
  return {
    resolveFrom: (fromFile, request) => {
      calls.push(`resolveFrom ${request}`);
      return path.join(path.dirname(fromFile), 'node_modules', request);
    },
    realpath: () => '/same/copy/package.json',
    exists: () => true,
    headlessShellPath: () => {
      calls.push('headlessShellPath');
      return '/browsers/chrome-headless-shell';
    },
    launchProbe: async () => {
      calls.push('launchProbe');
      return true;
    },
    ...overrides,
  };
}

describe('checkProjectFiles', () => {
  test('a complete project gives env, baselines and the projects in env.json order', () => {
    const root = makeProject({
      env: {
        ...(validEnv() as object),
        scenarios: {
          demo: { nodes: { 'node-1': 'http://127.0.0.1:4101/', 'node-2': 'http://127.0.0.1:4102/' } },
          alpha: { nodes: { 'node-1': 'http://127.0.0.1:4101/' } },
        },
      },
      scenarios: ['demo.spec.ts', 'alpha.spec.ts'],
    });
    const ok = checkProjectFiles(root);
    assert.deepEqual(ok.projects, ['demo--node-1', 'demo--node-2', 'alpha--node-1']);
    assert.equal(ok.env.locale, 'en');
    assert.deepEqual(ok.baselines, { demo: { login_ms: { reference_ms: 300, maxRatio: 3 } } });
  });

  test('a single node project lists one project', () => {
    assert.deepEqual(checkProjectFiles(makeProject()).projects, ['demo--node-1']);
  });

  test('a missing playwright.config.ts is a ConfigError that names the file and the root', () => {
    const root = makeProject({ config: false });
    assert.throws(
      () => checkProjectFiles(root),
      (error: Error) => {
        assert.equal((error as { reason?: string }).reason, 'config');
        assert.ok(error.message.startsWith('[config] '), error.message);
        assert.ok(error.message.includes('playwright.config.ts'), error.message);
        assert.ok(error.message.includes(root), error.message);
        return true;
      },
    );
  });
});

describe('runPrechecks: configuration', () => {
  const CASES: Array<[string, ProjectFiles, string]> = [
    ['a missing env.json', { env: null }, 'env.json'],
    ['a broken baselines.json', { baselines: '{ not json' }, 'baselines.json'],
    ['a scenario without its file', { scenarios: [] }, 'demo.spec.ts'],
    ['a missing playwright.config.ts', { config: false }, 'playwright.config.ts'],
  ];

  for (const [name, files, mention] of CASES) {
    test(`${name} fails with config and the ConfigError message unchanged`, async () => {
      const root = makeProject(files);
      let expected = '';
      try {
        checkProjectFiles(root);
      } catch (error) {
        expected = (error as Error).message;
      }
      assert.notEqual(expected, '', 'the project is expected to be broken');

      const result = await runPrechecks(root, CORE_FILE, fakeDeps());
      assert.equal(result.ok, false);
      const failure = result.ok ? undefined : result.failure;
      assert.equal(failure?.reason, 'config');
      assert.equal(failure?.message, expected);
      assert.ok(failure?.message.includes(mention), failure?.message);
      assert.ok(failure?.message.includes(root), failure?.message);
    });
  }

  test('a broken baselines.json still reports the locale of a readable env.json', async () => {
    const root = makeProject({ env: validEnv('ru'), baselines: '{ not json' });
    const result = await runPrechecks(root, CORE_FILE, fakeDeps());
    assert.equal(result.ok ? undefined : result.failure.locale, 'ru');
  });

  test('a missing env.json has no locale', async () => {
    const result = await runPrechecks(makeProject({ env: null }), CORE_FILE, fakeDeps());
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 'x' : result.failure.locale, undefined);
  });
});

describe('checkPlaywrightCopies', () => {
  test('two lookups that end at the same file are one copy', () => {
    const root = makeProject();
    assert.equal(checkPlaywrightCopies(root, CORE_FILE, fakeDeps()), undefined);
  });

  test('the lookups start at the project package.json and at the core file', () => {
    const starts: string[] = [];
    const deps = fakeDeps([], {
      resolveFrom: (fromFile) => {
        starts.push(fromFile);
        return fromFile;
      },
    });
    const root = makeProject();
    checkPlaywrightCopies(root, CORE_FILE, deps);
    assert.deepEqual(starts, [path.join(root, 'package.json'), CORE_FILE]);
  });

  test('different real paths are two copies', () => {
    const root = makeProject();
    const deps = fakeDeps([], { realpath: (file) => file });
    const failure = checkPlaywrightCopies(root, CORE_FILE, {
      ...deps,
      resolveFrom: (fromFile) => `${fromFile}.package.json`,
    });
    assert.equal(failure?.reason, 'playwright_copies');
    assert.match(failure?.message ?? '', /@playwright\/test/);
  });

  for (const side of ['project', 'core'] as const) {
    test(`an unresolvable package on the ${side} side is playwright_copies`, () => {
      const root = makeProject();
      const deps = fakeDeps([], {
        resolveFrom: (fromFile) => {
          if ((side === 'project') === fromFile.startsWith(root)) throw new Error('Cannot find module');
          return '/some/where/package.json';
        },
      });
      const failure = checkPlaywrightCopies(root, CORE_FILE, deps);
      assert.equal(failure?.reason, 'playwright_copies');
    });
  }

  test('a failing realpath is playwright_copies', () => {
    const failure = checkPlaywrightCopies(
      makeProject(),
      CORE_FILE,
      fakeDeps([], {
        realpath: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    assert.equal(failure?.reason, 'playwright_copies');
  });

  test('the real resolver finds exactly one copy in this repository', () => {
    assert.equal(checkPlaywrightCopies(REPO_ROOT, path.join(REPO_ROOT, 'src', 'precheck.ts')), undefined);
  });
});

describe('checkBrowser', () => {
  test('a path that does not exist is browser, and the message names the install command', async () => {
    const failure = await checkBrowser(
      makeProject(),
      fakeDeps([], { headlessShellPath: () => '/browsers/chrome-headless-shell', exists: () => false }),
    );
    assert.equal(failure?.reason, 'browser');
    assert.ok(failure?.message.includes('npx playwright install chromium'), failure?.message);
  });

  test('a path that exists is fine', async () => {
    assert.equal(await checkBrowser(makeProject(), fakeDeps()), undefined);
  });

  test('the existing file is the one the registry named', async () => {
    const asked: string[] = [];
    await checkBrowser(
      makeProject(),
      fakeDeps([], {
        headlessShellPath: () => '/browsers/the-named-file',
        exists: (file) => {
          asked.push(file);
          return true;
        },
      }),
    );
    assert.deepEqual(asked, ['/browsers/the-named-file']);
  });

  test('without the internal registry a failed launch probe is browser', async () => {
    const calls: string[] = [];
    const failure = await checkBrowser(
      makeProject(),
      fakeDeps(calls, { headlessShellPath: () => undefined, launchProbe: async () => false }),
    );
    assert.equal(failure?.reason, 'browser');
  });

  test('without the internal registry a working launch probe is fine', async () => {
    const failure = await checkBrowser(
      makeProject(),
      fakeDeps([], { headlessShellPath: () => undefined, launchProbe: async () => true }),
    );
    assert.equal(failure, undefined);
  });

  test('the launch probe is not used when the registry answers', async () => {
    const calls: string[] = [];
    await checkBrowser(makeProject(), fakeDeps(calls));
    assert.equal(calls.includes('launchProbe'), false);
  });

  test('a registry lookup that throws falls back to the launch probe', async () => {
    const calls: string[] = [];
    const failure = await checkBrowser(
      makeProject(),
      fakeDeps(calls, {
        headlessShellPath: () => {
          throw new Error('internal API changed');
        },
      }),
    );
    assert.equal(failure, undefined);
    assert.ok(calls.includes('launchProbe'));
  });

  test('a launch probe that throws is browser', async () => {
    const failure = await checkBrowser(
      makeProject(),
      fakeDeps([], {
        headlessShellPath: () => undefined,
        launchProbe: async () => {
          throw new Error('spawn failed');
        },
      }),
    );
    assert.equal(failure?.reason, 'browser');
  });

  test('the real registry of this repository names a headless shell executable', async () => {
    let named = '';
    await checkBrowser(REPO_ROOT, {
      exists: (file) => {
        named = file;
        return true;
      },
    });
    // Existence is not asserted: unit runners may have no browsers installed.
    assert.ok(path.basename(named).startsWith('chrome-headless-shell'), `named: ${named}`);
  });
});

describe('probeChromium', () => {
  function launcher(launch: 'resolve' | 'reject', close: 'resolve' | 'reject' = 'resolve') {
    const calls = { launchOptions: [] as Array<{ headless: boolean; timeout: number }>, closed: 0 };
    return {
      calls,
      chromium: {
        launch: async (options: { headless: boolean; timeout: number }) => {
          calls.launchOptions.push(options);
          if (launch === 'reject') throw new Error('browser missing');
          return {
            close: async () => {
              calls.closed += 1;
              if (close === 'reject') throw new Error('close failed');
            },
          };
        },
      },
    };
  }

  test('a launch that fails is a missing browser and nothing is closed', async () => {
    const fake = launcher('reject');
    assert.equal(await probeChromium(fake.chromium, BROWSER_PROBE_TIMEOUT_MS), false);
    assert.equal(fake.calls.closed, 0);
  });

  test('a launch that works is an installed browser and the browser is closed once', async () => {
    const fake = launcher('resolve');
    assert.equal(await probeChromium(fake.chromium, BROWSER_PROBE_TIMEOUT_MS), true);
    assert.equal(fake.calls.closed, 1);
  });

  test('a close that fails does not turn a launched browser into a missing one', async () => {
    const fake = launcher('resolve', 'reject');
    assert.equal(await probeChromium(fake.chromium, BROWSER_PROBE_TIMEOUT_MS), true);
    assert.equal(fake.calls.closed, 1);
  });

  test('the launch is headless and carries the time limit', async () => {
    assert.equal(BROWSER_PROBE_TIMEOUT_MS, 30_000);
    const fake = launcher('resolve');
    await probeChromium(fake.chromium, BROWSER_PROBE_TIMEOUT_MS);
    assert.deepEqual(fake.calls.launchOptions, [{ headless: true, timeout: 30_000 }]);
    const other = launcher('resolve');
    await probeChromium(other.chromium, 1234);
    assert.deepEqual(other.calls.launchOptions, [{ headless: true, timeout: 1234 }]);
  });
});

describe('runPrechecks: order and result', () => {
  test('a complete project passes all three checks and returns the project data', async () => {
    const result = await runPrechecks(makeProject(), CORE_FILE, fakeDeps());
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value.projects : [], ['demo--node-1']);
  });

  test('a config failure never calls the copy resolver or the browser lookup', async () => {
    const calls: string[] = [];
    const result = await runPrechecks(makeProject({ env: null }), CORE_FILE, fakeDeps(calls));
    assert.equal(result.ok ? 'ok' : result.failure.reason, 'config');
    assert.deepEqual(calls, []);
  });

  test('a copy failure never calls the browser lookup', async () => {
    const calls: string[] = [];
    const result = await runPrechecks(
      makeProject(),
      CORE_FILE,
      fakeDeps(calls, {
        realpath: (file) => file,
        resolveFrom: (fromFile) => `${fromFile}.package.json`,
      }),
    );
    assert.equal(result.ok ? 'ok' : result.failure.reason, 'playwright_copies');
    assert.equal(calls.includes('headlessShellPath'), false);
    assert.equal(calls.includes('launchProbe'), false);
  });

  test('a browser failure comes after the copies passed', async () => {
    const result = await runPrechecks(makeProject(), CORE_FILE, fakeDeps([], { exists: () => false }));
    assert.equal(result.ok ? 'ok' : result.failure.reason, 'browser');
  });

  test('a failure after env.json loaded carries its locale', async () => {
    const root = makeProject({ env: validEnv('ru') });
    const copies = await runPrechecks(root, CORE_FILE, fakeDeps([], { realpath: (file) => file, resolveFrom: (f) => `${f}.x` }));
    assert.equal(copies.ok ? undefined : copies.failure.locale, 'ru');
    const browser = await runPrechecks(root, CORE_FILE, fakeDeps([], { exists: () => false }));
    assert.equal(browser.ok ? undefined : browser.failure.locale, 'ru');
  });
});

describe('module boundaries', () => {
  const FORBIDDEN = ['@playwright/test', './config.ts', './fixture.ts', './index.ts'];

  for (const file of ['outcome.ts', 'args.ts', 'precheck.ts']) {
    test(`src/${file} has no static import of Playwright or of the config, fixture and index modules`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8');
      const sources = [...text.matchAll(/^\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
      assert.ok(sources.length > 0, 'the import scan found nothing');
      for (const name of FORBIDDEN) {
        assert.equal(sources.includes(name), false, `${file} imports ${name}`);
      }
    });
  }
});
