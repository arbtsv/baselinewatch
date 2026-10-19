// Tests for src/env.ts, src/suggest.ts and the shipped env template.
// Run: node --test test/env.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RETENTION_DAYS, loadEnv } from '../src/env.ts';
import { ConfigError } from '../src/errors.ts';
import { didYouMean, levenshtein } from '../src/suggest.ts';

const SECRET = 'secret-value-for-test';
const LOGIN = 'login-value-for-test';

type Json = Record<string, any>;

function baseEnv(): Json {
  return {
    environment: 'demo',
    locale: 'en',
    account: { login: LOGIN, password: SECRET },
    retention_days: 30,
    scenarios: {
      demo: { nodes: { 'node-1': 'http://127.0.0.1:4101/', 'node-2': 'http://127.0.0.1:4102/' } },
    },
  };
}

function tempFile(content: string | undefined, name = 'env.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-env-'));
  const file = path.join(dir, name);
  if (content !== undefined) {
    fs.writeFileSync(file, content);
  }
  return file;
}

function envFile(change?: (env: Json) => void): string {
  const env = baseEnv();
  change?.(env);
  return tempFile(JSON.stringify(env));
}

// A configuration error never carries the account values or a snippet of the file.
function assertConfigError(fn: () => unknown, pattern: RegExp): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    assert.equal(error.reason, 'config');
    assert.ok(path.isAbsolute(error.file), 'the error carries an absolute file path');
    assert.ok(error.message.startsWith('[config] '), `message starts with the prefix: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(SECRET), false, 'the message leaks the password');
    assert.equal(error.message.includes(LOGIN), false, 'the message leaks the login');
    return error;
  }
  assert.fail('expected a ConfigError but nothing was thrown');
}

describe('loadEnv: valid files', () => {
  test('the base file loads into the typed shape', () => {
    assert.deepEqual(loadEnv(envFile()), baseEnv());
  });

  test('retention_days defaults to 30 when absent', () => {
    const env = loadEnv(envFile((e) => delete e.retention_days));
    assert.equal(env.retention_days, 30);
    assert.equal(env.retention_days, DEFAULT_RETENTION_DAYS);
  });

  test('retention_days of 0 is accepted and kept', () => {
    assert.equal(loadEnv(envFile((e) => (e.retention_days = 0))).retention_days, 0);
  });

  test('a JSON negative zero is stored as a plain zero', () => {
    const text = JSON.stringify(baseEnv()).replace('"retention_days":30', '"retention_days":-0');
    assert.ok(Object.is(loadEnv(tempFile(text)).retention_days, 0));
  });

  test('both locales are accepted', () => {
    assert.equal(loadEnv(envFile((e) => (e.locale = 'ru'))).locale, 'ru');
  });

  test('a byte order mark and CRLF line endings load', () => {
    const text = JSON.stringify(baseEnv(), null, 2).replaceAll('\n', '\r\n');
    assert.deepEqual(loadEnv(tempFile('\uFEFF' + text)), baseEnv());
  });

  test('node URLs are kept exactly as written', () => {
    const env = loadEnv(envFile((e) => (e.scenarios.demo.nodes['node-1'] = 'https://portal.example.com:8443/app?x=1')));
    assert.equal(env.scenarios.demo.nodes['node-1'], 'https://portal.example.com:8443/app?x=1');
  });

  test('a scenario or node named constructor loads as an own key', () => {
    const env = loadEnv(envFile((e) => (e.scenarios = { constructor: { nodes: { constructor: 'http://127.0.0.1:1/' } } })));
    assert.equal(Object.hasOwn(env.scenarios, 'constructor'), true);
    const key: string = 'constructor';
    assert.equal(Object.hasOwn(env.scenarios[key].nodes, 'constructor'), true);
  });

  test('the result is a fresh object on every call and the file is read again', () => {
    const file = envFile();
    const first = loadEnv(file);
    assert.notEqual(loadEnv(file), first);
    const changed = baseEnv();
    changed.environment = 'changed';
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.equal(loadEnv(file).environment, 'changed');
  });

  test('loading does not write to the directory', () => {
    const file = envFile();
    const before = fs.readdirSync(path.dirname(file));
    loadEnv(file);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), before);
  });
});

describe('loadEnv: file problems', () => {
  test('a missing file names env.json and says how to create it', () => {
    const file = tempFile(undefined);
    const error = assertConfigError(() => loadEnv(file), /file not found .*env\.json/);
    assert.match(error.message, /Create it from env\.example\.json/);
  });

  for (const [name, content] of [
    ['an empty file', ''],
    ['a whitespace-only file', ' \r\n\t \n'],
  ] as const) {
    test(`${name} is reported as empty`, () => {
      assertConfigError(() => loadEnv(tempFile(content)), /file is empty/);
    });
  }

  test('broken JSON reports line and column but never the file text', () => {
    const file = tempFile(`{\n  "account": { "password": "${SECRET}" "x": 1 }\n}`);
    assertConfigError(() => loadEnv(file), /not valid JSON \(line 2, column \d+\)/);
  });

  test('broken JSON with a stray token never echoes the parser snippet', () => {
    const file = tempFile(`{\n  "account": { "password": ${SECRET} }\n}`);
    assertConfigError(() => loadEnv(file), /not valid JSON/);
  });

  test('a top-level array or number is not an env file', () => {
    assertConfigError(() => loadEnv(tempFile('[]')), /must be a JSON object/);
    assertConfigError(() => loadEnv(tempFile('7')), /must be a JSON object/);
    assertConfigError(() => loadEnv(tempFile('null')), /must be a JSON object/);
  });

  test('an empty object reports the first missing required key', () => {
    assertConfigError(() => loadEnv(tempFile('{}')), /missing "environment"/);
  });
});

describe('loadEnv: unknown keys and hints', () => {
  test('retention_day gets the hint retention_days', () => {
    assertConfigError(
      () => loadEnv(envFile((e) => (e.retention_day = 30))),
      /unknown key "retention_day" \(did you mean "retention_days"\?\)/,
    );
  });

  test('Environment is compared case-sensitively and gets a hint', () => {
    assertConfigError(
      () => loadEnv(envFile((e) => (e.Environment = 'x'))),
      /unknown key "Environment" \(did you mean "environment"\?\)/,
    );
  });

  test('a renamed required key is reported as unknown before it is reported as missing', () => {
    assertConfigError(
      () =>
        loadEnv(
          envFile((e) => {
            e.Environment = e.environment;
            delete e.environment;
          }),
        ),
      /unknown key "Environment" \(did you mean "environment"\?\)/,
    );
  });

  test('a far-off key is unknown and has no hint', () => {
    const error = assertConfigError(() => loadEnv(envFile((e) => (e.colour = 'red'))), /unknown key "colour"/);
    assert.equal(error.message.includes('did you mean'), false);
  });

  test('an account key pasword gets the hint password', () => {
    assertConfigError(
      () =>
        loadEnv(
          envFile((e) => {
            e.account = { login: LOGIN, pasword: SECRET };
          }),
        ),
      /account: unknown key "pasword" \(did you mean "password"\?\)/,
    );
  });

  test('a scenario key node gets the hint nodes', () => {
    assertConfigError(
      () => loadEnv(envFile((e) => (e.scenarios.demo = { node: { 'node-1': 'http://127.0.0.1:1/' } }))),
      /scenarios\.demo: unknown key "node" \(did you mean "nodes"\?\)/,
    );
  });

  test('a long unknown key is cut and control characters are hidden', () => {
    const long = 'k'.repeat(100);
    const error = assertConfigError(() => loadEnv(envFile((e) => (e[long] = 1))), /unknown key "k{40}"/);
    assert.equal(error.message.includes('k'.repeat(41)), false);
    const odd = assertConfigError(() => loadEnv(envFile((e) => (e['a\nb'] = 1))), /unknown key "a\?b"/);
    assert.equal(odd.message.includes('\n'), false);
  });
});

describe('loadEnv: missing keys', () => {
  for (const key of ['environment', 'locale', 'account', 'scenarios']) {
    test(`a missing ${key} is reported`, () => {
      const error = assertConfigError(() => loadEnv(envFile((e) => delete e[key])), new RegExp(`missing "${key}"`));
      assert.match(error.message, /Add it as in env\.example\.json/);
    });
  }

  test('a missing account login or password is reported', () => {
    assertConfigError(() => loadEnv(envFile((e) => delete e.account.login)), /account: missing "login"/);
    assertConfigError(() => loadEnv(envFile((e) => delete e.account.password)), /account: missing "password"/);
  });

  test('a scenario without nodes is reported', () => {
    assertConfigError(() => loadEnv(envFile((e) => (e.scenarios.demo = {}))), /scenarios\.demo: missing "nodes"/);
  });
});

describe('loadEnv: invalid values', () => {
  const cases: [name: string, change: (env: Json) => void, pattern: RegExp][] = [
    ['an unsupported locale', (e) => (e.locale = 'de'), /locale must be "en" or "ru"/],
    ['an upper-case locale', (e) => (e.locale = 'EN'), /locale must be "en" or "ru"/],
    ['an empty environment', (e) => (e.environment = ''), /environment must be a non-empty string/],
    ['a numeric environment', (e) => (e.environment = 5), /environment must be a non-empty string/],
    ['an empty password', (e) => (e.account.password = ''), /account\.password must be a non-empty string/],
    ['a numeric login', (e) => (e.account.login = 123), /account\.login must be a non-empty string/],
    ['an account that is not an object', (e) => (e.account = 'x'), /account must be an object/],
    ['an account array', (e) => (e.account = []), /account must be an object/],
    ['no scenarios', (e) => (e.scenarios = {}), /scenarios must name at least one scenario/],
    ['scenarios that is an array', (e) => (e.scenarios = []), /scenarios must be an object/],
    ['a scenario that is not an object', (e) => (e.scenarios.demo = 'x'), /scenarios\.demo must be an object/],
    ['a scenario without any node', (e) => (e.scenarios.demo = { nodes: {} }), /scenarios\.demo\.nodes must name at least one node/],
    ['nodes that is an array', (e) => (e.scenarios.demo = { nodes: [] }), /scenarios\.demo\.nodes must be an object/],
    ['an upper-case scenario name', (e) => (e.scenarios = { Demo: { nodes: { 'node-1': 'http://127.0.0.1:1/' } } }), /scenario name "Demo" must be 1-64 lowercase/],
    ['a scenario name with a double dash', (e) => (e.scenarios = { 'a--b': { nodes: { 'node-1': 'http://127.0.0.1:1/' } } }), /scenario name "a--b" must be 1-64 lowercase/],
    ['a reserved scenario name', (e) => (e.scenarios = { con: { nodes: { 'node-1': 'http://127.0.0.1:1/' } } }), /scenario name "con" is a reserved device name/],
    ['a node name with a space', (e) => (e.scenarios.demo.nodes = { 'node 1': 'http://127.0.0.1:1/' }), /node name "node 1" must be 1-64 lowercase/],
    ['a node name that is __proto__', (e) => (e.scenarios.demo.nodes = JSON.parse('{"__proto__":"http://127.0.0.1:1/"}')), /node name "__proto__"/],
    ['an ftp URL', (e) => (e.scenarios.demo.nodes['node-1'] = 'ftp://x.test/'), /scenarios\.demo\.nodes\.node-1 must be an http or https URL/],
    ['a file URL', (e) => (e.scenarios.demo.nodes['node-1'] = 'file:///etc/hosts'), /must be an http or https URL/],
    ['a URL that is not a URL', (e) => (e.scenarios.demo.nodes['node-1'] = 'not a url'), /must be an http or https URL/],
    ['a URL that is not a string', (e) => (e.scenarios.demo.nodes['node-1'] = 4101), /must be an http or https URL/],
    ['a URL with a password only', (e) => (e.scenarios.demo.nodes['node-1'] = 'http://:pw@x.test/'), /must be an http or https URL/],
    ['retention_days below zero', (e) => (e.retention_days = -1), /retention_days must be a whole number of days, 0 or more/],
    ['a fractional retention_days', (e) => (e.retention_days = 1.5), /retention_days must be a whole number of days/],
    ['a string retention_days', (e) => (e.retention_days = '30'), /retention_days must be a whole number of days/],
    ['a null retention_days', (e) => (e.retention_days = null), /retention_days must be a whole number of days/],
  ];
  for (const [name, change, pattern] of cases) {
    test(`${name} is a configuration error`, () => {
      assertConfigError(() => loadEnv(envFile(change)), pattern);
    });
  }

  test('a URL with a user name is rejected and never echoed', () => {
    const error = assertConfigError(
      () => loadEnv(envFile((e) => (e.scenarios.demo.nodes['node-1'] = 'http://user:pw@x.test/'))),
      /must be an http or https URL without user name or password/,
    );
    assert.equal(error.message.includes('user:pw'), false);
    assert.equal(error.message.includes('x.test'), false);
  });

  test('a scenario name __proto__ is rejected and no prototype is polluted', () => {
    const text = '{"environment":"demo","locale":"en","account":{"login":"a","password":"b"},"scenarios":{"__proto__":{"nodes":{"n":"http://127.0.0.1:1/"}}}}';
    assertConfigError(() => loadEnv(tempFile(text)), /scenario name "__proto__"/);
    assert.equal((({}) as Record<string, unknown>).nodes, undefined);
  });
});

describe('levenshtein and didYouMean', () => {
  test('edit distance', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('same', 'same'), 0);
    assert.equal(levenshtein('node', 'nodes'), 1);
  });

  const keys = ['environment', 'locale', 'account', 'retention_days', 'scenarios'];
  test('a near miss gets the closest candidate', () => {
    assert.equal(didYouMean('retention_day', keys), 'retention_days');
    assert.equal(didYouMean('Environment', keys), 'environment');
    assert.equal(didYouMean('acount', keys), 'account');
  });

  test('a far-off input gets nothing', () => {
    assert.equal(didYouMean('colour', keys), undefined);
    assert.equal(didYouMean('', keys), undefined);
    assert.equal(didYouMean('x', []), undefined);
  });

  test('the allowed distance shrinks with the candidate length', () => {
    assert.equal(didYouMean('abx', ['abc']), 'abc');
    assert.equal(didYouMean('axx', ['abc']), undefined);
    assert.equal(didYouMean('nod', ['nodes']), 'nodes');
    assert.equal(didYouMean('nd', ['nodes']), undefined);
  });

  test('the closest of several candidates wins', () => {
    assert.equal(didYouMean('node', ['nodes', 'node-1x']), 'nodes');
  });
});

describe('the shipped template', () => {
  const root = path.join(import.meta.dirname, '..');
  const template = path.join(root, 'templates', 'env.example.json');
  const demoCopy = path.join(root, 'examples', 'demo-portal', 'env.example.json');

  test('it loads through loadEnv with placeholder credentials', () => {
    const env = loadEnv(template);
    assert.deepEqual(env.account, { login: '<login>', password: '<password>' });
    assert.equal(env.retention_days, 30);
    assert.ok(Object.keys(env.scenarios).length >= 1);
  });

  test('every node URL is a loopback address', () => {
    const env = loadEnv(template);
    for (const scenario of Object.values(env.scenarios)) {
      for (const url of Object.values(scenario.nodes)) {
        assert.equal(new URL(url).hostname, '127.0.0.1');
      }
    }
  });

  test('the demo project copy is byte-for-byte identical', () => {
    assert.equal(Buffer.compare(fs.readFileSync(template), fs.readFileSync(demoCopy)), 0);
  });
});
