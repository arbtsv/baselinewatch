// Checks that a consumer gets real types from the packed core: the demo's own config and scenario
// typecheck against the installed declarations, and a deliberate type error is reported.
//
// Run: npm run e2e -- test/e2e/demo-types.spec.ts
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_DIR, REPO_ROOT, runInDemo } from '../helpers/demo.ts';

const TYPECHECK_DIR = path.join(DEMO_DIR, 'artifacts', 'typecheck');

function findTsc(): string {
  const require = createRequire(path.join(REPO_ROOT, 'package.json'));
  const manifestPath = require.resolve('typescript/package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { bin?: string | { tsc?: string } };
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc;
  if (entry === undefined) throw new Error('typescript declares no tsc entry in its package.json');
  return path.resolve(path.dirname(manifestPath), entry);
}

function writeTsconfig(name: string, files: string[]): string {
  fs.mkdirSync(TYPECHECK_DIR, { recursive: true });
  const file = path.join(TYPECHECK_DIR, name);
  const config = {
    compilerOptions: {
      noEmit: true,
      strict: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2023',
      skipLibCheck: true,
      types: [],
    },
    files,
  };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

const BAD_SCENARIO = [
  "import { test } from 'baselinewatch';",
  '',
  "test('wrong types', async ({ measure }) => {",
  '  await measure(42, async () => 1);',
  "  const count: number = await measure('a', async () => 'text');",
  '  return count;',
  '});',
  '',
].join('\n');

test('the demo config and scenario typecheck against the packed declarations', async () => {
  const tsconfig = writeTsconfig('tsconfig.json', ['../../playwright.config.ts', '../../scenarios/demo.spec.ts']);
  const run = await runInDemo([findTsc(), '-p', tsconfig]);
  expect(run.timedOut).toBe(false);
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});

test('a type error in a consumer file is reported', async () => {
  fs.mkdirSync(TYPECHECK_DIR, { recursive: true });
  fs.writeFileSync(path.join(TYPECHECK_DIR, 'bad.ts'), BAD_SCENARIO);
  const tsconfig = writeTsconfig('tsconfig.bad.json', ['./bad.ts']);
  const run = await runInDemo([findTsc(), '-p', tsconfig]);
  expect(run.timedOut).toBe(false);
  expect(run.status).not.toBe(0);
  const output = `${run.stdout}\n${run.stderr}`;
  expect(output).toContain('error TS');
  expect(output).toContain('bad.ts');
});
