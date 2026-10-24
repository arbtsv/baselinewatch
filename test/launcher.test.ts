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
});
