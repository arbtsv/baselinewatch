// Tests of templates/monitor.bat: how it starts the installed core and what it does when Node or the core is missing.
// Run: node --test test/launcher.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envWithPath, runLauncherSync, systemDirectory } from './helpers/launcher.ts';

const TEMPLATE = path.join(import.meta.dirname, '..', 'templates', 'monitor.bat');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-launcher-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

// A stand-in for the installed core: it reports what it was started with and exits with the number it is given.
const STUB_CORE = [
  "console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));",
  "console.log('EXEC=' + process.execPath);",
  "console.log('CWD=' + process.cwd());",
  "const code = Number.parseInt(process.argv[3] ?? '0', 10);",
  'process.exitCode = Number.isInteger(code) ? code : 0;',
  '',
].join('\n');

/** A project directory with a byte copy of the launcher and, unless core is false, a stub core. */
function makeProject(name: string, { core = true }: { core?: boolean } = {}): { dir: string; bat: string } {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const bat = path.join(dir, 'monitor.bat');
  fs.copyFileSync(TEMPLATE, bat);
  if (core) {
    const cli = path.join(dir, 'node_modules', 'baselinewatch', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, STUB_CORE);
  }
  return { dir, bat };
}

function valueOf(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

/** A Path that finds Node and the system tools, the way a scheduler with Node installed would. */
function pathWithNode(): string {
  return `${path.dirname(process.execPath)};${systemDirectory()}`;
}

describe('the launcher file', () => {
  const text = fs.readFileSync(TEMPLATE, 'latin1');
  const lines = text.split('\r\n').slice(0, -1);

  test('is plain ASCII without a byte order mark', () => {
    assert.match(text, /^[\x20-\x7e\r\n]*$/);
    assert.notEqual(fs.readFileSync(TEMPLATE).subarray(0, 3).toString('hex'), 'efbbbf');
  });

  test('uses CRLF line ends only and ends with one', () => {
    assert.ok(text.endsWith('\r\n'));
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(text.replace(/\r\n/g, '').includes('\r'), false);
  });

  test('has at most 25 lines and carries the version marker on line 2', () => {
    assert.ok(lines.length <= 25, `${lines.length} lines`);
    assert.equal(lines[0], '@echo off');
    assert.equal(lines[1], 'rem blw-template: 1');
  });

  test('holds the lines that make up the run and the failure tail', () => {
    for (const expected of [
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      '"%NODE%" "node_modules\\baselinewatch\\dist\\cli.js" run %*',
      'set "RC=%ERRORLEVEL%"',
      'exit /b %RC%',
      'echo REASON=node',
      'echo REASON=config',
      'echo RESULT=FAIL',
      'exit /b 3',
    ]) {
      assert.ok(lines.includes(expected), `missing line: ${expected}`);
    }
  });

  test('prints RESULT=FAIL after both reasons and only the exit follows it', () => {
    const result = lines.indexOf('echo RESULT=FAIL');
    assert.ok(result > lines.indexOf('echo REASON=node'));
    assert.ok(result > lines.indexOf('echo REASON=config'));
    assert.deepEqual(lines.slice(result + 1), ['exit /b 3']);
  });

  test('has no parenthesised block and keeps delayed expansion off', () => {
    assert.equal(
      lines.some((line) => line.endsWith('(')),
      false,
    );
    assert.equal(
      lines.some((line) => /enabledelayedexpansion/i.test(line)),
      false,
    );
  });

  test('keeps every rem line free of characters cmd.exe treats as syntax', () => {
    const remarks = lines.filter((line) => /^rem\b/i.test(line));
    assert.ok(remarks.length > 0);
    for (const line of remarks) assert.doesNotMatch(line, /[%^&|<>]/, line);
  });
});

describe('running monitor.bat', { skip: process.platform !== 'win32' }, () => {
  test('passes run and the exit code of the core through', () => {
    const { dir, bat } = makeProject('plain');
    const result = runLauncherSync(bat, [], { cwd: os.tmpdir() });
    assert.equal(result.status, 0);
    assert.ok(result.lines.includes('ARGS=["run"]'), result.stdout);
    const cwd = valueOf(result.lines, 'CWD=');
    assert.ok(cwd !== undefined, result.stdout);
    assert.equal(fs.realpathSync.native(cwd).toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
    assert.equal(
      result.lines.some((line) => line.startsWith('RESULT=')),
      false,
    );
  });

  test('exit codes 1 and 3 of the core reach the caller unchanged', () => {
    const { bat } = makeProject('codes');
    assert.equal(runLauncherSync(bat, ['1'], { cwd: os.tmpdir() }).status, 1);
    assert.equal(runLauncherSync(bat, ['3'], { cwd: os.tmpdir() }).status, 3);
  });

  test('without Node it prints REASON=node and RESULT=FAIL last and exits 3', () => {
    const { bat } = makeProject('no-node');
    const result = runLauncherSync(bat, [], { env: envWithPath(systemDirectory()), cwd: os.tmpdir() });
    assert.equal(result.status, 3);
    assert.equal(result.lines.length, 3, result.stdout);
    assert.ok(result.lines[0]?.includes('Node.js'), result.stdout);
    assert.equal(result.lines[1], 'REASON=node');
    assert.equal(result.lines[2], 'RESULT=FAIL');
    assert.equal(result.stderr, '');
    assert.equal(
      result.lines.some((line) => line.startsWith('ARGS=')),
      false,
    );
  });

  test('reports REASON=config and exits 3 when the core is not installed', () => {
    const { bat } = makeProject('no-core', { core: false });
    const result = runLauncherSync(bat, [], { env: envWithPath(pathWithNode()), cwd: os.tmpdir() });
    assert.equal(result.status, 3);
    assert.deepEqual(result.lines.slice(-2), ['REASON=config', 'RESULT=FAIL']);
    assert.equal(
      result.lines.some((line) => line.startsWith('ARGS=')),
      false,
    );
  });

  test('hands every argument to the core unchanged, a quoted blank included', () => {
    const { bat } = makeProject('quoted');
    const result = runLauncherSync(bat, ['"a b"', '--x'], { cwd: os.tmpdir() });
    assert.equal(result.status, 0);
    assert.ok(result.lines.includes('ARGS=["run","a b","--x"]'), result.stdout);
  });

  test('prefers the node folder next to the script over Node on the Path', () => {
    const { dir, bat } = makeProject('portable');
    const portable = path.join(dir, 'node', 'node.exe');
    fs.mkdirSync(path.dirname(portable));
    try {
      fs.linkSync(process.execPath, portable);
    } catch {
      fs.copyFileSync(process.execPath, portable);
    }
    const result = runLauncherSync(bat, [], { env: envWithPath(pathWithNode()), cwd: os.tmpdir() });
    assert.equal(result.status, 0, result.stdout);
    const exec = valueOf(result.lines, 'EXEC=');
    assert.ok(exec !== undefined, result.stdout);
    assert.equal(fs.realpathSync.native(exec).toLowerCase(), fs.realpathSync.native(portable).toLowerCase());
  });

  test('an empty node folder changes nothing when Node is missing', () => {
    const { dir, bat } = makeProject('empty-node-folder');
    fs.mkdirSync(path.join(dir, 'node'));
    const result = runLauncherSync(bat, [], { env: envWithPath(systemDirectory()), cwd: os.tmpdir() });
    assert.equal(result.status, 3);
    assert.deepEqual(result.lines.slice(-2), ['REASON=node', 'RESULT=FAIL']);
  });

  // A version manager can put a node.cmd in front of Node. cmd.exe hands the rest of the script to a batch
  // file it starts without call, so the probe must use call or the launcher ends there with the exit code 0.
  test('a node.cmd shim on the Path still runs the core and passes its exit code and output through', () => {
    const { dir, bat } = makeProject('shim-runs', { core: false });
    const cli = path.join(dir, 'node_modules', 'baselinewatch', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "console.log('CORE-RAN');\nprocess.exitCode = 1;\n");
    const shims = path.join(dir, 'shims');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'node.cmd'), `@"${process.execPath}" %*\r\n`);
    const result = runLauncherSync(bat, [], { env: envWithPath(`${shims};${systemDirectory()}`), cwd: os.tmpdir() });
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.lines.includes('CORE-RAN'), result.stdout);
  });

  test('a node.cmd shim whose version call fails gives REASON=node and exit 3', () => {
    const { dir, bat } = makeProject('shim-broken');
    const shims = path.join(dir, 'shims');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'node.cmd'), '@exit /b 9\r\n');
    const result = runLauncherSync(bat, [], { env: envWithPath(`${shims};${systemDirectory()}`), cwd: os.tmpdir() });
    assert.equal(result.status, 3, result.stdout);
    assert.deepEqual(result.lines.slice(-2), ['REASON=node', 'RESULT=FAIL']);
    assert.equal(
      result.lines.some((line) => line.startsWith('ARGS=')),
      false,
    );
  });

  test('works from a directory name full of characters cmd.exe treats as syntax', () => {
    const name = `blw (x) & y ^ 100% ${String.fromCodePoint(0x0434, 0x0435, 0x043c, 0x043e)}`;
    const { bat } = makeProject(name);
    const plain = runLauncherSync(bat, [], { env: envWithPath(pathWithNode()), cwd: os.tmpdir() });
    assert.equal(plain.status, 0, plain.stdout);
    assert.ok(plain.lines.includes('ARGS=["run"]'), plain.stdout);
    const noNode = runLauncherSync(bat, [], { env: envWithPath(systemDirectory()), cwd: os.tmpdir() });
    assert.equal(noNode.status, 3, noNode.stdout);
    assert.equal(noNode.lines.at(-1), 'RESULT=FAIL');
  });
});
