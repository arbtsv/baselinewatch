// Tests for src/args.ts: blw run accepts only run, --help and --version.
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

  const REJECTED: Array<[string, string[]]> = [
    ['no argument', []],
    ['init', ['init']],
    ['a bare --help', ['--help']],
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

describe('USAGE_LINES', () => {
  test('starts with the usage line and lists both options', () => {
    assert.equal(USAGE_LINES[0], 'Usage: blw run [--help] [--version]');
    assert.ok(USAGE_LINES.some((line) => line.includes('--help')));
    assert.ok(USAGE_LINES.some((line) => line.includes('--version')));
  });

  test('is plain English without machine tokens', () => {
    for (const line of USAGE_LINES) {
      assert.match(line, /^[\x20-\x7e]+$/, line);
      assert.equal(line.includes('RESULT='), false, line);
      assert.equal(line.includes('REASON='), false, line);
    }
  });
});
