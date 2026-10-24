// Tests for src/archive.ts: the run zip built with the system tar. The runner is injected, so every
// branch runs on every OS; the last block runs the real tar.exe and only runs on Windows.
// Run: node --test test/archive.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildZip,
  commandLineLength,
  isZipCandidate,
  MAX_COMMAND_LINE,
  runTar,
  tarArgs,
  tarPath,
  zipFileList,
  type TarResult,
  type TarRunner,
} from '../src/archive.ts';
import { unzipTexts } from './helpers/zip.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-archive-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

let counter = 0;
function makeDir(name: string): string {
  counter += 1;
  const dir = path.join(WORK, `${name}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function put(root: string, relative: string, content: string | Buffer = 'x'): string {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

type Call = { file: string; args: string[] };

/** A runner that records its calls and lets the test decide what the "tar" leaves behind. */
function fakeRunner(act: (args: string[]) => TarResult | Promise<TarResult>): { run: TarRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: TarRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    return act([...args]);
  };
  return { run, calls };
}

const outputOf = (args: readonly string[]): string => args[args.indexOf('-f') + 1] as string;
const OK: TarResult = { status: 0, timedOut: false };

describe('tarPath', () => {
  test('is System32\\tar.exe under SystemRoot', () => {
    assert.equal(tarPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\tar.exe');
  });

  test('falls back to windir', () => {
    assert.equal(tarPath({ windir: 'E:\\Windows' }), 'E:\\Windows\\System32\\tar.exe');
  });

  test('falls back to C:\\Windows when neither is set or both are empty', () => {
    assert.equal(tarPath({}), 'C:\\Windows\\System32\\tar.exe');
    assert.equal(tarPath({ SystemRoot: '', windir: '' }), 'C:\\Windows\\System32\\tar.exe');
  });
});

describe('tarArgs', () => {
  test('puts the files after a double dash so a name that starts with a dash is a file', () => {
    assert.deepEqual(tarArgs('C:\\a\\.report_x.1.tmp.zip', 'C:\\r', ['report.txt', '-weird.txt']), [
      '-a',
      '-c',
      '-f',
      'C:\\a\\.report_x.1.tmp.zip',
      '-C',
      'C:\\r',
      '--',
      'report.txt',
      '-weird.txt',
    ]);
  });

  test('refuses an archive name that does not end in .zip', () => {
    assert.throws(() => tarArgs('C:\\a\\report.zip.part', 'C:\\r', ['report.txt']), /\.zip/);
  });

  test('accepts the extension in any case', () => {
    assert.doesNotThrow(() => tarArgs('C:\\a\\REPORT.ZIP', 'C:\\r', ['report.txt']));
  });
});

describe('commandLineLength', () => {
  test('counts every argument and a space after it', () => {
    assert.equal(commandLineLength('tar', ['ab', 'cde']), 3 + 3 + 4);
  });

  test('adds the quotes of an argument with a space', () => {
    assert.equal(commandLineLength('tar', ['a b']), 3 + 3 + 1 + 2);
  });
});

describe('buildZip', () => {
  function setup(): { runDir: string; tempZip: string; finalZip: string; listDir: string } {
    const dir = makeDir('build');
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    return { runDir, tempZip: path.join(dir, '.report_x.1.tmp.zip'), finalZip: path.join(dir, 'report_x.zip'), listDir: dir };
  }
  const TAR = 'C:\\Windows\\System32\\tar.exe';

  test('renames a zip with the right first bytes to the final name and leaves no temporary file', async () => {
    const s = setup();
    const { run, calls } = fakeRunner((args) => {
      fs.writeFileSync(outputOf(args), Buffer.concat([ZIP_MAGIC, Buffer.from('entries')]));
      return OK;
    });
    const outcome = await buildZip({ ...s, files: ['report.txt', 'summary.json'], run, tar: TAR });
    assert.equal(outcome, 'built');
    assert.ok(fs.readFileSync(s.finalZip).subarray(0, 4).equals(ZIP_MAGIC));
    assert.equal(fs.existsSync(s.tempZip), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, TAR);
    assert.deepEqual(calls[0]?.args, tarArgs(s.tempZip, s.runDir, ['report.txt', 'summary.json']));
  });

  const failures: [string, (args: string[]) => TarResult][] = [
    [
      'a tar that exits with status 1 after leaving a partial file',
      (args) => {
        fs.writeFileSync(outputOf(args), Buffer.concat([ZIP_MAGIC, Buffer.from('partial')]));
        return { status: 1, timedOut: false };
      },
    ],
    [
      'a tar that writes a plain tar archive and exits with status 0',
      (args) => {
        fs.writeFileSync(outputOf(args), Buffer.from('report.txt\0\0\0\0plain tar'));
        return OK;
      },
    ],
    ['a tar that writes nothing and exits with status 0', () => OK],
    [
      'a tar that times out',
      (args) => {
        fs.writeFileSync(outputOf(args), ZIP_MAGIC);
        return { status: null, timedOut: true };
      },
    ],
    [
      'a tar that cannot be started',
      () => ({ status: null, timedOut: false, error: 'ENOENT' }),
    ],
  ];
  for (const [name, act] of failures) {
    test(`${name} is failed and leaves neither the temporary nor the final file`, async () => {
      const s = setup();
      const { run } = fakeRunner(act);
      assert.equal(await buildZip({ ...s, files: ['report.txt'], run, tar: TAR }), 'failed');
      assert.equal(fs.existsSync(s.tempZip), false);
      assert.equal(fs.existsSync(s.finalZip), false);
    });
  }

  test('a runner that throws is failed and leaves nothing', async () => {
    const s = setup();
    const run: TarRunner = async (_file, args) => {
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      throw new Error('boom');
    };
    assert.equal(await buildZip({ ...s, files: ['report.txt'], run, tar: TAR }), 'failed');
    assert.equal(fs.existsSync(s.tempZip), false);
    assert.equal(fs.existsSync(s.finalZip), false);
  });

  const longList = (): string[] => Array.from({ length: 400 }, (_, index) => `pass-1/test-results/${'a'.repeat(90)}-${index}/error-context.md`);

  test('a command line above the limit with ASCII names uses a list file outside the run directory and removes it', async () => {
    const s = setup();
    const files = longList();
    assert.ok(commandLineLength(TAR, tarArgs(s.tempZip, s.runDir, files)) > MAX_COMMAND_LINE);
    let listText: string | undefined;
    let listFile: string | undefined;
    const { run, calls } = fakeRunner((args) => {
      listFile = args[args.indexOf('-T') + 1];
      listText = fs.readFileSync(listFile as string, 'utf8');
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      return OK;
    });
    assert.equal(await buildZip({ ...s, files, run, tar: TAR }), 'built');
    assert.equal(calls.length, 1);
    const args = calls[0]?.args as string[];
    assert.ok(args.includes('-T'));
    assert.ok(!args.includes(files[0] as string));
    assert.equal(listText, files.join('\n'));
    assert.ok(!path.resolve(listFile as string).startsWith(`${path.resolve(s.runDir)}${path.sep}`));
    assert.equal(fs.existsSync(listFile as string), false);
    assert.equal(fs.existsSync(path.dirname(listFile as string)), false);
    assert.equal(fs.existsSync(s.tempZip), false);
  });

  test('a command line above the limit with one non-ASCII name is failed and the runner is never called', async () => {
    const s = setup();
    const files = longList();
    files[7] = 'pass-1/test-results/\u043f\u0440\u0438\u0432\u0435\u0442/error-context.md';
    const { run, calls } = fakeRunner(() => OK);
    assert.equal(await buildZip({ ...s, files, run, tar: TAR }), 'failed');
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(s.tempZip), false);
    assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['run']);
  });

  test('a non-ASCII name under the limit goes through as an argument', async () => {
    const s = setup();
    const name = 'pass-1/test-results/\u043f\u0440\u0438\u0432\u0435\u0442/error-context.md';
    const { run, calls } = fakeRunner((args) => {
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      return OK;
    });
    assert.equal(await buildZip({ ...s, files: ['report.txt', name], run, tar: TAR }), 'built');
    assert.ok(calls[0]?.args.includes(name));
    assert.ok(!calls[0]?.args.includes('-T'));
  });
});

describe('zipFileList', () => {
  function makeRun(): string {
    const runDir = makeDir('list');
    put(runDir, 'report.txt');
    put(runDir, 'summary.json');
    put(runDir, 'pass-1.json');
    put(runDir, 'pass-1.stderr.log');
    put(runDir, 'pass-1.history-error.log');
    put(runDir, 'cli-error.log');
    put(runDir, 'pass-1/html/index.html');
    put(runDir, 'pass-1/test-results/.last-run.json');
    put(runDir, 'pass-1/test-results/t/error-context.md');
    put(runDir, 'pass-1/test-results/t/attachments/screenshot-1.png');
    return runDir;
  }

  test('lists the report, the summary, the pass files that exist and then the test results, sorted', () => {
    const runDir = makeRun();
    assert.deepEqual(zipFileList(runDir, new Set()), [
      'report.txt',
      'summary.json',
      'pass-1.json',
      'pass-1/test-results/.last-run.json',
      'pass-1/test-results/t/attachments/screenshot-1.png',
      'pass-1/test-results/t/error-context.md',
    ]);
  });

  test('includes pass 2 only when it exists, after pass 1', () => {
    const runDir = makeRun();
    put(runDir, 'pass-2.json');
    put(runDir, 'pass-2/test-results/u/error-context.md');
    put(runDir, 'pass-2/html/index.html');
    const list = zipFileList(runDir, new Set());
    assert.deepEqual(list.slice(0, 4), ['report.txt', 'summary.json', 'pass-1.json', 'pass-2.json']);
    assert.ok(list.includes('pass-2/test-results/u/error-context.md'));
    assert.ok(list.indexOf('pass-1/test-results/t/error-context.md') < list.indexOf('pass-2/test-results/u/error-context.md'));
  });

  test('never lists html, a stderr log, a history error log or the cli error log', () => {
    const list = zipFileList(makeRun(), new Set());
    for (const name of list) {
      assert.ok(!name.includes('/html/'), name);
      assert.ok(!name.endsWith('.stderr.log'), name);
      assert.ok(!name.endsWith('history-error.log'), name);
      assert.notEqual(name, 'cli-error.log');
    }
  });

  test('leaves out a tainted path', () => {
    const runDir = makeRun();
    const list = zipFileList(runDir, new Set(['pass-1/test-results/t/attachments/screenshot-1.png']));
    assert.ok(!list.includes('pass-1/test-results/t/attachments/screenshot-1.png'));
    assert.ok(list.includes('pass-1/test-results/t/error-context.md'));
  });

  test('omits the report and the pass files that do not exist', () => {
    const runDir = makeDir('list-empty');
    assert.deepEqual(zipFileList(runDir, new Set()), []);
  });

  test('does not follow a linked directory', (context) => {
    const runDir = makeRun();
    const outside = makeDir('outside');
    put(outside, 'secret.txt');
    try {
      fs.symlinkSync(outside, path.join(runDir, 'pass-1', 'test-results', 'linked'), 'junction');
    } catch {
      context.skip('links cannot be created here');
      return;
    }
    const list = zipFileList(runDir, new Set());
    assert.ok(!list.some((name) => name.includes('linked')), list.join('\n'));
  });

  test('gives an empty list for a run directory that does not exist', () => {
    assert.deepEqual(zipFileList(path.join(WORK, 'missing'), new Set()), []);
  });
});

describe('isZipCandidate', () => {
  test('is true for what enters the zip', () => {
    assert.equal(isZipCandidate('pass-1/test-results/a/b.png'), true);
    assert.equal(isZipCandidate('pass-2/test-results/.last-run.json'), true);
    assert.equal(isZipCandidate('report.txt'), true);
    assert.equal(isZipCandidate('summary.json'), true);
    assert.equal(isZipCandidate('pass-1.json'), true);
  });

  test('is false for what stays out', () => {
    assert.equal(isZipCandidate('pass-1/html/index.html'), false);
    assert.equal(isZipCandidate('pass-1.stderr.log'), false);
    assert.equal(isZipCandidate('cli-error.log'), false);
    assert.equal(isZipCandidate('pass-1.history-error.log'), false);
    assert.equal(isZipCandidate('pass-1/trace.zip'), false);
  });
});

// Temporary: what the real tar.exe says when the zip is not built, and the code pages of the machine.
function tarDiagnostics(dir: string, runDir: string, files: string[]): string {
  const probe = path.join(dir, 'probe.zip');
  const tar = spawnSync(tarPath(), tarArgs(probe, runDir, files), { windowsHide: true });
  const version = spawnSync(tarPath(), ['--version'], { encoding: 'utf8', windowsHide: true });
  const pages = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP', '/v', 'OEMCP'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return [
    `tar status=${tar.status} error=${tar.error?.message ?? '-'} zip written=${fs.existsSync(probe)}`,
    `tar stderr (latin1)=${tar.stderr?.toString('latin1').trim()}`,
    `tar stderr (hex)=${tar.stderr?.subarray(0, 200).toString('hex')}`,
    `tar version=${version.stdout?.trim()}`,
    `code pages=${pages.stdout?.replace(/\s+/g, ' ').trim()}`,
  ].join('\n');
}

// The real tar.exe of Windows (bsdtar): the format, the order of the entries and the failure of a missing input.
describe('the real tar.exe', { skip: process.platform !== 'win32' }, () => {
  const CYRILLIC = '\u043f\u0440\u0438\u0432\u0435\u0442';

  test('builds a zip with the entries in argument order, including a file in a directory with a Cyrillic name', async () => {
    const dir = makeDir('real');
    const runDir = path.join(dir, 'run');
    put(runDir, 'report.txt', 'the report');
    put(runDir, 'pass-1/test-results/a.txt', 'plain entry');
    put(runDir, `pass-1/test-results/${CYRILLIC}/b.txt`, 'cyrillic directory entry');
    const files = ['report.txt', 'pass-1/test-results/a.txt', `pass-1/test-results/${CYRILLIC}/b.txt`];
    const tempZip = path.join(dir, '.report_x.1.tmp.zip');
    const finalZip = path.join(dir, 'report_x.zip');
    const built = await buildZip({ runDir, tempZip, finalZip, files, run: runTar, tar: tarPath() });
    assert.equal(built, 'built', built === 'built' ? undefined : tarDiagnostics(dir, runDir, files));
    const entries = unzipTexts(fs.readFileSync(finalZip));
    assert.deepEqual(
      entries.map(([, text]) => text),
      ['the report', 'plain entry', 'cyrillic directory entry'],
    );
    assert.deepEqual(
      entries.slice(0, 2).map(([name]) => name),
      ['report.txt', 'pass-1/test-results/a.txt'],
    );
    assert.equal(fs.existsSync(tempZip), false);
  });

  test('a missing input file is failed and leaves no temporary file', async () => {
    const dir = makeDir('real-missing');
    const runDir = path.join(dir, 'run');
    put(runDir, 'report.txt', 'the report');
    const tempZip = path.join(dir, '.report_y.1.tmp.zip');
    const finalZip = path.join(dir, 'report_y.zip');
    const outcome = await buildZip({ runDir, tempZip, finalZip, files: ['report.txt', 'gone.txt'], run: runTar, tar: tarPath() });
    assert.equal(outcome, 'failed');
    assert.equal(fs.existsSync(tempZip), false);
    assert.equal(fs.existsSync(finalZip), false);
  });

  test('a tar that cannot be found is failed', async () => {
    const dir = makeDir('real-nofile');
    const runDir = path.join(dir, 'run');
    put(runDir, 'report.txt', 'the report');
    const outcome = await buildZip({
      runDir,
      tempZip: path.join(dir, '.report_z.1.tmp.zip'),
      finalZip: path.join(dir, 'report_z.zip'),
      files: ['report.txt'],
      run: runTar,
      tar: path.join(dir, 'no-such-tar.exe'),
    });
    assert.equal(outcome, 'failed');
  });
});
