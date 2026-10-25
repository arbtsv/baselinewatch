// Tests for src/init.ts: blw init writes a monitoring project from the templates of the running core.
// Run: node --test test/init.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { USAGE_LINES } from '../src/args.ts';
import { makeMissingDirectories, renderTemplate, runInit, TEMPLATE_FILES, VERSION_TOKEN, type InitDeps } from '../src/init.ts';
import { writeFileAtomic } from '../src/pass-file.ts';
import { main, type RunDeps } from '../src/run.ts';
import { TEMPLATE_VERSION } from '../src/template-version.ts';

// The template version and the SHA-256 of every template-owned source file under templates/. A refresh
// rewrites these files in projects that already exist, so a change to one of them needs a decision.
// If this record fails, a template-owned file changed: when the change matters to an existing project,
// raise TEMPLATE_VERSION in src/template-version.ts and the marker in both monitor.bat copies, then
// record the new version and hashes here. The bytes are fixed by .gitattributes (CRLF for the launcher,
// LF for gitignore) on every OS.
const TEMPLATE_RECORD = {
  version: 1,
  sha256: {
    'monitor.bat': 'c3825a48baffeda7b3c37384962b87eda7583a3eac4aa0771a9307dcfa556a30',
    gitignore: '0be9e1c74e339972ba35aa2712b29955e2e354c742c5d67ae451e7eb265e37c5',
  },
} as const;

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
    return { code: runInit({ dir, refresh: false }, deps), lines };
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

describe('a target whose root does not exist', () => {
  test('creating the directories stops at the root with a plain error', () => {
    const asked: string[] = [];
    const made: string[] = [];
    const target = path.join(path.parse(WORK).root, 'no', 'such', 'root');
    assert.throws(
      () =>
        makeMissingDirectories(target, made, {
          kindOf: (candidate) => {
            asked.push(candidate);
            return 'missing';
          },
          mkdir: refuse('create a directory'),
        }),
      (error: Error) => error.message === 'the root of the path does not exist' && !(error instanceof RangeError),
    );
    assert.deepEqual(made, []);
    assert.equal(asked.at(-1), path.parse(WORK).root);
    assert.ok(asked.length <= 4, asked.join(' '));
  });

  test('directories made before the root is reached are not reported as made', () => {
    const made: string[] = [];
    const root = path.parse(WORK).root;
    const present = new Set<string>([root]);
    const mkdir = (dir: string): void => {
      present.add(dir);
    };
    makeMissingDirectories(path.join(root, 'a', 'b'), made, {
      kindOf: (candidate) => (present.has(candidate) ? 'directory' : 'missing'),
      mkdir,
    });
    assert.deepEqual(made, [path.join(root, 'a'), path.join(root, 'a', 'b')]);
  });

  test('init into a drive that does not exist fails with one plain line and no stack overflow', { skip: process.platform !== 'win32' }, () => {
    const letter = [...'QRSTUVWXYZ'].find((candidate) => !fs.existsSync(`${candidate}:\\`));
    assert.ok(letter !== undefined, 'a free drive letter');
    const result = initInto(`${letter}:\\nonexistent-drive\\x`);
    assert.equal(result.code, 1, result.lines.join('\n'));
    const text = result.lines.join('\n');
    assert.match(text, /the root of the path does not exist/);
    assert.doesNotMatch(text, /call stack/i);
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

// Reads and writes a file as latin1, so every byte, CR LF pairs included, survives the round trip.
const editBytes = (file: string, change: (text: string) => string): void => {
  fs.writeFileSync(file, change(fs.readFileSync(file, 'latin1')), 'latin1');
};

describe('refresh', () => {
  test('lists an outdated launcher as replace, rewrites it from the template and leaves an up to date .gitignore', async () => {
    const project = freshDir('refresh-tracer');
    assert.equal(initInto(project).code, 0);
    const launcher = path.join(project, 'monitor.bat');
    editBytes(launcher, (text) => text.replace('rem blw-template: 1', 'rem blw-template: 0'));
    assert.ok(!fs.readFileSync(launcher).equals(templateBytes('monitor.bat')), 'the launcher is outdated before the refresh');

    const harness = initDeps(path.join(REPO_ROOT, 'src', 'cli.ts'), WORK);
    const code = await main(['init', project, '--refresh'], harness.deps);
    assert.equal(code, 0, harness.lines.join('\n'));
    assert.deepEqual(harness.lines, [
      `Refreshing the template files in ${project}:`,
      '  replace     monitor.bat',
      '  up to date  .gitignore',
      'Done: 1 written, 1 up to date.',
    ]);
    assert.ok(fs.readFileSync(launcher).equals(templateBytes('monitor.bat')));
    assert.equal(
      harness.lines.some((line) => line.startsWith('RESULT=') || line.startsWith('REASON=')),
      false,
      'refresh prints no machine line',
    );
    assert.equal(harness.interruptHooks + harness.exitHooks, 0);
  });
});

type RefreshOptions = { cwd?: string; version?: string; replaceFile?: InitDeps['replaceFile'] };

// Runs a refresh with the real templates and collects what it printed; an exception is reported as a code.
function refresh(dir: string | undefined, options: RefreshOptions = {}): InitResult {
  const lines: string[] = [];
  const deps: InitDeps = {
    packageDir: REPO_ROOT,
    version: options.version ?? REPO_VERSION,
    cwd: options.cwd ?? WORK,
    print: (line) => {
      lines.push(line);
    },
  };
  if (options.replaceFile !== undefined) {
    deps.replaceFile = options.replaceFile;
  }
  try {
    return { code: runInit({ dir, refresh: true }, deps), lines };
  } catch (error) {
    return { code: `threw: ${(error as Error).message}`, lines };
  }
}

// A project made by init: every file is as the templates write it.
function projectInto(name: string): string {
  const dir = freshDir(name);
  const result = initInto(dir);
  assert.equal(result.code, 0, result.lines.join('\n'));
  return dir;
}

const OWNED = [
  { target: 'monitor.bat', source: 'monitor.bat' },
  { target: '.gitignore', source: 'gitignore' },
] as const;
type OwnedState = 'missing' | 'outdated' | 'current';
const STATES: readonly OwnedState[] = ['missing', 'outdated', 'current'];
const ACTION: Record<OwnedState, string> = { missing: 'create', outdated: 'replace', current: 'up to date' };

function setState(dir: string, owned: (typeof OWNED)[number], state: OwnedState): void {
  const file = path.join(dir, owned.target);
  if (state === 'missing') {
    fs.rmSync(file);
  } else if (state === 'outdated') {
    fs.writeFileSync(file, `an older ${owned.target}\r\n`);
  } else {
    fs.writeFileSync(file, templateBytes(owned.source));
  }
}

const listLine = (action: string, target: string): string => `  ${action.padEnd(10)}  ${target}`;
const namesOf = (entries: readonly string[]): string[] => entries.map((entry) => entry.split(' ')[0] as string);

describe('refresh scope', () => {
  test('a missing .gitignore is created from the template', () => {
    const dir = projectInto('refresh-create-one');
    fs.rmSync(path.join(dir, '.gitignore'));
    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), [listLine('up to date', 'monitor.bat'), listLine('create', '.gitignore')]);
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore')).equals(templateBytes('gitignore')));
    assert.equal(result.lines.at(-1), 'Done: 1 written, 1 up to date.');
  });

  test('both template files missing are two create lines, the launcher first', () => {
    const dir = projectInto('refresh-create-both');
    fs.rmSync(path.join(dir, '.gitignore'));
    fs.rmSync(path.join(dir, 'monitor.bat'));
    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), [listLine('create', 'monitor.bat'), listLine('create', '.gitignore')]);
    assert.equal(result.lines.at(-1), 'Done: 2 written, 0 up to date.');
    assert.ok(fs.readFileSync(path.join(dir, 'monitor.bat')).equals(templateBytes('monitor.bat')));
  });

  test('files equal to their templates are up to date and nothing is written', () => {
    const dir = projectInto('refresh-current');
    const before = snapshot(dir);
    const calls: string[] = [];
    const result = refresh(dir, {
      replaceFile: (file) => {
        calls.push(file);
      },
    });
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(result.lines, [
      `Refreshing the template files in ${dir}:`,
      listLine('up to date', 'monitor.bat'),
      listLine('up to date', '.gitignore'),
      'Done: 0 written, 2 up to date.',
    ]);
    assert.deepEqual(calls, [], 'no file is rewritten when it already equals its template');
    assert.deepEqual(snapshot(dir), before);
  });

  test('a hand-edited .gitignore is replaced whole, with no backup and no temporary file', () => {
    const dir = projectInto('refresh-edited-gitignore');
    const names = fs.readdirSync(dir).sort();
    fs.appendFileSync(path.join(dir, '.gitignore'), 'notes/\n');
    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), [listLine('up to date', 'monitor.bat'), listLine('replace', '.gitignore')]);
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore')).equals(templateBytes('gitignore')));
    assert.deepEqual(fs.readdirSync(dir).sort(), names);
  });

  test('a .gitignore that differs only in CR LF line ends is replaced', () => {
    const dir = projectInto('refresh-crlf');
    const text = templateBytes('gitignore').toString('latin1').replaceAll('\n', '\r\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), text, 'latin1');
    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), [listLine('up to date', 'monitor.bat'), listLine('replace', '.gitignore')]);
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore')).equals(templateBytes('gitignore')));
  });

  test('an empty monitor.bat is replaced', () => {
    const dir = projectInto('refresh-empty-launcher');
    fs.writeFileSync(path.join(dir, 'monitor.bat'), '');
    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(listed(result.lines), [listLine('replace', 'monitor.bat'), listLine('up to date', '.gitignore')]);
    assert.ok(fs.readFileSync(path.join(dir, 'monitor.bat')).equals(templateBytes('monitor.bat')));
  });

  for (const first of STATES) {
    for (const second of STATES) {
      test(`the lines and the writes keep the manifest order: launcher ${first}, .gitignore ${second}`, () => {
        const dir = projectInto('refresh-order');
        setState(dir, OWNED[0], first);
        setState(dir, OWNED[1], second);
        const written: string[] = [];
        const result = refresh(dir, {
          replaceFile: (file, bytes) => {
            written.push(path.basename(file));
            writeFileAtomic(file, bytes);
          },
        });
        assert.equal(result.code, 0, result.lines.join('\n'));
        assert.deepEqual(listed(result.lines), [listLine(ACTION[first], 'monitor.bat'), listLine(ACTION[second], '.gitignore')]);
        assert.deepEqual(written, [first === 'current' ? [] : ['monitor.bat'], second === 'current' ? [] : ['.gitignore']].flat());
        const count = [first, second].filter((state) => state !== 'current').length;
        assert.equal(result.lines.at(-1), `Done: ${count} written, ${2 - count} up to date.`);
        for (const owned of OWNED) {
          assert.ok(fs.readFileSync(path.join(dir, owned.target)).equals(templateBytes(owned.source)), `${owned.target} equals its template`);
        }
      });
    }
  }

  test('the list is printed before the first write', () => {
    const dir = projectInto('refresh-list-first');
    setState(dir, OWNED[0], 'outdated');
    setState(dir, OWNED[1], 'outdated');
    const events: string[] = [];
    const code = runInit(
      { dir, refresh: true },
      {
        packageDir: REPO_ROOT,
        version: REPO_VERSION,
        cwd: WORK,
        print: (line) => {
          events.push(line.startsWith('  ') ? 'listed' : line.startsWith('Done') ? 'done' : 'header');
        },
        replaceFile: (file, bytes) => {
          events.push('write');
          writeFileAtomic(file, bytes);
        },
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(events, ['header', 'listed', 'listed', 'write', 'write', 'done']);
  });

  test('scenarios, env.json, baselines.json, package.json and vendor keep their bytes and nothing else appears', () => {
    const dir = projectInto('refresh-snapshot');
    fs.writeFileSync(path.join(dir, 'scenarios', 'extra.spec.ts'), '// my own scenario\n');
    fs.writeFileSync(path.join(dir, 'env.json'), '{"login":"demo-user","password":"placeholder-password"}\n');
    fs.writeFileSync(path.join(dir, 'baselines.json'), '{"demo":{"login_ms":300}}\n');
    fs.appendFileSync(path.join(dir, 'package.json'), '\n');
    fs.appendFileSync(path.join(dir, 'playwright.config.ts'), '// mine\n');
    fs.writeFileSync(path.join(dir, 'vendor', 'baselinewatch-0.1.0.tgz'), 'packed');
    fs.mkdirSync(path.join(dir, 'artifacts'));
    fs.writeFileSync(path.join(dir, 'artifacts', 'runs.csv'), 'run_id\n');
    setState(dir, OWNED[0], 'outdated');
    setState(dir, OWNED[1], 'outdated');
    const before = snapshot(dir);
    const ownedPaths = ['monitor.bat', '.gitignore'];
    const untouched = (entries: readonly string[]): string[] => entries.filter((entry) => !ownedPaths.includes(entry.split(' ')[0] as string));

    const result = refresh(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    const after = snapshot(dir);
    assert.deepEqual(namesOf(after), namesOf(before), 'the recursive file list is the same');
    assert.deepEqual(untouched(after), untouched(before), 'every other file keeps its bytes');
    for (const owned of OWNED) {
      assert.ok(fs.readFileSync(path.join(dir, owned.target)).equals(templateBytes(owned.source)));
    }
  });

  test('without a directory it refreshes the current directory', () => {
    const dir = projectInto('refresh-cwd');
    setState(dir, OWNED[0], 'outdated');
    const result = refresh(undefined, { cwd: dir });
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.equal(result.lines[0], `Refreshing the template files in ${dir}:`);
    assert.ok(fs.readFileSync(path.join(dir, 'monitor.bat')).equals(templateBytes('monitor.bat')));
  });

  test('a relative directory is resolved against the current directory', () => {
    const dir = projectInto('refresh-relative');
    setState(dir, OWNED[1], 'outdated');
    const result = refresh(path.basename(dir), { cwd: WORK });
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore')).equals(templateBytes('gitignore')));
  });

  test('a version that cannot name a vendored package does not stop a refresh', () => {
    const dir = projectInto('refresh-unknown-version');
    setState(dir, OWNED[0], 'outdated');
    const result = refresh(dir, { version: 'unknown' });
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.ok(fs.readFileSync(path.join(dir, 'monitor.bat')).equals(templateBytes('monitor.bat')));
  });

  test('a write that fails stops the refresh with its file named, and a file already replaced stays whole', () => {
    const dir = projectInto('refresh-write-fails');
    setState(dir, OWNED[0], 'outdated');
    setState(dir, OWNED[1], 'outdated');
    let calls = 0;
    const result = refresh(dir, {
      replaceFile: (file, bytes) => {
        calls += 1;
        if (calls === 2) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        writeFileAtomic(file, bytes);
      },
    });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.equal(result.lines.at(-1), 'blw init --refresh: writing .gitignore failed (EACCES).');
    assert.ok(fs.readFileSync(path.join(dir, 'monitor.bat')).equals(templateBytes('monitor.bat')));
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'an older .gitignore\r\n');
  });
});

describe('refresh refusals', () => {
  test('an empty directory is not a project: both files are named, nothing is written', () => {
    const dir = freshDir('refresh-empty');
    fs.mkdirSync(dir);
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.equal(result.lines.length, 1);
    assert.ok((result.lines[0] ?? '').includes('package.json and playwright.config.ts missing'), result.lines.join('\n'));
    assert.ok((result.lines[0] ?? '').includes('Nothing was written'), result.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a directory with only package.json names playwright.config.ts alone', () => {
    const dir = freshDir('refresh-half');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    const line = result.lines[0] ?? '';
    assert.ok(line.includes('playwright.config.ts missing'), line);
    assert.equal(line.includes('package.json'), false, line);
    assert.deepEqual(fs.readdirSync(dir), ['package.json']);
  });

  test('a package.json that is a directory does not count as a project file', () => {
    const dir = projectInto('refresh-package-dir');
    fs.rmSync(path.join(dir, 'package.json'));
    fs.mkdirSync(path.join(dir, 'package.json'));
    setState(dir, OWNED[0], 'outdated');
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok((result.lines[0] ?? '').includes('package.json missing'), result.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(dir, 'monitor.bat'), 'utf8'), 'an older monitor.bat\r\n');
  });

  test('a directory that does not exist is refused and is not created', () => {
    const dir = freshDir('refresh-absent');
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('Nothing was written')), result.lines.join('\n'));
    assert.equal(fs.existsSync(dir), false);
  });

  test('a directory named monitor.bat is refused before anything is listed or written', () => {
    const dir = projectInto('refresh-launcher-dir');
    fs.rmSync(path.join(dir, 'monitor.bat'));
    fs.mkdirSync(path.join(dir, 'monitor.bat'));
    setState(dir, OWNED[1], 'outdated');
    const before = snapshot(dir);
    const calls: string[] = [];
    const result = refresh(dir, {
      replaceFile: (file) => {
        calls.push(file);
      },
    });
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('monitor.bat') && line.includes('Nothing was written')), result.lines.join('\n'));
    assert.equal(result.lines.some((line) => line.startsWith('Refreshing')), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshot(dir), before, 'the outdated .gitignore is not written either');
  });

  test('a link named .gitignore is refused, an outdated launcher is not written and the link target is untouched', () => {
    const dir = projectInto('refresh-gitignore-link');
    const outside = freshDir('refresh-link-outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    fs.rmSync(path.join(dir, '.gitignore'));
    link(outside, path.join(dir, '.gitignore'));
    setState(dir, OWNED[0], 'outdated');
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.ok(result.lines.some((line) => line.includes('.gitignore') && line.includes('Nothing was written')), result.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(dir, 'monitor.bat'), 'utf8'), 'an older monitor.bat\r\n');
    assert.deepEqual(fs.readdirSync(outside), ['precious.txt']);
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  });

  test('a link named monitor.bat is refused and the link target is untouched', () => {
    const dir = projectInto('refresh-launcher-link');
    const outside = freshDir('refresh-launcher-outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(dir, 'monitor.bat'));
    link(outside, path.join(dir, 'monitor.bat'));
    const result = refresh(dir);
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

describe('refresh arguments through main', () => {
  test('init --refresh in an empty directory exits 1 and prints no machine line', async () => {
    const cwd = freshDir('refresh-main-empty');
    fs.mkdirSync(cwd);
    const harness = initDeps(path.join(REPO_ROOT, 'src', 'cli.ts'), cwd);
    assert.equal(await main(['init', '--refresh'], harness.deps), 1);
    assert.ok(harness.lines.some((line) => line.includes('is not a monitoring project')), harness.lines.join('\n'));
    assert.equal(harness.lines.some((line) => line.startsWith('RESULT=') || line.startsWith('REASON=')), false);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});

describe('the record of the template-owned files', () => {
  const ownedSources = TEMPLATE_FILES.filter((file) => file.owner === 'template').map((file) => file.source);

  test('the recorded version is the template version of the core', () => {
    assert.equal(TEMPLATE_RECORD.version, TEMPLATE_VERSION, 'raise TEMPLATE_VERSION and the record together');
  });

  test('the record lists exactly the template-owned sources', () => {
    assert.deepEqual(Object.keys(TEMPLATE_RECORD.sha256).sort(), [...ownedSources].sort());
  });

  for (const source of ownedSources) {
    test(`the SHA-256 of templates/${source} equals the record`, () => {
      const actual = createHash('sha256').update(templateBytes(source)).digest('hex');
      assert.equal(
        actual,
        (TEMPLATE_RECORD.sha256 as Record<string, string>)[source],
        `templates/${source} changed: when the change matters to an existing project raise TEMPLATE_VERSION in src/template-version.ts and the marker in both monitor.bat copies, then record the new hashes here`,
      );
    });
  }
});

// The numbers of a version or of a comparator operand, a missing part counting as zero.
const numbersOf = (text: string): number[] => {
  const parts = text.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};

const compareVersions = (left: number[], right: number[]): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

// True when the version satisfies every comparator of a range such as ">=1.61 <2". Only the operators
// >=, <=, >, < and = with up to three numeric parts are understood; anything else throws.
function satisfiesRange(version: string, range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator);
      if (match === null) {
        throw new Error(`unsupported comparator in the range: ${comparator}`);
      }
      const order = compareVersions(numbersOf(version), numbersOf(match[2] as string));
      switch (match[1] ?? '=') {
        case '>=':
          return order >= 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '<':
          return order < 0;
        default:
          return order === 0;
      }
    });
}

const DEMO_DIR = path.join(REPO_ROOT, 'examples', 'demo-portal');
const LAUNCHER_NAME = 'monitor.bat';

// The files git tracks under a folder of the repository, relative to that folder; a missing git fails the test.
function trackedFiles(folder: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--', folder], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'git must be available to list the tracked files');
  assert.equal(result.status, 0, result.stderr);
  const prefix = `${folder}/`;
  return result.stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(prefix.length));
}

// Every file under a folder, relative with forward slashes.
function filesUnder(folder: string): string[] {
  return fs
    .readdirSync(folder, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => fs.statSync(path.join(folder, entry)).isFile())
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
}

describe('the templates and the demo project', () => {
  test('the manifest lists exactly the files under templates', () => {
    assert.deepEqual([...TEMPLATE_FILES.map((file) => file.source)].sort(), filesUnder(path.join(REPO_ROOT, 'templates')));
  });

  test('no template and no demo file except the launchers holds a carriage return', () => {
    const files = [
      ...filesUnder(path.join(REPO_ROOT, 'templates')).map((file) => path.join(REPO_ROOT, 'templates', ...file.split('/'))),
      ...trackedFiles('examples/demo-portal').map((file) => path.join(DEMO_DIR, ...file.split('/'))),
    ].filter((file) => path.basename(file) !== LAUNCHER_NAME);
    assert.ok(files.length >= 13, `expected at least 13 files, found ${files.length}`);
    const withCarriageReturn = files.filter((file) => fs.readFileSync(file).includes(0x0d)).map((file) => path.relative(REPO_ROOT, file));
    assert.deepEqual(withCarriageReturn, [], 'check the folder out again after the attribute change');
  });

  test('every manifest target equals the file of the demo project byte for byte', () => {
    const dir = freshDir('demo-equal');
    const result = initInto(dir);
    assert.equal(result.code, 0, result.lines.join('\n'));
    const differing = MANIFEST_TARGETS.filter(
      (target) => !fs.readFileSync(path.join(dir, ...target.split('/'))).equals(fs.readFileSync(path.join(DEMO_DIR, ...target.split('/')))),
    );
    assert.deepEqual(differing, [], `these targets differ from examples/demo-portal: ${differing.join(', ')}`);
  });

  test('git tracks exactly the init targets and server.mjs in the demo project', () => {
    assert.deepEqual(trackedFiles('examples/demo-portal').sort(), [...MANIFEST_TARGETS, 'server.mjs'].sort());
  });

  test('the package template holds the token once and renders the manifest of the project', () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'package.json'), 'utf8');
    assert.equal(template.split(VERSION_TOKEN).length - 1, 1);
    const source = TEMPLATE_FILES.find((file) => file.source === 'package.json') as (typeof TEMPLATE_FILES)[number];
    const manifest = JSON.parse(renderTemplate(source, Buffer.from(template, 'utf8'), '0.1.0').toString('utf8')) as {
      name: string;
      private: boolean;
      type: string;
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.name, 'monitoring-project');
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, 'module');
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@playwright/test', 'baselinewatch']);
    assert.equal(manifest.dependencies['baselinewatch'], 'file:vendor/baselinewatch-0.1.0.tgz');
    const core = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const pin = manifest.dependencies['@playwright/test'] as string;
    assert.equal(pin, core.devDependencies['@playwright/test']);
    assert.ok(satisfiesRange(pin, core.peerDependencies['@playwright/test'] as string), `${pin} is outside the peer range`);
  });

  test('the range helper rejects a version below and a version above the peer range', () => {
    assert.equal(satisfiesRange('1.60.9', '>=1.61 <2'), false);
    assert.equal(satisfiesRange('2.0.0', '>=1.61 <2'), false);
    assert.equal(satisfiesRange('1.61.0', '>=1.61 <2'), true);
    assert.equal(satisfiesRange('1.64.1', '>=1.61 <2'), true);
  });

  test('the starter scenario starts with the two header lines and measures the login', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'scenarios', 'demo.spec.ts'), 'utf8').split('\n');
    assert.equal(lines[0], '// The demo scenario: it signs in to the invented demo portal and measures three steps.');
    assert.equal(lines[1], '// Replace the steps with those of your own portal; every measure() name needs an entry in baselines.json.');
    assert.equal(lines[2], '');
    assert.ok(lines.some((line) => line.includes("measure('login_ms'")));
  });

  test('the gitignore template lists exactly the four ignored paths', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, 'templates', 'gitignore'), 'utf8').split('\n');
    assert.deepEqual(lines.filter((line) => line !== ''), ['env.json', 'artifacts/', 'node/', 'node_modules/']);
  });
});
