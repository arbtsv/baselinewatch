// Tests for src/args.ts: blw accepts the commands run and init and the options --help and --version.
// Run: node --test test/args.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunArgs, USAGE_LINES } from '../src/args.ts';

describe('parseRunArgs', () => {
  test('run alone starts a run', () => {
    assert.deepEqual(parseRunArgs(['run']), { kind: 'run' });
  });

  test('run --help asks for the help text', () => {
    assert.deepEqual(parseRunArgs(['run', '--help']), { kind: 'help' });
  });

  test('run --version asks for the version', () => {
    assert.deepEqual(parseRunArgs(['run', '--version']), { kind: 'version' });
  });

  test('--help and -h as the first argument ask for the help text', () => {
    assert.deepEqual(parseRunArgs(['--help']), { kind: 'help' });
    assert.deepEqual(parseRunArgs(['-h']), { kind: 'help' });
  });

  test('--version and -v as the first argument ask for the version', () => {
    assert.deepEqual(parseRunArgs(['--version']), { kind: 'version' });
    assert.deepEqual(parseRunArgs(['-v']), { kind: 'version' });
  });

  test('the first argument decides: words after it are ignored', () => {
    assert.deepEqual(parseRunArgs(['--version', 'extra']), { kind: 'version' });
    assert.deepEqual(parseRunArgs(['-h', '--bogus']), { kind: 'help' });
  });

  test('init alone writes into the current directory', () => {
    assert.deepEqual(parseRunArgs(['init']), { kind: 'init', dir: undefined, refresh: false });
  });

  test('init takes one directory', () => {
    assert.deepEqual(parseRunArgs(['init', 'monitoring']), { kind: 'init', dir: 'monitoring', refresh: false });
  });

  test('init --refresh refreshes the current directory', () => {
    assert.deepEqual(parseRunArgs(['init', '--refresh']), { kind: 'init', dir: undefined, refresh: true });
  });

  test('init with a directory and --refresh refreshes that directory', () => {
    assert.deepEqual(parseRunArgs(['init', 'proj', '--refresh']), { kind: 'init', dir: 'proj', refresh: true });
    assert.deepEqual(parseRunArgs(['init', '--refresh', 'proj']), { kind: 'init', dir: 'proj', refresh: true });
  });

  const REJECTED: Array<[string, string[]]> = [
    ['no argument', []],
    ['another command', ['report']],
    ['an unknown option', ['run', '--bogus']],
    ['a Playwright option', ['run', '--retries=1']],
    ['a project filter', ['run', '--project=x']],
    ['a value on --help', ['run', '--help=yes']],
    ['a value on --version', ['run', '--version=1']],
    ['an extra positional', ['run', 'extra']],
    ['a positional after a known option', ['run', '--help', 'extra']],
    ['a positional after the option terminator', ['run', '--', 'extra']],
    ['a short option', ['run', '-h']],
    ['a short version option under run', ['run', '-v']],
    ['a value on a top-level --help', ['--help=yes']],
  ];

  for (const [name, argv] of REJECTED) {
    test(`${name} is a usage problem`, () => {
      const parsed = parseRunArgs(argv);
      assert.equal(parsed.kind, 'usage');
      assert.ok(parsed.kind === 'usage' && parsed.problem.length > 0, 'the problem text is not empty');
      assert.match(parsed.kind === 'usage' ? parsed.problem : '', /^[\x20-\x7e]+$/, 'plain printable English');
    });
  }

  test('the problem names an unknown option but nothing more of the input', () => {
    const parsed = parseRunArgs(['run', '--bogus=secret-looking-value']);
    assert.equal(parsed.kind, 'usage');
    const problem = parsed.kind === 'usage' ? parsed.problem : '';
    assert.ok(problem.includes('--bogus'), problem);
    assert.equal(problem.includes('secret-looking-value'), false, problem);
  });

  test('an unknown command is not echoed', () => {
    const parsed = parseRunArgs(['secret-looking-command']);
    assert.equal(parsed.kind, 'usage');
    assert.equal(parsed.kind === 'usage' && parsed.problem.includes('secret-looking-command'), false);
  });

  test('the input array is not modified', () => {
    const argv = ['run', '--help'];
    parseRunArgs(argv);
    assert.deepEqual(argv, ['run', '--help']);
  });
});

describe('parseRunArgs for init', () => {
  const PROBLEMS: Array<[string, string[]]> = [
    ['a second positional', ['init', 'a', 'b']],
    ['an empty directory argument', ['init', '']],
    ['--version', ['init', '--version']],
    ['the short option -h', ['init', '-h']],
    ['an unknown option', ['init', '--bogus']],
    ['a value on --help', ['init', '--help=yes']],
  ];

  for (const [name, argv] of PROBLEMS) {
    test(`init with ${name} is an init usage problem in plain English`, () => {
      const parsed = parseRunArgs(argv);
      assert.equal(parsed.kind, 'init_usage');
      const problem = parsed.kind === 'init_usage' ? parsed.problem : '';
      assert.ok(problem.length > 0);
      assert.match(problem, /^[\x20-\x7e]+$/, 'plain printable English');
    });
  }

  test('init names an unknown option but not its value', () => {
    const parsed = parseRunArgs(['init', '--bogus=secret-looking-value']);
    assert.equal(parsed.kind, 'init_usage');
    const problem = parsed.kind === 'init_usage' ? parsed.problem : '';
    assert.ok(problem.includes('--bogus'), problem);
    assert.equal(problem.includes('secret-looking-value'), false, problem);
  });

  test('init does not echo a second directory', () => {
    const parsed = parseRunArgs(['init', 'secret-dir', 'other-secret-dir']);
    assert.equal(parsed.kind, 'init_usage');
    assert.equal(parsed.kind === 'init_usage' && parsed.problem.includes('secret'), false);
  });

  test('init --help asks for the help text', () => {
    assert.deepEqual(parseRunArgs(['init', '--help']), { kind: 'help' });
  });

  test('init with a directory and --help asks for the help text', () => {
    assert.deepEqual(parseRunArgs(['init', 'monitoring', '--help']), { kind: 'help' });
  });
});

describe('USAGE_LINES', () => {
  test('names the init command on a line of its own and keeps the run line first', () => {
    assert.equal(USAGE_LINES[0], 'Usage: blw run [--help] [--version]');
    assert.ok(USAGE_LINES.includes('       blw init [dir] [--refresh]'));
    assert.ok(USAGE_LINES.some((line) => line.startsWith('  --refresh') && line.includes('monitor.bat') && line.includes('.gitignore')));
  });

  test('starts with the usage line and lists both options', () => {
    assert.equal(USAGE_LINES[0], 'Usage: blw run [--help] [--version]');
    assert.ok(USAGE_LINES.some((line) => line.includes('--help')));
    assert.ok(USAGE_LINES.some((line) => line.includes('--version')));
  });

  test('names the four top-level spellings', () => {
    assert.ok(USAGE_LINES.some((line) => line.includes('blw --help | -h | --version | -v')));
  });

  test('is plain English without machine tokens', () => {
    for (const line of USAGE_LINES) {
      assert.match(line, /^[\x20-\x7e]+$/, line);
      assert.equal(line.includes('RESULT='), false, line);
      assert.equal(line.includes('REASON='), false, line);
    }
  });
});
