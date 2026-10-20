// Tests for src/process.ts: the Playwright argument list, the line relay and the child process runner.
// The child processes are small inline node scripts.
// Run: node --test test/process.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLineRelay, playwrightArgs, resolvePlaywrightCli, runChild } from '../src/process.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-process-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

let logCounter = 0;

// A log path inside a directory that does not exist yet.
function freshLog(): string {
  logCounter += 1;
  return path.join(WORK, `log-${logCounter}`, 'pass-1.stderr.log');
}

function node(source: string, log: string, extra: { watchdogMs?: number; signal?: AbortSignal } = {}): Promise<{
  lines: string[];
  run: Awaited<ReturnType<typeof runChild>>;
}> {
  const lines: string[] = [];
  return runChild({
    file: process.execPath,
    args: ['-e', source],
    cwd: WORK,
    env: { ...process.env },
    stderrLog: log,
    print: (line) => {
      lines.push(line);
    },
    watchdogMs: extra.watchdogMs ?? 60_000,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  }).then((run) => ({ lines, run }));
}

describe('playwrightArgs', () => {
  test('the CLI, test, the config of the root and one --project per project', () => {
    assert.deepEqual(playwrightArgs('C:/x/cli.js', '/p', ['a--n1', 'b--n2']), [
      'C:/x/cli.js',
      'test',
      `--config=${path.join('/p', 'playwright.config.ts')}`,
      '--project=a--n1',
      '--project=b--n2',
    ]);
  });

  test('without projects there is no --project', () => {
    const args = playwrightArgs('C:/x/cli.js', '/p', []);
    assert.equal(args.length, 3);
    assert.ok(!args.some((arg) => arg.startsWith('--project')));
  });
});

describe('resolvePlaywrightCli', () => {
  test('finds the CLI file of the Playwright that the project installs', () => {
    const cli = resolvePlaywrightCli(REPO_ROOT);
    assert.ok(path.isAbsolute(cli));
    assert.ok(fs.existsSync(cli));
    assert.equal(path.basename(cli), 'cli.js');
  });
});

describe('createLineRelay', () => {
  test('lines split across chunks come out whole, without carriage returns', () => {
    const printed: string[] = [];
    const relay = createLineRelay((line) => printed.push(line));
    relay.push('a\r\nb');
    relay.push('c\n');
    relay.push('d');
    relay.end();
    assert.deepEqual(printed, ['a', 'bc', 'd']);
  });

  test('an empty push prints nothing', () => {
    const printed: string[] = [];
    const relay = createLineRelay((line) => printed.push(line));
    relay.push('');
    relay.end();
    assert.deepEqual(printed, []);
  });

  test('a blank line is a line, and a trailing carriage return of the last piece is dropped', () => {
    const printed: string[] = [];
    const relay = createLineRelay((line) => printed.push(line));
    relay.push('x\n\ny\r');
    relay.end();
    assert.deepEqual(printed, ['x', '', 'y']);
  });
});

describe('runChild', () => {
  test('a multi-byte character split across chunks prints intact', async () => {
    // The word is written with escapes in both layers: the test file and the child script.
    const source = [
      "const bytes = Buffer.from('\\u041e\\u0442\\u0447\\u0451\\u0442\\n', 'utf8');",
      'process.stdout.write(bytes.subarray(0, 3));',
      'setTimeout(() => process.stdout.write(bytes.subarray(3)), 300);',
    ].join('\n');
    const { lines, run } = await node(source, freshLog());
    assert.deepEqual(lines, ['\u041e\u0442\u0447\u0451\u0442']);
    assert.equal(run.status, 0);
    assert.equal(run.timedOut, false);
    assert.equal(run.interrupted, false);
  });

  test('a last line without a line end is printed when the child closes', async () => {
    const { lines } = await node("process.stdout.write('one\\ntwo');", freshLog());
    assert.deepEqual(lines, ['one', 'two']);
  });

  test('standard error goes to the log file and never to print', async () => {
    const log = freshLog();
    const { lines } = await node("process.stderr.write('to-err');", log);
    assert.deepEqual(lines, []);
    assert.equal(fs.readFileSync(log, 'utf8'), 'to-err');
  });

  test('the watchdog kills a child that runs too long', async () => {
    const started = Date.now();
    const { run } = await node('setTimeout(() => {}, 60000);', freshLog(), { watchdogMs: 500 });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(run.timedOut, true);
    assert.equal(run.interrupted, false);
  });

  test('an abort signal kills the child and reports an interrupt', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const { run } = await node('setTimeout(() => {}, 60000);', freshLog(), { signal: controller.signal });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(run.interrupted, true);
    assert.equal(run.timedOut, false);
  });

  test('a signal that is already aborted kills the child right after it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const { run } = await node('setTimeout(() => {}, 60000);', freshLog(), { signal: controller.signal });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(run.interrupted, true);
  });
});
