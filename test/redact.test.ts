// Tests for src/redact.ts: the redactor and the walk over a run directory, on a real temporary directory.
// Run: node --test test/redact.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRedactor, MASK, MIN_REDACT_LENGTH, redactRunDirectory, strictText, type WalkResult } from '../src/redact.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-redact-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const ACCOUNT = { login: 'demo-op', password: 'demo-op-pass' };

let dirCounter = 0;
function makeRunDir(): string {
  dirCounter += 1;
  const dir = path.join(WORK, `run-${dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The counts and the tainted files of a walk; the other lists have tests of their own.
function core(result: WalkResult): { rewritten: number; tainted: string[] } {
  return { rewritten: result.rewritten, tainted: result.tainted };
}

function put(runDir: string, relative: string, content: string | Buffer): string {
  const file = path.join(runDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('createRedactor', () => {
  test('replaces the login and the password everywhere in a text', () => {
    const redactor = createRedactor(ACCOUNT);
    assert.equal(redactor.text('user demo-op typed demo-op-pass, then demo-op again'), `user ${MASK} typed ${MASK}, then ${MASK} again`);
  });

  test('is case-sensitive', () => {
    const redactor = createRedactor(ACCOUNT);
    assert.equal(redactor.text('Demo-Op DEMO-OP demo-op'), `Demo-Op DEMO-OP ${MASK}`);
  });

  test('replaces the longer value first, so no half of a value is left', () => {
    const redactor = createRedactor(ACCOUNT);
    const output = redactor.text('login=demo-op password=demo-op-pass');
    assert.equal(output, `login=${MASK} password=${MASK}`);
    assert.ok(!output.includes('-pass'));
  });

  test('replaces a value with regular expression characters and with $& as the literal it is', () => {
    const redactor = createRedactor({ login: 'a.b*c(d)', password: 'pa$&ss[1]' });
    assert.equal(redactor.text('x a.b*c(d) y pa$&ss[1] z aXb*c(d)'), `x ${MASK} y ${MASK} z aXb*c(d)`);
  });

  test('does not replace a value shorter than the minimum and names its field', () => {
    assert.equal(MIN_REDACT_LENGTH, 3);
    const redactor = createRedactor({ login: 'ab', password: 'demo-op-pass' });
    assert.deepEqual(redactor.tooShort, ['login']);
    assert.equal(redactor.text('ab and demo-op-pass'), `ab and ${MASK}`);
    assert.deepEqual(createRedactor({ login: 'ab', password: 'xy' }).tooShort, ['login', 'password']);
    assert.deepEqual(createRedactor(ACCOUNT).tooShort, []);
  });

  test('is idempotent', () => {
    const redactor = createRedactor(ACCOUNT);
    const once = redactor.text('demo-op demo-op-pass');
    assert.equal(redactor.text(once), once);
  });

  test('containsValue finds the UTF-8 bytes of a value inside a buffer with NUL bytes', () => {
    const redactor = createRedactor(ACCOUNT);
    assert.equal(redactor.containsValue(Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('demo-op-pass'), Buffer.from([0])])), true);
    assert.equal(redactor.containsValue(Buffer.from([0, 1, 2, 3, 0])), false);
    assert.equal(createRedactor({ login: 'ab', password: 'cd' }).containsValue(Buffer.from('abcd')), false);
  });
});

describe('createRedactor and UTF-16', () => {
  test('containsValue finds a value as UTF-16LE and as UTF-16BE, with or without a byte order mark', () => {
    const redactor = createRedactor(ACCOUNT);
    const little = Buffer.from('demo-op-pass', 'utf16le');
    assert.equal(redactor.containsValue(little), true);
    assert.equal(redactor.containsValue(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\ny', 'utf16le'), little])), true);
    assert.equal(redactor.containsValue(Buffer.from(little).swap16()), true);
    assert.equal(redactor.containsValue(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(little).swap16()])), true);
    assert.equal(redactor.containsValue(Buffer.from('other text here', 'utf16le')), false);
  });

  test('the longest needle covers the UTF-16 form, so a chunk overlap is never too short', () => {
    assert.equal(createRedactor({ login: 'abc', password: 'abcd' }).longestValueBytes, 8);
    assert.equal(createRedactor({ login: 'ab', password: 'cd' }).longestValueBytes, 0);
  });
});

describe('strictText', () => {
  test('keeps a byte order mark', () => {
    assert.equal(strictText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text')])), '\ufefftext');
  });

  test('rejects a NUL byte, invalid UTF-8 and UTF-16LE text', () => {
    assert.equal(strictText(Buffer.from([0x61, 0x00, 0x62])), undefined);
    assert.equal(strictText(Buffer.from([0x61, 0xc0, 0x62])), undefined);
    assert.equal(strictText(Buffer.from('demo-op', 'utf16le')), undefined);
  });

  test('accepts plain and multi-byte UTF-8', () => {
    assert.equal(strictText(Buffer.from('plain')), 'plain');
    assert.equal(strictText(Buffer.from('café 中')), 'café 中');
  });
});

describe('redactRunDirectory', () => {
  const secretText = 'login: demo-op\npassword: demo-op-pass\n';

  test('rewrites the error context, the stderr log and the cli error log', () => {
    const runDir = makeRunDir();
    const contextFile = put(runDir, 'pass-1/test-results/t/error-context.md', secretText);
    const stderrFile = put(runDir, 'pass-1.stderr.log', 'warning for demo-op-pass\n');
    const errorFile = put(runDir, 'cli-error.log', 'Error: demo-op\n');
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 3, tainted: [] });
    assert.equal(fs.readFileSync(contextFile, 'utf8'), `login: ${MASK}\npassword: ${MASK}\n`);
    assert.equal(fs.readFileSync(stderrFile, 'utf8'), `warning for ${MASK}\n`);
    assert.equal(fs.readFileSync(errorFile, 'utf8'), `Error: ${MASK}\n`);
  });

  test('leaves no temporary file behind', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1.stderr.log', secretText);
    redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(fs.readdirSync(runDir), ['pass-1.stderr.log']);
  });

  test('leaves a pass file byte-equal even when the login is a word of its keys', () => {
    const runDir = makeRunDir();
    const original = Buffer.from(JSON.stringify({ projects: [{ node: 'node-1', class: 'ok' }] }, null, 2));
    const file = put(runDir, 'pass-1.json', original);
    const result = redactRunDirectory(runDir, createRedactor({ login: 'node', password: 'placeholder-password' }));
    assert.deepEqual(core(result), { rewritten: 0, tainted: [] });
    assert.ok(fs.readFileSync(file).equals(original));
  });

  test('leaves the html report and the report and summary of the run untouched', () => {
    const runDir = makeRunDir();
    const html = put(runDir, 'pass-1/html/data/x.md', secretText);
    const report = put(runDir, 'report.txt', secretText);
    const summary = put(runDir, 'summary.json', secretText);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 0, tainted: [] });
    for (const file of [html, report, summary]) {
      assert.equal(fs.readFileSync(file, 'utf8'), secretText);
    }
  });

  test('rewrites a report.txt that is not in the run root', () => {
    const runDir = makeRunDir();
    const nested = put(runDir, 'pass-1/test-results/report.txt', secretText);
    redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.ok(!fs.readFileSync(nested, 'utf8').includes('demo-op'));
  });

  test('reports a binary file that holds a value as tainted and leaves it', () => {
    const runDir = makeRunDir();
    const blob = Buffer.concat([Buffer.from([0, 0x89, 0x50, 0]), Buffer.from('demo-op'), Buffer.from([0, 1])]);
    const file = put(runDir, 'pass-1/test-results/t/blob.bin', blob);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 0, tainted: ['pass-1/test-results/t/blob.bin'] });
    assert.ok(fs.readFileSync(file).equals(blob));
  });

  test('does not report a binary file without a value', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/t/clean.bin', Buffer.from([0, 1, 2, 3, 0x89, 0x50]));
    assert.deepEqual(core(redactRunDirectory(runDir, createRedactor(ACCOUNT))), { rewritten: 0, tainted: [] });
  });

  test('reports a NUL-free file in a single-byte code page as tainted and unchanged', () => {
    const runDir = makeRunDir();
    const data = Buffer.concat([Buffer.from([0xc0, 0xff, 0xe9]), Buffer.from('demo-op'), Buffer.from([0xc1, 0xfe])]);
    const file = put(runDir, 'pass-1.stderr.log', data);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 0, tainted: ['pass-1.stderr.log'] });
    assert.ok(fs.readFileSync(file).equals(data));
  });

  test('a second walk rewrites nothing', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/t/error-context.md', secretText);
    const redactor = createRedactor(ACCOUNT);
    assert.equal(redactRunDirectory(runDir, redactor).rewritten, 1);
    assert.deepEqual(core(redactRunDirectory(runDir, redactor)), { rewritten: 0, tainted: [] });
  });

  test('keeps a byte order mark when it rewrites a file', () => {
    const runDir = makeRunDir();
    const file = put(runDir, 'cli-error.log', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('demo-op')]));
    redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.ok(fs.readFileSync(file).equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MASK)])));
  });

  test('a file above the size limit is scanned in chunks and tainted when a value crosses a chunk boundary', () => {
    const runDir = makeRunDir();
    const data = Buffer.alloc(4096, 0x61);
    Buffer.from('demo-op-pass').copy(data, 250);
    const file = put(runDir, 'pass-1/test-results/t/big.log', data);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT), { maxTextBytes: 1024, chunkBytes: 256 });
    assert.deepEqual(core(result), { rewritten: 0, tainted: ['pass-1/test-results/t/big.log'] });
    assert.ok(fs.readFileSync(file).equals(data));
  });

  test('a file above the size limit without a value is not tainted', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/t/big.log', Buffer.alloc(4096, 0x61));
    assert.deepEqual(core(redactRunDirectory(runDir, createRedactor(ACCOUNT), { maxTextBytes: 1024, chunkBytes: 256 })), { rewritten: 0, tainted: [] });
  });

  test('a file whose rewrite keeps failing is tainted and stays', () => {
    const runDir = makeRunDir();
    const file = put(runDir, 'pass-1.stderr.log', secretText);
    // A directory in the place of the temporary name makes every write of it fail.
    fs.mkdirSync(`${file}.${process.pid}.redact`);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 0, tainted: ['pass-1.stderr.log'] });
    assert.equal(fs.readFileSync(file, 'utf8'), secretText);
  });

  test('a UTF-16 file that holds the password is tainted and left as it is', () => {
    const runDir = makeRunDir();
    const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('password=demo-op-pass\r\n', 'utf16le')]);
    const big = Buffer.from('password=demo-op-pass', 'utf16le').swap16();
    const fileLittle = put(runDir, 'pass-1/test-results/t/notes-le.txt', little);
    const fileBig = put(runDir, 'pass-1/test-results/t/notes-be.txt', big);
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result).tainted.sort(), ['pass-1/test-results/t/notes-be.txt', 'pass-1/test-results/t/notes-le.txt']);
    assert.deepEqual(result.clean, []);
    assert.ok(fs.readFileSync(fileLittle).equals(little));
    assert.ok(fs.readFileSync(fileBig).equals(big));
  });

  test('a UTF-16 file without a value is clean', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/t/notes.txt', Buffer.from('nothing to hide', 'utf16le'));
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(core(result), { rewritten: 0, tainted: [] });
    assert.deepEqual(result.clean, ['pass-1/test-results/t/notes.txt']);
  });

  test('clean holds every file that was read and found free of a value, a rewritten one included, and no tainted one', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/t/plain.txt', 'nothing here');
    put(runDir, 'pass-1/test-results/t/typed.txt', secretText);
    put(runDir, 'pass-1/test-results/t/blob.bin', Buffer.concat([Buffer.from([0, 1]), Buffer.from(ACCOUNT.login), Buffer.from([0])]));
    put(runDir, 'pass-1.json', '{}');
    put(runDir, 'pass-1/html/index.html', '<p>x</p>');
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT));
    assert.deepEqual(result.clean.sort(), ['pass-1/test-results/t/plain.txt', 'pass-1/test-results/t/typed.txt']);
    assert.deepEqual(result.tainted, ['pass-1/test-results/t/blob.bin']);
    assert.deepEqual(result.unlisted, []);
  });

  test('a directory that cannot be listed is reported as unlisted and nothing under it is clean', () => {
    const runDir = makeRunDir();
    put(runDir, 'pass-1/test-results/ok/a.txt', 'fine');
    put(runDir, 'pass-1/test-results/locked/b.txt', secretText);
    const readdir = (dir: string): fs.Dirent[] => {
      if (path.basename(dir) === 'locked') {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return fs.readdirSync(dir, { withFileTypes: true });
    };
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT), { readdir });
    assert.deepEqual(result.unlisted, ['pass-1/test-results/locked']);
    assert.deepEqual(result.clean, ['pass-1/test-results/ok/a.txt']);
    assert.deepEqual(core(result), { rewritten: 0, tainted: [] });
    assert.equal(fs.readFileSync(path.join(runDir, 'pass-1', 'test-results', 'locked', 'b.txt'), 'utf8'), secretText);
  });

  test('a run directory that cannot be listed is unlisted as a whole', () => {
    const readdir = (): fs.Dirent[] => {
      throw new Error('gone');
    };
    assert.deepEqual(redactRunDirectory(makeRunDir(), createRedactor(ACCOUNT), { readdir }).unlisted, ['.']);
  });

  test('a rewrite that fails twice and then works is done, after three attempts and with no temporary file left', () => {
    const runDir = makeRunDir();
    const file = put(runDir, 'pass-1.stderr.log', secretText);
    let attempts = 0;
    const rename = (from: string, to: string): void => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      fs.renameSync(from, to);
    };
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT), { rename });
    assert.equal(attempts, 3);
    assert.deepEqual(core(result), { rewritten: 1, tainted: [] });
    assert.equal(fs.readFileSync(file, 'utf8'), `login: ${MASK}\npassword: ${MASK}\n`);
    assert.deepEqual(fs.readdirSync(runDir), ['pass-1.stderr.log']);
  });

  test('a rewrite that never works is tried three times, then the file is tainted and stays', () => {
    const runDir = makeRunDir();
    const file = put(runDir, 'pass-1.stderr.log', secretText);
    let attempts = 0;
    const rename = (): void => {
      attempts += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    const result = redactRunDirectory(runDir, createRedactor(ACCOUNT), { rename });
    assert.equal(attempts, 3);
    assert.deepEqual(core(result), { rewritten: 0, tainted: ['pass-1.stderr.log'] });
    assert.equal(fs.readFileSync(file, 'utf8'), secretText);
  });

  test('a directory that does not exist gives an empty result and no exception', () => {
    assert.deepEqual(core(redactRunDirectory(path.join(WORK, 'missing'), createRedactor(ACCOUNT))), { rewritten: 0, tainted: [] });
  });

  test('a link to a directory is neither followed nor read', (context) => {
    const runDir = makeRunDir();
    const outside = path.join(WORK, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const outsideFile = path.join(outside, 'note.txt');
    fs.writeFileSync(outsideFile, secretText);
    try {
      fs.symlinkSync(outside, path.join(runDir, 'linked'), 'junction');
    } catch {
      context.skip('links cannot be created here');
      return;
    }
    assert.deepEqual(core(redactRunDirectory(runDir, createRedactor(ACCOUNT))), { rewritten: 0, tainted: [] });
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), secretText);
  });
});
