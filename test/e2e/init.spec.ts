// A monitoring project made by blw init from the packed core, run end to end: the literal npx command in an
// empty directory, then the project installed from vendor/ and run against the demo portal.
//
// Run: npm run e2e -- test/e2e/init.spec.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_DIR, REPO_ROOT, demoEnv, hermeticEnv, runInDemo } from '../helpers/demo.ts';
import { loadPortalModule, startPortal, type RunningPortal } from '../helpers/portal.ts';

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const TGZ_NAME = `baselinewatch-${VERSION}.tgz`;
const TGZ = path.join(DEMO_DIR, 'vendor', TGZ_NAME);

// A fixed name under the system temp directory keeps the npx cache key stable across runs and keeps the
// generated project far from the repository, so Node resolution can never reach the repository's node_modules.
const BASE = path.join(os.tmpdir(), 'blw-e2e-init');
const PKG = path.join(BASE, 'pkg');
const PROJECT = path.join(BASE, 'project');

const RUN_TIMEOUT_MS = 170_000;
// A cold npx install is slower than the second or two a warm cache needs.
const NPM_TIMEOUT_MS = 240_000;

// The seven files blw init writes, as paths in the project and in the demo project.
const PROJECT_FILES = [
  'package.json',
  'playwright.config.ts',
  'env.example.json',
  'baselines.json',
  'scenarios/demo.spec.ts',
  'monitor.bat',
  '.gitignore',
];

/** Finds the npm CLI script without ever spawning "npm" or "npx" by name. */
function findNpmCli(): string {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv !== undefined && fromEnv.endsWith('.js') && fs.existsSync(fromEnv)) return fromEnv;
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) throw new Error('cannot find the npm CLI script; run this through "npm run" or install npm next to node');
  return found;
}

function findNpxCli(): string {
  const found = path.join(path.dirname(findNpmCli()), 'npx-cli.js');
  if (!fs.existsSync(found)) throw new Error(`cannot find the npx CLI script next to npm: ${found}`);
  return found;
}

// The variables of the outer npm run point at the repository; the inner npm and npx must not see them.
function npmEnv(): NodeJS.ProcessEnv {
  const env = hermeticEnv();
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key) || key.toUpperCase() === 'INIT_CWD') delete env[key];
  }
  return env;
}

type NpmResult = { status: number | null; stdout: string; stderr: string };

function runNpm(args: string[], cwd: string): NpmResult {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: npmEnv(),
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const failure = result.error === undefined ? '' : `\n${result.error.message}`;
  return { status: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${failure}` };
}

const outputOf = (result: NpmResult): string => `${result.stdout}\n${result.stderr}`;

const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The SHA-256 of the two files of the repository that an install into the wrong place would change. */
function repositoryManifests(): Record<string, string> {
  return {
    'package.json': sha256(path.join(REPO_ROOT, 'package.json')),
    'package-lock.json': sha256(path.join(REPO_ROOT, 'package-lock.json')),
  };
}

const cliOf = (root: string): string => path.join(root, 'node_modules', 'baselinewatch', 'dist', 'cli.js');

/** Every entry below a directory: forward slashes, a trailing slash on directories, sorted. */
function listTree(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        found.push(`${relative}/`);
        walk(full);
      } else {
        found.push(relative);
      }
    }
  };
  walk(dir);
  return found.sort();
}

const inProject = (relative: string): string => path.join(PROJECT, ...relative.split('/'));

test.describe.serial('a project made by blw init', () => {
  let portal: RunningPortal;

  test.beforeAll(async () => {
    portal = await startPortal('ok');
  });

  test.afterAll(async () => {
    await portal.stop();
    try {
      fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Best effort: a file that is still locked is removed by the next run.
    }
  });

  test('npx --package <tgz> blw init in an empty directory creates the project', async () => {
    test.setTimeout(300_000);
    expect(fs.existsSync(TGZ), `${TGZ} is missing; run this through npm run e2e, which packs the core first`).toBe(true);
    fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    fs.mkdirSync(PKG, { recursive: true });
    fs.mkdirSync(PROJECT, { recursive: true });
    fs.copyFileSync(TGZ, path.join(PKG, TGZ_NAME));
    const manifestsBefore = repositoryManifests();

    const run = runNpm([findNpxCli(), '--yes', '--prefer-offline', '--package', `../pkg/${TGZ_NAME}`, 'blw', 'init'], PROJECT);
    expect(run.status, outputOf(run)).toBe(0);

    expect(listTree(PROJECT)).toEqual([
      '.gitignore',
      'baselines.json',
      'env.example.json',
      'monitor.bat',
      'package.json',
      'playwright.config.ts',
      'scenarios/',
      'scenarios/demo.spec.ts',
      'vendor/',
    ]);
    const ignored = fs.readFileSync(inProject('.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignored).toContain('env.json');
    expect(ignored).toContain('artifacts/');
    for (const file of PROJECT_FILES) {
      const expected = fs.readFileSync(path.join(DEMO_DIR, ...file.split('/')));
      expect(fs.readFileSync(inProject(file)).equals(expected), `${file} differs from its copy in the demo project`).toBe(true);
    }
    const manifest = JSON.parse(fs.readFileSync(inProject('package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.baselinewatch).toBe(`file:vendor/${TGZ_NAME}`);

    expect(run.stdout).toContain('Next steps:');
    const lines = linesOf(run.stdout);
    expect(lines.filter((line) => line.startsWith('RESULT=') || line.startsWith('REASON='))).toEqual([]);
    expect(repositoryManifests()).toEqual(manifestsBefore);
  });

  test('the new project installs from vendor/ and passes on the demo portal', async () => {
    test.setTimeout(300_000);
    const manifestsBefore = repositoryManifests();
    fs.copyFileSync(TGZ, inProject(`vendor/${TGZ_NAME}`));

    const install = runNpm([findNpmCli(), 'install', '--no-audit', '--no-fund', '--prefer-offline'], PROJECT);
    expect(install.status, outputOf(install)).toBe(0);
    // A link would make blw take the demo project for its root, so the core must be a real copy.
    const core = fs.lstatSync(inProject('node_modules/baselinewatch'));
    expect(core.isSymbolicLink()).toBe(false);
    expect(core.isDirectory()).toBe(true);
    // npm wrote the lock file; init does not.
    expect(fs.existsSync(inProject('package-lock.json'))).toBe(true);

    const env = await demoEnv({ 'node-1': portal.url });
    fs.writeFileSync(inProject('env.json'), `${JSON.stringify(env, null, 2)}\n`);
    const run = await runInDemo([cliOf(PROJECT), 'run'], { cwd: PROJECT, timeoutMs: RUN_TIMEOUT_MS });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.timedOut).toBe(false);
    expect(run.status, output).toBe(0);
    expect(linesOf(run.stdout).at(-1), output).toBe('RESULT=PASS');

    const summary = JSON.parse(fs.readFileSync(inProject('artifacts/summary.json'), 'utf8')) as {
      status: string;
      warnings: { code: string }[];
    };
    expect(summary.status).toBe('pass');
    expect(summary.warnings.map((warning) => warning.code)).not.toContain('launcher_outdated');

    const { DEMO_ACCOUNT } = await loadPortalModule();
    for (const text of [run.stdout, run.stderr]) {
      expect(text.includes(DEMO_ACCOUNT.login)).toBe(false);
      expect(text.includes(DEMO_ACCOUNT.password)).toBe(false);
    }
    expect(repositoryManifests()).toEqual(manifestsBefore);
  });
});
