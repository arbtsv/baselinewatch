// Tests for src/quiet.ts: a cleanup that never throws and never changes an outcome.
// Run: node --test test/quiet.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeQuietly } from '../src/quiet.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-quiet-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

describe('removeQuietly', () => {
  test('removes a file', () => {
    const file = path.join(WORK, 'a.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(removeQuietly(file), true);
    assert.equal(fs.existsSync(file), false);
  });

  test('removes a directory with its content when recursive is set', () => {
    const dir = path.join(WORK, 'tree');
    fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'inner', 'b.txt'), 'x');
    assert.equal(removeQuietly(dir, { recursive: true }), true);
    assert.equal(fs.existsSync(dir), false);
  });

  test('a target that does not exist counts as gone', () => {
    assert.equal(removeQuietly(path.join(WORK, 'missing')), true);
    assert.equal(removeQuietly(path.join(WORK, 'missing-dir'), { recursive: true }), true);
  });

  test('a target that cannot be removed gives false and never throws', () => {
    // A directory removed as a file throws on every platform; the content stays.
    const dir = path.join(WORK, 'held');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    assert.equal(removeQuietly(dir), false);
    assert.equal(fs.existsSync(path.join(dir, 'c.txt')), true);
  });
});
