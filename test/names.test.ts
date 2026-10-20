// Tests for src/names.ts: the name rules for scenarios, nodes and metrics.
// Run: node --test test/names.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NAME_LENGTH, METRIC_PATTERN, NAME_PATTERN, nameProblem } from '../src/names.ts';

describe('scenario and node names', () => {
  const valid = ['a', 'demo', 'node-1', 'my_portal', 'a1-b2_c3', 'a'.repeat(64)];
  const rejected = [
    '',
    'Demo',
    'a--b',
    '-a',
    'a-',
    'a__b',
    'a_-b',
    'a b',
    '../x',
    'a/b',
    'a.b',
    'a*',
    '__proto__',
    'con',
    'lpt1',
    'a'.repeat(65),
  ];
  for (const kind of ['scenario', 'node'] as const) {
    for (const name of valid) {
      test(`${kind} name ${JSON.stringify(name.length > 20 ? `${name.length} characters` : name)} is valid`, () => {
        assert.equal(nameProblem(kind, name), undefined);
      });
    }
    for (const name of rejected) {
      test(`${kind} name ${JSON.stringify(name.length > 20 ? `${name.length} characters` : name)} is rejected`, () => {
        assert.equal(typeof nameProblem(kind, name), 'string');
      });
    }
  }

  test('the plain rule and the device-name rule have different texts', () => {
    assert.match(nameProblem('scenario', 'Demo') ?? '', /1-64 lowercase letters or digits, separated by single - or _/);
    assert.match(nameProblem('node', 'nul') ?? '', /reserved device name on Windows/);
  });

  test('a non-string is rejected', () => {
    assert.equal(typeof nameProblem('scenario', 5 as unknown as string), 'string');
  });
});

describe('metric names', () => {
  const valid = ['login_ms', 'a', 'a1', 'constructor', 'a'.repeat(64)];
  const rejected = ['', '1a', 'Login', 'a-b', '_a', '__proto__', 'a b', 'a'.repeat(65)];
  for (const name of valid) {
    test(`metric name ${JSON.stringify(name.length > 20 ? `${name.length} characters` : name)} is valid`, () => {
      assert.equal(nameProblem('metric', name), undefined);
    });
  }
  for (const name of rejected) {
    test(`metric name ${JSON.stringify(name.length > 20 ? `${name.length} characters` : name)} is rejected`, () => {
      assert.match(nameProblem('metric', name) ?? '', /must start with a lowercase letter/);
    });
  }
});

describe('exported constants', () => {
  test('the limits and patterns match the rules', () => {
    assert.equal(MAX_NAME_LENGTH, 64);
    assert.ok(NAME_PATTERN.test('a-b_c'));
    assert.ok(METRIC_PATTERN.test('a_b'));
  });
});
