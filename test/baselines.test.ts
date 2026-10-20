// Tests for src/baselines.ts and the configuration error in src/errors.ts.
// Run: node --test test/baselines.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBaselines } from '../src/baselines.ts';
import { ConfigError, isConfigError } from '../src/errors.ts';

function tempFile(content: string | undefined, name = 'baselines.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-baselines-'));
  const file = path.join(dir, name);
  if (content !== undefined) {
    fs.writeFileSync(file, content);
  }
  return file;
}

function assertConfigError(fn: () => unknown, pattern: RegExp): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    assert.equal(error.reason, 'config');
    assert.ok(path.isAbsolute(error.file), 'the error carries an absolute file path');
    assert.ok(error.message.startsWith('[config] '), `message starts with the prefix: ${error.message}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail('expected a ConfigError but nothing was thrown');
}

const VALID = {
  demo: {
    login_ms: { reference_ms: 300, maxRatio: 3 },
    overview_ms: { reference_ms: 250.5, maxRatio: 2 },
  },
};

describe('loadBaselines: valid files', () => {
  test('a valid file loads into the expected table', () => {
    const file = tempFile(JSON.stringify(VALID));
    assert.deepEqual(loadBaselines(file), VALID);
  });

  test('extra keys inside an entry are ignored without a throw or a warning', (t) => {
    const warn = t.mock.method(console, 'warn');
    const emit = t.mock.method(process, 'emitWarning');
    const file = tempFile(
      JSON.stringify({
        demo: { login_ms: { reference_ms: 300, maxRatio: 3, approved_by: 'someone', approved_at: '2026-01-01', note: 'x' } },
      }),
    );
    const table = loadBaselines(file);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(emit.mock.callCount(), 0);
    assert.deepEqual(Object.keys(table.demo.login_ms).sort(), ['maxRatio', 'reference_ms']);
  });

  test('a byte order mark and CRLF line endings load', () => {
    const text = JSON.stringify(VALID, null, 2).replaceAll('\n', '\r\n');
    const file = tempFile('\uFEFF' + text);
    assert.deepEqual(loadBaselines(file), VALID);
  });

  test('an empty object is a valid empty table', () => {
    assert.deepEqual(loadBaselines(tempFile('{}')), {});
  });

  test('a scenario mapped to an empty object has no metrics', () => {
    assert.deepEqual(loadBaselines(tempFile('{"demo":{}}')), { demo: {} });
  });

  test('a metric named constructor loads as an own key', () => {
    const file = tempFile(JSON.stringify({ demo: { constructor: { reference_ms: 10, maxRatio: 2 } } }));
    const table = loadBaselines(file);
    assert.equal(Object.hasOwn(table.demo, 'constructor'), true);
    assert.deepEqual(table.demo.constructor, { reference_ms: 10, maxRatio: 2 });
    assert.equal(Object.hasOwn(table.demo, 'login_ms'), false);
  });

  test('the file is read again on every call', () => {
    const file = tempFile(JSON.stringify(VALID));
    assert.equal(loadBaselines(file).demo.login_ms.reference_ms, 300);
    fs.writeFileSync(file, JSON.stringify({ demo: { login_ms: { reference_ms: 400, maxRatio: 4 } } }));
    assert.deepEqual(loadBaselines(file), { demo: { login_ms: { reference_ms: 400, maxRatio: 4 } } });
  });

  test('loading does not write to the directory', () => {
    const file = tempFile(JSON.stringify(VALID));
    const before = fs.readdirSync(path.dirname(file));
    loadBaselines(file);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), before);
  });
});

describe('loadBaselines: file problems', () => {
  test('a missing file names baselines.json', () => {
    const file = tempFile(undefined);
    const error = assertConfigError(() => loadBaselines(file), /file not found .*baselines\.json/);
    assert.match(error.message, /Create baselines\.json/);
  });

  for (const [name, content] of [
    ['an empty file', ''],
    ['a whitespace-only file', ' \r\n\t \n'],
  ] as const) {
    test(`${name} is reported as empty`, () => {
      assertConfigError(() => loadBaselines(tempFile(content)), /file is empty/);
    });
  }

  test('broken JSON reports line and column but never the file text', () => {
    const file = tempFile('{\n  "demo": 1 "SNIPPET_MARKER": SNIPPET_MARKER\n}');
    const error = assertConfigError(() => loadBaselines(file), /not valid JSON \(line 2, column \d+\)/);
    assert.equal(error.message.includes('SNIPPET_MARKER'), false);
  });

  test('broken JSON that starts with a stray token never echoes it', () => {
    const file = tempFile('SNIPPET_MARKER {');
    const error = assertConfigError(() => loadBaselines(file), /not valid JSON/);
    assert.equal(error.message.includes('SNIPPET_MARKER'), false);
  });

  test('a directory in place of the file is a read problem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-baselines-'));
    assertConfigError(() => loadBaselines(dir), /file cannot be read/);
  });
});

describe('loadBaselines: invalid content', () => {
  const cases: [name: string, content: string, pattern: RegExp][] = [
    ['a top-level array', '[]', /must be a JSON object that maps scenario names to metrics/],
    ['a top-level number', '5', /must be a JSON object/],
    ['a top-level null', 'null', /must be a JSON object/],
    ['reference_ms of 0', '{"demo":{"login_ms":{"reference_ms":0,"maxRatio":3}}}', /scenario "demo", metric "login_ms": reference_ms must be a number above 0/],
    ['a negative reference_ms', '{"demo":{"login_ms":{"reference_ms":-1,"maxRatio":3}}}', /reference_ms must be a number above 0/],
    ['a string reference_ms', '{"demo":{"login_ms":{"reference_ms":"300","maxRatio":3}}}', /reference_ms must be a number above 0/],
    ['a missing reference_ms', '{"demo":{"login_ms":{"maxRatio":3}}}', /reference_ms must be a number above 0/],
    ['maxRatio below 1', '{"demo":{"login_ms":{"reference_ms":300,"maxRatio":0.5}}}', /maxRatio must be a number of at least 1/],
    ['a missing maxRatio', '{"demo":{"login_ms":{"reference_ms":300}}}', /maxRatio must be a number of at least 1/],
    ['an entry that is not an object', '{"demo":{"login_ms":300}}', /the entry must be an object/],
    ['a scenario that is not an object', '{"demo":[]}', /scenario "demo" must be an object/],
    ['an invalid scenario name', '{"Demo":{}}', /scenario name "Demo" must be 1-64 lowercase letters or digits/],
    ['an invalid metric name', '{"demo":{"Login":{"reference_ms":300,"maxRatio":3}}}', /metric name "Login" must start with a lowercase letter/],
  ];
  for (const [name, content, pattern] of cases) {
    test(`${name} is a configuration error`, () => {
      assertConfigError(() => loadBaselines(tempFile(content)), pattern);
    });
  }

  test('a metric key __proto__ is rejected and no prototype is polluted', () => {
    const file = tempFile('{"demo":{"__proto__":{"reference_ms":1,"maxRatio":1}}}');
    assertConfigError(() => loadBaselines(file), /metric name "__proto__"/);
    assert.equal((({}) as Record<string, unknown>).reference_ms, undefined);
    assert.equal((({}) as Record<string, unknown>).maxRatio, undefined);
  });

  test('a scenario key __proto__ is rejected', () => {
    const file = tempFile('{"__proto__":{"login_ms":{"reference_ms":1,"maxRatio":1}}}');
    assertConfigError(() => loadBaselines(file), /scenario name "__proto__"/);
    assert.equal((({}) as Record<string, unknown>).login_ms, undefined);
  });

  test('a long invalid name is cut in the message', () => {
    const long = 'A'.repeat(100);
    const error = assertConfigError(() => loadBaselines(tempFile(`{"${long}":{}}`)), /scenario name "A{40}" must be/);
    assert.equal(error.message.includes('A'.repeat(41)), false);
  });
});

describe('ConfigError', () => {
  test('the message has the documented form and the stack is one line', () => {
    const file = path.join(os.tmpdir(), 'blw-baselines-form', 'baselines.json');
    const error = new ConfigError(file, 'something is wrong', 'Do the thing');
    assert.equal(error.name, 'ConfigError');
    assert.equal(error.reason, 'config');
    assert.equal(error.file, path.resolve(file));
    assert.equal(error.message, `[config] ${path.resolve(file)}: something is wrong. Do the thing.`);
    assert.equal(error.stack, `ConfigError: ${error.message}`);
  });

  test('a file inside the working directory is shown relative to it', () => {
    const file = path.join(process.cwd(), 'some-dir', 'env.json');
    const error = new ConfigError(file, 'p', 'f');
    assert.equal(error.message, `[config] ${path.join('some-dir', 'env.json')}: p. f.`);
  });

  test('isConfigError recognises the reason field and nothing else', () => {
    assert.equal(isConfigError(new ConfigError('x.json', 'p', 'f')), true);
    assert.equal(isConfigError({ reason: 'config' }), true);
    assert.equal(isConfigError(new Error('x')), false);
    assert.equal(isConfigError({ reason: 'locked' }), false);
    assert.equal(isConfigError(null), false);
    assert.equal(isConfigError('config'), false);
  });
});
