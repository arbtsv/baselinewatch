// Checks that the demo project consumes the packed core the way an integrator
// would: one real copy of Playwright, a fresh install and the pinned version.
//
// Run: npm run e2e -- test/e2e/single-copy.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_DIR,
  DEMO_ENV_FILE,
  REPO_ROOT,
  demoEnv,
  runDemoPlaywright,
  runInDemo,
  withDemoEnv,
} from '../helpers/demo.ts';

const SINGLE_COPY_SCRIPT = [
  "import { createRequire } from 'node:module';",
  "import { realpathSync } from 'node:fs';",
  "import path from 'node:path';",
  "const req = createRequire(path.resolve('package.json'));",
  "const fromProject = realpathSync(req.resolve('@playwright/test/package.json'));",
  "const corePackage = req.resolve('baselinewatch/package.json');",
  "const fromCore = realpathSync(createRequire(corePackage).resolve('@playwright/test/package.json'));",
  "const core = await import('baselinewatch');",
  'console.log(JSON.stringify({ fromProject, fromCore, judgeType: typeof core.judge }));',
].join('\n');

function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
}

test('one copy of @playwright/test', async () => {
  const run = await runInDemo(['--input-type=module', '-e', SINGLE_COPY_SCRIPT]);
  expect(run.status, run.stderr).toBe(0);
  const seen = JSON.parse(run.stdout) as { fromProject: string; fromCore: string; judgeType: string };
  expect(seen.fromCore).toBe(seen.fromProject);
  expect(seen.judgeType).toBe('function');
});

test('installed core equals the fresh build', () => {
  const built = path.join(REPO_ROOT, 'dist');
  const installed = path.join(DEMO_DIR, 'node_modules', 'baselinewatch', 'dist');
  const files = listFiles(built);
  expect(files.length).toBeGreaterThan(0);
  for (const relative of files) {
    const copy = path.join(installed, relative);
    expect(fs.existsSync(copy), `${relative} is missing from the installed core`).toBe(true);
    expect(
      fs.readFileSync(copy).equals(fs.readFileSync(path.join(built, relative))),
      `${relative} differs from the fresh build`,
    ).toBe(true);
  }
});

test('the demo runs the pinned Playwright', async () => {
  const run = await runDemoPlaywright(['--version']);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('1.64.1');
});

test('withDemoEnv restores env.json', async () => {
  const before = fs.existsSync(DEMO_ENV_FILE) ? fs.readFileSync(DEMO_ENV_FILE) : null;
  const env = await demoEnv({ 'node-1': 'http://127.0.0.1:1/' });
  await withDemoEnv(env, async () => {
    const inside = JSON.parse(fs.readFileSync(DEMO_ENV_FILE, 'utf8')) as typeof env;
    expect(inside.scenarios.demo?.nodes['node-1']).toBe('http://127.0.0.1:1/');
  });
  if (before === null) expect(fs.existsSync(DEMO_ENV_FILE)).toBe(false);
  else expect(fs.readFileSync(DEMO_ENV_FILE).equals(before)).toBe(true);
});
