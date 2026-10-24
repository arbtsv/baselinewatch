// Tests for src/archive.ts: the run zip built with the system tar. The runner is injected, so every
// branch runs on every OS; the last block runs the real tar.exe and only runs on Windows.
// Run: node --test test/archive.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asciiSafeNames,
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

  // A run of 450 files whose names make a command line above the limit, with real files to copy.
  function putLongRun(runDir: string): string[] {
    const files = Array.from({ length: 450 }, (_, index) => `pass-1/test-results/${'a'.repeat(60)}-${index}/error-context.md`);
    files[7] = 'pass-1/test-results/\u043f\u0440\u0438\u0432\u0435\u0442/error-context.md';
    for (const name of files) {
      put(runDir, name, `text of ${name.length}`);
    }
    return files;
  }

  const NAME = 'pass-1/test-results/\u043f\u0440\u0438\u0432\u0435\u0442/error-context.md';

  test('a non-ASCII name is packed from a copy under an ASCII name and the copy is removed', async () => {
    const s = setup();
    put(s.runDir, 'report.txt', 'the report');
    put(s.runDir, NAME, 'cyrillic text');
    let staged: { root: string; names: string[]; texts: string[] } | undefined;
    const { run, calls } = fakeRunner((args) => {
      const root = args[args.indexOf('-C') + 1] as string;
      const names = args.slice(args.indexOf('--') + 1);
      staged = { root, names, texts: names.map((name) => fs.readFileSync(path.join(root, ...name.split('/')), 'utf8')) };
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      return OK;
    });
    assert.equal(await buildZip({ ...s, files: ['report.txt', NAME], run, tar: TAR }), 'built');
    assert.equal(calls.length, 1);
    assert.deepEqual(staged?.names, ['report.txt', 'pass-1/test-results/_/error-context.md']);
    assert.deepEqual(staged?.texts, ['the report', 'cyrillic text']);
    assert.notEqual(path.resolve(staged?.root as string), path.resolve(s.runDir));
    assert.ok(!calls[0]?.args.includes('-T'));
    assert.equal(fs.existsSync(staged?.root as string), false);
    assert.equal(fs.existsSync(s.tempZip), false);
    assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['report_x.zip', 'run']);
    assert.equal(fs.readFileSync(path.join(s.runDir, ...NAME.split('/')), 'utf8'), 'cyrillic text');
  });

  test('ASCII names are packed from the run directory itself, with nothing copied', async () => {
    const s = setup();
    put(s.runDir, 'report.txt', 'the report');
    const { run, calls } = fakeRunner((args) => {
      assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['run']);
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      return OK;
    });
    assert.equal(await buildZip({ ...s, files: ['report.txt'], run, tar: TAR }), 'built');
    assert.equal(calls[0]?.args[calls[0].args.indexOf('-C') + 1], s.runDir);
  });

  test('a command line above the limit with a non-ASCII name uses a list file of ASCII names and removes it and the copies', async () => {
    const s = setup();
    const files = putLongRun(s.runDir);
    let listText: string | undefined;
    let listFile: string | undefined;
    let root: string | undefined;
    const { run, calls } = fakeRunner((args) => {
      listFile = args[args.indexOf('-T') + 1];
      listText = fs.readFileSync(listFile as string, 'utf8');
      root = args[args.indexOf('-C') + 1];
      for (const name of listText.split('\n')) {
        assert.ok(fs.existsSync(path.join(root as string, ...name.split('/'))), `${name} is not in the staging directory`);
      }
      fs.writeFileSync(outputOf(args), ZIP_MAGIC);
      return OK;
    });
    assert.equal(await buildZip({ ...s, files, run, tar: TAR }), 'built');
    assert.equal(calls.length, 1);
    assert.ok((listText as string).split('\n').every((name) => /^[\x20-\x7e]+$/.test(name)));
    assert.equal((listText as string).split('\n')[7], 'pass-1/test-results/_/error-context.md');
    assert.equal(fs.existsSync(listFile as string), false);
    assert.equal(fs.existsSync(root as string), false);
    assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['report_x.zip', 'run']);
  });

  test('a tar that fails leaves no copies behind', async () => {
    const s = setup();
    put(s.runDir, NAME);
    const { run } = fakeRunner(() => ({ status: 1, timedOut: false }));
    assert.equal(await buildZip({ ...s, files: [NAME], run, tar: TAR }), 'failed');
    assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['run']);
  });

  test('a missing file with a non-ASCII name is failed, the runner is never called and no copies are left', async () => {
    const s = setup();
    const { run, calls } = fakeRunner(() => OK);
    assert.equal(await buildZip({ ...s, files: [NAME], run, tar: TAR }), 'failed');
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(s.listDir).sort(), ['run']);
  });
});

describe('asciiSafeNames', () => {
  const CYR = '\u043f\u0440\u0438\u0432\u0435\u0442';

  test('leaves ASCII names as they are', () => {
    const files = ['report.txt', 'pass-1/test-results/a b/c.png', 'pass-1.json'];
    assert.deepEqual(asciiSafeNames(files), files);
  });

  test('turns a run of characters outside printable ASCII into one underscore, in directories and in file names', () => {
    assert.deepEqual(
      asciiSafeNames([`pass-1/test-results/a-${CYR}-b/c.txt`, `pass-1/test-results/${CYR}${CYR}/${CYR}.png`, 'x/\u{1f600}\u{1f600}.md', 'tab\there.txt']),
      ['pass-1/test-results/a-_-b/c.txt', 'pass-1/test-results/_/_.png', 'x/_.md', 'tab_here.txt'],
    );
  });

  test('gives two different non-ASCII directories different names and the same directory the same name', () => {
    const names = asciiSafeNames([`t/${CYR}/a.md`, `t/\u043f\u043e\u043a\u0430/a.md`, `t/${CYR}/b.md`, `t/\u043f\u043e\u043a\u0430/b.md`]);
    assert.deepEqual(names, ['t/_/a.md', 't/_-2/a.md', 't/_/b.md', 't/_-2/b.md']);
  });

  test('never renames an ASCII sibling for the sake of a non-ASCII one, in either order', () => {
    assert.deepEqual(asciiSafeNames([`t/${CYR}/a.md`, 't/_/a.md']), ['t/_-2/a.md', 't/_/a.md']);
    assert.deepEqual(asciiSafeNames(['t/_/a.md', `t/${CYR}/a.md`]), ['t/_/a.md', 't/_-2/a.md']);
  });

  test('puts the counter of a clashing file name before its extension and compares names without case', () => {
    assert.deepEqual(asciiSafeNames([`d/${CYR}.txt`, 'd/\u043f\u043e\u043a\u0430.txt', 'd/_-2.txt', 'D/x']), ['d/_.txt', 'd/_-3.txt', 'd/_-2.txt', 'D/x']);
  });

  test('the names of a directory that was renamed carry through to its children', () => {
    assert.deepEqual(asciiSafeNames([`${CYR}/sub/a.txt`, `${CYR}/sub/b.txt`, '\u043f\u043e\u043a\u0430/sub/a.txt']), ['_/sub/a.txt', '_/sub/b.txt', '_-2/sub/a.txt']);
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
    assert.equal(await buildZip({ runDir, tempZip, finalZip, files, run: runTar, tar: tarPath() }), 'built');
    const entries = unzipTexts(fs.readFileSync(finalZip));
    assert.deepEqual(
      entries.map(([, text]) => text),
      ['the report', 'plain entry', 'cyrillic directory entry'],
    );
    assert.deepEqual(
      entries.slice(0, 2).map(([name]) => name),
      ['report.txt', 'pass-1/test-results/a.txt'],
    );
    // The Cyrillic directory is packed under an ASCII name, so tar never has to read it.
    assert.equal(entries[2]?.[0], 'pass-1/test-results/_/b.txt');
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
