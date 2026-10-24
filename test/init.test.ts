// Tests for src/init.ts: blw init writes a monitoring project from the templates of the running core.
// Run: node --test test/init.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USAGE_LINES } from '../src/args.ts';
import { renderTemplate, runInit, TEMPLATE_FILES, type InitDeps } from '../src/init.ts';
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


let counter = 0;
const freshDir = (name: string): string => {
  counter += 1;
  return path.join(WORK, `${name}-${counter}`);
};

const MANIFEST_TARGETS = TEMPLATE_FILES.map((file) => file.target);

type InitResult = { code: 0 | 1 | string; lines: string[] };

// Runs init into a directory with the real templates and collects what it printed. An exception is
// reported as a code of its own, so a test fails on its assertion and not on the way out of the call.
function initInto(dir: string, options: { version?: string; writeFile?: InitDeps['writeFile'] } = {}): InitResult {
  const lines: string[] = [];
  const deps: InitDeps = {
    packageDir: REPO_ROOT,
    version: options.version ?? REPO_VERSION,
    cwd: WORK,
    print: (line) => {
      lines.push(line);
    },
  };
  if (options.writeFile !== undefined) {
    deps.writeFile = options.writeFile;
  }
  try {
    return { code: runInit({ dir }, deps), lines };
  } catch (error) {
    return { code: `threw: ${(error as Error).message}`, lines };
  }
}

// Every entry below dir with its kind and, for a file, its bytes; a link is recorded and never followed.
function snapshot(dir: string): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(dir, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push(`${relative} link`);
      } else if (stat.isDirectory()) {
        entries.push(`${relative} dir`);
        walk(full);
      } else {
        entries.push(`${relative} file ${fs.readFileSync(full).toString('hex')}`);
      }
    }
  };
  walk(dir);
  return entries;
}

const listed = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('  '));
const link = (target: string, at: string): void => {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
};

describe('refusal', () => {
  test('an existing package.json is listed, nothing is written and no vendor folder appears', () => {
    const dir = freshDir('refuse-one');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), 'mine');
    const before = snapshot(dir);
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.includes('  package.json'), result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('Nothing was written')), result.lines.join('\n'));
    assert.deepEqual(snapshot(dir), before);
  });

  test('two conflicts are listed in manifest order, one line each', () => {
    const dir = freshDir('refuse-order');
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scenarios', 'demo.spec.ts'), 'mine');
    fs.writeFileSync(path.join(dir, 'package.json'), 'mine');
    const result = initInto(dir);
    assert.equal(result.code, 1);
    assert.deepEqual(listed(result.lines), ['  package.json', '  scenarios/demo.spec.ts']);
  });

  test('a directory named like a target and a link named like a target are conflicts and are left alone', () => {
    const dir = freshDir('refuse-kinds');
    const outside = freshDir('refuse-outside');
    fs.mkdirSync(path.join(dir, 'baselines.json'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    link(outside, path.join(dir, 'monitor.bat'));
    const before = snapshot(dir);
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), ['  baselines.json', '  monitor.bat']);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
    assert.deepEqual(fs.readdirSync(outside), ['precious.txt']);
  });

  test('a file named scenarios is the conflict scenarios and nothing is written', () => {
    const dir = freshDir('refuse-scenarios');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'scenarios'), 'mine');
    const before = snapshot(dir);
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), ['  scenarios']);
    assert.deepEqual(snapshot(dir), before);
  });

  test('a link named scenarios is a conflict and is not followed', () => {
    const dir = freshDir('refuse-scenarios-link');
    const outside = freshDir('refuse-scenarios-outside');
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    link(outside, path.join(dir, 'scenarios'));
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), ['  scenarios']);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('a file named vendor is the conflict vendor and nothing is written', () => {
    const dir = freshDir('refuse-vendor');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'vendor'), 'mine');
    const before = snapshot(dir);
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), ['  vendor']);
    assert.deepEqual(snapshot(dir), before);
  });

  test('a directory that holds only unrelated files is accepted and they stay unchanged', () => {
    const dir = freshDir('accept-unrelated');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'my notes');
    const result = initInto(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'), '[core]');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'my notes');
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
  });

  test('an existing vendor folder keeps its contents', () => {
    const dir = freshDir('accept-vendor');
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'baselinewatch-0.1.0.tgz'), 'packed');
    const result = initInto(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(dir, 'vendor', 'baselinewatch-0.1.0.tgz'), 'utf8'), 'packed');
  });

  test('a directory argument that is a regular file is refused and the file is unchanged', () => {
    const file = freshDir('refuse-file');
    fs.writeFileSync(file, 'mine');
    const result = initInto(file);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('is not a directory')), result.lines.join('\n'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
  });

  test('a missing nested directory is created with its parents', () => {
    const dir = path.join(freshDir('nested'), 'b', 'c');
    const result = initInto(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'monitor.bat')));
  });

  test('a second init on the same directory is refused with all seven targets and changes no byte', () => {
    const dir = freshDir('twice');
    assert.equal(initInto(dir).code, 0);
    const before = snapshot(dir);
    const result = initInto(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), MANIFEST_TARGETS.map((target) => `  ${target}`));
    assert.deepEqual(snapshot(dir), before);
  });
});

describe('the core version', () => {
  for (const version of ['unknown', '1.2', '', '1.2.3"', '1.2.3\n', '{{CORE_VERSION}}']) {
    test(`version ${JSON.stringify(version)} stops init before the first directory`, () => {
      const dir = path.join(freshDir('version'), 'inner');
      const result = initInto(dir, { version });
      assert.equal(result.code, 1, result.lines.join('\n'));
      assert.ok(result.lines.some((line) => line.includes('Nothing was written')), result.lines.join('\n'));
      assert.equal(fs.existsSync(dir), false, 'the target directory must not be created');
      assert.equal(fs.existsSync(path.dirname(dir)), false, 'no parent directory must be created');
    });
  }

  test('a pre-release version is accepted and named in package.json', () => {
    const dir = freshDir('prerelease');
    const result = initInto(dir, { version: '1.2.3-rc.1' });
    assert.equal(result.code, 0, result.lines.join('\n'));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.equal(manifest.dependencies['baselinewatch'], 'file:vendor/baselinewatch-1.2.3-rc.1.tgz');
  });
});

describe('rollback', () => {
  // A writer that behaves like the default one until the n-th call, then runs what the test says.
  const failingOn = (nth: number, onFail: (file: string, bytes: Uint8Array) => void): InitDeps['writeFile'] => {
    let calls = 0;
    return (file, bytes) => {
      calls += 1;
      if (calls === nth) {
        onFail(file, bytes);
        return;
      }
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    };
  };
  const denied = (): never => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };

  test('a write that fails removes every file and folder this run created, and the new target folder', () => {
    const dir = freshDir('rollback-new');
    const result = initInto(dir, { writeFile: failingOn(4, denied) });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('baselines.json') && line.includes('EACCES')), result.lines.join('\n'));
    assert.equal(fs.existsSync(dir), false, 'the folder this run created is removed');
  });

  test('every missing parent this run created is removed again', () => {
    const top = freshDir('rollback-parents');
    const result = initInto(path.join(top, 'b', 'c'), { writeFile: failingOn(2, denied) });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.equal(fs.existsSync(top), false);
  });

  test('a target folder that existed before stays with its own files', () => {
    const dir = freshDir('rollback-existing');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'my notes');
    const result = initInto(dir, { writeFile: failingOn(4, denied) });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'my notes');
  });

  test('a failure in the nested folder leaves neither scenarios nor vendor behind', () => {
    const dir = freshDir('rollback-nested');
    fs.mkdirSync(dir);
    const result = initInto(dir, { writeFile: failingOn(5, denied) });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a file that somebody else created after the check keeps its bytes (EEXIST)', () => {
    const dir = freshDir('rollback-race');
    const result = initInto(dir, {
      writeFile: failingOn(3, (file, bytes) => {
        fs.writeFileSync(file, 'the other writer');
        fs.writeFileSync(file, bytes, { flag: 'wx' });
      }),
    });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('env.example.json') && line.includes('EEXIST')), result.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(dir), ['env.example.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'env.example.json'), 'utf8'), 'the other writer');
  });
});

describe('init arguments through main', () => {
  test('a second directory is an init usage problem: exit 1, the usage lines, no run record, nothing created', async () => {
    const cwd = freshDir('usage-cwd');
    fs.mkdirSync(cwd);
    const harness = initDeps(path.join(REPO_ROOT, 'src', 'cli.ts'), cwd);
    const code = await main(['init', 'a', 'b'], harness.deps);
    assert.equal(code, 1);
    assert.ok((harness.lines[0] ?? '').startsWith('blw init:'), harness.lines.join('\n'));
    assert.deepEqual(harness.lines.slice(1), [...USAGE_LINES]);
    assert.equal(harness.lines.some((line) => line.startsWith('RESULT=') || line.startsWith('REASON=')), false);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  test('init --help prints the usage lines and exits 0', async () => {
    const harness = initDeps(path.join(REPO_ROOT, 'src', 'cli.ts'), WORK);
    assert.equal(await main(['init', '--help'], harness.deps), 0);
    assert.deepEqual(harness.lines, [...USAGE_LINES]);
  });
});
