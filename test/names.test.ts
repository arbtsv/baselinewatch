// Tests for src/names.ts: the name rules for scenarios, nodes and metrics.
// Run: node --test test/names.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NAME_LENGTH, METRIC_PATTERN, NAME_PATTERN, WHOLE_WORD_BELOW, leakedField, nameProblem } from '../src/names.ts';
import { MIN_REDACT_LENGTH } from '../src/protocol.ts';

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

describe('account values in names', () => {
  const account = (login: string, password = 'placeholder-password') => ({ login, password });

  test('a value of three characters is a leak wherever it sits in the name', () => {
    assert.equal(leakedField(account('ops'), 'ops_page_ms'), 'login');
    assert.equal(leakedField(account('ops'), 'page_ops'), 'login');
    assert.equal(leakedField(account('ops'), 'opsview_page_ms'), 'login');
    assert.equal(leakedField(account('ops'), 'my_loopsy_ms'), 'login');
    assert.equal(leakedField(account('ops'), 'page_ms'), undefined);
  });

  test('a value shorter than the redaction minimum is a leak only as a whole word', () => {
    assert.equal(leakedField(account('ab'), 'ab_page_ms'), 'login');
    assert.equal(leakedField(account('ab'), 'page_ab'), 'login');
    assert.equal(leakedField(account('ab'), 'abview_page_ms'), undefined);
    assert.equal(leakedField(account('ab'), 'label_ms'), undefined);
  });

  test('the password is checked the same way', () => {
    assert.equal(leakedField(account('some-login', 'pw9'), 'xpw9y_ms'), 'password');
  });

  test('a one-word name equal to a short login is a leak', () => {
    assert.equal(leakedField(account('node'), 'node_ms'), 'login');
  });

  test('the comparison ignores case on both sides', () => {
    assert.equal(leakedField(account('Operator1'), 'my_operator1_ms'), 'login');
    assert.equal(leakedField(account('Operator1'), 'MY_OPERATOR1_MS'), 'login');
  });

  test('a value with an underscore is found inside a name too', () => {
    assert.equal(leakedField(account('a_b'), 'x_a_b_y'), 'login');
    assert.equal(leakedField(account('a_b'), 'x_a_by'), 'login');
    assert.equal(leakedField(account('a_b'), 'x_ab_y'), undefined);
  });

  test('the substring rule starts at the redaction minimum', () => {
    assert.equal(WHOLE_WORD_BELOW, MIN_REDACT_LENGTH);
    assert.equal(leakedField(account('abc'), 'xabcx_ms'), 'login');
    assert.equal(leakedField(account('ab'), 'xabx_ms'), undefined);
  });

  test('a value with a character outside the metric alphabet is skipped', () => {
    const dashed = account('demo-operator', 'demo-password-not-secret');
    for (const name of ['demo_operator_ms', 'demo', 'login_ms', 'demo_password_not_secret']) {
      assert.equal(leakedField(dashed, name), undefined, name);
    }
  });

  test('scenario names treat - as a second word separator', () => {
    assert.equal(leakedField(account('demo-operator'), 'demo-operator-check', 'scenario'), 'login');
    assert.equal(leakedField(account('qa'), 'qa-portal', 'scenario'), 'login');
    assert.equal(leakedField(account('qa'), 'portal_qa', 'scenario'), 'login');
    assert.equal(leakedField(account('qa'), 'qatar', 'scenario'), undefined);
    assert.equal(leakedField(account('qa'), 'qa-portal', 'node'), 'login');
  });

  test('a password hit gives password', () => {
    assert.equal(leakedField(account('placeholder-login', 'pw9'), 'page_pw9_ms'), 'password');
  });

  test('when both fields hit, login comes first', () => {
    assert.equal(leakedField(account('ops', 'pw9'), 'ops_pw9_ms'), 'login');
  });

  test('an empty value never hits', () => {
    assert.equal(leakedField(account('', ''), 'login_ms'), undefined);
  });
});

describe('exported constants', () => {
  test('the limits and patterns match the rules', () => {
    assert.equal(MAX_NAME_LENGTH, 64);
    assert.ok(NAME_PATTERN.test('a-b_c'));
    assert.ok(METRIC_PATTERN.test('a_b'));
  });
});
