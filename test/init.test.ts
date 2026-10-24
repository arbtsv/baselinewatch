// Tests for src/init.ts: blw init writes a monitoring project from the templates of the running core.
// Run: node --test test/init.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTemplate, TEMPLATE_FILES } from '../src/init.ts';
import { main, type RunDeps } from '../src/run.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-init-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const REPO_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

type InitHarness = { deps: RunDeps; lines: string[]; interruptHooks: number; exitHooks: number };

const refuse =
  (what: string) =>
  (): never => {
    throw new Error(`init must not ${what}`);
  };

// Dependencies for a command that is not a run: everything a run needs throws, except the two
// registrations, which are counted so a test can show that init made neither.
function initDeps(cliFile: string, cwd: string): InitHarness {
  const harness: InitHarness = {
    lines: [],
    interruptHooks: 0,
    exitHooks: 0,
    deps: {
      cliFile,
      now: refuse('read the clock'),
      sleep: refuse('wait'),
      print: (line) => {
        harness.lines.push(line);
      },
      prechecks: refuse('run the checks'),
      runPass: refuse('start Playwright'),
      onInterrupt: () => {
        harness.interruptHooks += 1;
        return () => {};
      },
      onExit: () => {
        harness.exitHooks += 1;
        return () => {};
      },
      pid: 1,
      isAlive: refuse('look at a process'),
      attachRedactor: refuse('attach a redactor'),
      platform: 'win32',
      zip: refuse('build a zip'),
      cwd: () => cwd,
    },
  };
  return harness;
}

const templateBytes = (source: string): Buffer => fs.readFileSync(path.join(REPO_ROOT, 'templates', ...source.split('/')));

describe('blw init through main', () => {
  test('writes every template file and an empty vendor folder, and prints the next steps', async () => {
    const harness = initDeps(path.join(REPO_ROOT, 'src', 'cli.ts'), WORK);
    const code = await main(['init', 'new-project'], harness.deps);
    assert.equal(code, 0, harness.lines.join('\n'));
    const project = path.join(WORK, 'new-project');
    for (const file of TEMPLATE_FILES) {
      const written = fs.readFileSync(path.join(project, ...file.target.split('/')));
      assert.ok(written.equals(renderTemplate(file, templateBytes(file.source), REPO_VERSION)), `${file.target} differs from its template`);
    }
    assert.deepEqual(fs.readdirSync(path.join(project, 'vendor')), []);
    for (const absent of ['env.json', 'package-lock.json', 'artifacts', 'install.bat', 'tsconfig.json']) {
      assert.equal(fs.existsSync(path.join(project, absent)), false, `${absent} must not be created`);
    }
    assert.ok(harness.lines.includes('  .gitignore'), harness.lines.join('\n'));
    assert.ok(harness.lines.some((line) => line.includes(`baselinewatch-${REPO_VERSION}.tgz`)), harness.lines.join('\n'));
    assert.equal(
      harness.lines.some((line) => line.startsWith('RESULT=') || line.startsWith('REASON=')),
      false,
      'init prints no machine line',
    );
    assert.equal(harness.interruptHooks, 0);
    assert.equal(harness.exitHooks, 0);
  });

  test('works from an npx cache laid out as node_modules/baselinewatch and creates no artifacts there', async () => {
    const cache = path.join(WORK, 'npx-cache');
    const packageDir = path.join(cache, 'node_modules', 'baselinewatch');
    fs.cpSync(path.join(REPO_ROOT, 'templates'), path.join(packageDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'baselinewatch', version: '0.1.0' }));
    const harness = initDeps(path.join(packageDir, 'dist', 'cli.js'), WORK);
    const code = await main(['init', 'npx-target'], harness.deps);
    assert.equal(code, 0, harness.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(WORK, 'npx-target', 'monitor.bat')));
    assert.equal(fs.existsSync(path.join(cache, 'artifacts')), false, 'no artifacts directory in the cache');
    assert.equal(harness.interruptHooks + harness.exitHooks, 0);
  });
});

