// Tests for src/process.ts: the Playwright argument list, the line relay and the child process runner.
// The child processes are small inline node scripts.
// Run: node --test test/process.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  createLineRelay,
  interruptSignals,
  playwrightArgs,
  resolvePlaywrightCli,
  runChild,
  taskkillPath,
} from '../src/process.ts';

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

describe('process lifetime', () => {
  test('SIGHUP interrupts a run off Windows and not on Windows', () => {
    const posix = interruptSignals('linux');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      assert.ok(posix.includes(signal as NodeJS.Signals), `${signal} is missing from the list for linux`);
    }
    const windows = interruptSignals('win32');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      assert.ok(windows.includes(signal as NodeJS.Signals), `${signal} is missing from the list for win32`);
    }
    assert.equal(windows.includes('SIGHUP'), false);
  });

  test('taskkill is named by its full path under the system directory', () => {
    assert.equal(taskkillPath({ SystemRoot: 'D:\\OS' }), 'D:\\OS\\System32\\taskkill.exe');
    assert.equal(taskkillPath({ windir: 'E:\\Win' }), 'E:\\Win\\System32\\taskkill.exe');
    assert.equal(taskkillPath({ SystemRoot: '', windir: 'E:\\Win' }), 'E:\\Win\\System32\\taskkill.exe');
    assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe');
  });

  test('a running child holds one extra exit listener that is gone after it ended', async () => {
    const before = process.listenerCount('exit');
    const controller = new AbortController();
    const running = node('setTimeout(() => {}, 60000);', freshLog(), { signal: controller.signal });
    assert.equal(process.listenerCount('exit'), before + 1);
    setTimeout(() => controller.abort(), 300);
    await running;
    assert.equal(process.listenerCount('exit'), before);
  });

  test('a child that cannot start leaves no exit listener behind', async () => {
    const before = process.listenerCount('exit');
    await assert.rejects(
      runChild({
        file: path.join(WORK, 'no-such-program'),
        args: [],
        cwd: WORK,
        env: { ...process.env },
        stderrLog: freshLog(),
        print: () => {},
        watchdogMs: 60_000,
      }),
    );
    assert.equal(process.listenerCount('exit'), before);
  });

  test('a parent that ends abruptly leaves no child behind', async () => {
    const pidFile = path.join(WORK, 'abrupt-parent.pid');
    const source = [
      `import fs from 'node:fs';`,
      `const { runChild } = await import(process.env.BLW_TEST_PROCESS_URL);`,
      `const script = "console.log(process.pid); setInterval(() => {}, 1000);";`,
      'await runChild({',
      '  file: process.execPath,',
      "  args: ['-e', script],",
      '  cwd: process.cwd(),',
      '  env: { ...process.env },',
      '  stderrLog: process.env.BLW_TEST_STDERR_LOG,',
      '  print: (line) => {',
      '    fs.writeFileSync(process.env.BLW_TEST_PID_FILE, line);',
      '    process.exit(0);',
      '  },',
      '  watchdogMs: 120000,',
      '});',
    ].join('\n');
    const parent = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: WORK,
      env: {
        ...process.env,
        BLW_TEST_PROCESS_URL: pathToFileURL(path.join(REPO_ROOT, 'src', 'process.ts')).href,
        BLW_TEST_PID_FILE: pidFile,
        BLW_TEST_STDERR_LOG: freshLog(),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let parentError = '';
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk: string) => {
      parentError += chunk;
    });
    let childPid = 0;
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const limit = setTimeout(() => {
          parent.kill();
          reject(new Error(`the parent did not end within 30 s: ${parentError}`));
        }, 30_000);
        parent.once('error', reject);
        parent.once('close', () => {
          clearTimeout(limit);
          resolve();
        });
      });
      assert.ok(fs.existsSync(pidFile), `the parent wrote no pid: ${parentError}`);
      childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      assert.ok(Number.isInteger(childPid) && childPid > 0, `not a pid: ${childPid}`);
      const deadline = Date.now() + 10_000;
      while (alive(childPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(alive(childPid), false, `the child ${childPid} is still running after the parent ended`);
    } finally {
      if (childPid > 0 && alive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // The child ended in the meantime.
        }
      }
    }
  });

  test('a print that throws loses that line only', () => {
    const printed: string[] = [];
    const relay = createLineRelay((line) => {
      if (line === 'b') {
        throw new Error('sink failed');
      }
      printed.push(line);
    });
    assert.doesNotThrow(() => relay.push('a\nb\nc\n'));
    assert.doesNotThrow(() => relay.end());
    assert.deepEqual(printed, ['a', 'c']);
  });

  test('a print that throws on the last piece does not escape end', () => {
    const relay = createLineRelay(() => {
      throw new Error('sink failed');
    });
    relay.push('tail');
    assert.doesNotThrow(() => relay.end());
  });

  test('a child whose every printed line throws still ends normally', async () => {
    const result = await runChild({
      file: process.execPath,
      args: ['-e', "console.log('one'); console.log('two'); console.log('three');"],
      cwd: WORK,
      env: { ...process.env },
      stderrLog: freshLog(),
      print: () => {
        throw new Error('sink failed');
      },
      watchdogMs: 60_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.interrupted, false);
  });
});
