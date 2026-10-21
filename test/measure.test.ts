// Tests for src/measure.ts and the screenshot options in src/protocol.ts.
// Run: node --test test/measure.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../src/errors.ts';
import { createMeasure, finishMessage, slowMessage, type MeasureDeps, type MeasureSession } from '../src/measure.ts';
import {
  MASK_COLOR,
  SCREENSHOT_TIMEOUT_MS,
  screenshotOptions,
  type MetricRecord,
} from '../src/protocol.ts';

const BASELINES_FILE = path.join(os.tmpdir(), 'blw-measure-test', 'baselines.json');
const BASELINES = {
  login_ms: { reference_ms: 300, maxRatio: 3 },
  overview_ms: { reference_ms: 300, maxRatio: 3 },
  history_ms: { reference_ms: 300, maxRatio: 3 },
  operator1_ms: { reference_ms: 300, maxRatio: 3 },
  x_pw_secret_9: { reference_ms: 300, maxRatio: 3 },
};

type Harness = {
  session: MeasureSession;
  titles: string[];
  annotated: MetricRecord[];
  calls: () => number;
  fn: <T>(value: T) => () => Promise<T>;
};

// Builds a session over fakes. `times` are the values the clock returns, in order: two per measured
// step, the start and the end.
function harness(times: number[] = [], overrides: Partial<MeasureDeps> = {}): Harness {
  const queue = [...times];
  const titles: string[] = [];
  const annotated: MetricRecord[] = [];
  let called = 0;
  const session = createMeasure({
    scenario: 'demo',
    baselines: BASELINES,
    baselinesFile: BASELINES_FILE,
    account: { login: 'Operator1', password: 'pw_secret_9' },
    step: async (title, body) => {
      titles.push(title);
      return body();
    },
    now: () => {
      const next = queue.shift();
      assert.notEqual(next, undefined, 'the test queued too few clock values');
      return next as number;
    },
    annotate: (record) => {
      annotated.push(record);
    },
    ...overrides,
  });
  return {
    session,
    titles,
    annotated,
    calls: () => called,
    fn: (value) => async () => {
      called += 1;
      return value;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the measure call to reject');
}

describe('measure: a measured step', () => {
  test('returns the value of fn, runs one step titled with the metric name and times fn only', async () => {
    const h = harness([100, 350]);
    const value = await h.session.measure('login_ms', h.fn('result'));
    assert.equal(value, 'result');
    assert.deepEqual(h.titles, ['login_ms']);
    assert.equal(h.calls(), 1);
    assert.equal(h.annotated[0]?.ms, 250);
  });

  test('a synchronous fn is accepted', async () => {
    const h = harness([0, 10]);
    assert.equal(await h.session.measure('login_ms', () => 7), 7);
  });

  const verdicts: [string, number, 'ok' | 'slow'][] = [
    ['well under the limit', 100, 'ok'],
    ['exactly at the limit (3 x 300 ms)', 900, 'ok'],
    ['one millisecond over the limit', 901, 'slow'],
  ];
  for (const [title, ms, verdict] of verdicts) {
    test(`${title}: ${ms} ms is ${verdict}`, async () => {
      const h = harness([0, ms]);
      await h.session.measure('login_ms', h.fn(null));
      assert.equal(h.annotated[0]?.verdict, verdict);
      assert.equal(h.session.slowMessages().length, verdict === 'slow' ? 1 : 0);
    });
  }

  test('the annotation has exactly the six keys and keeps ms and ratio unrounded', async () => {
    const h = harness([10.25, 310.75]);
    await h.session.measure('login_ms', h.fn(null));
    const [record] = h.annotated as [MetricRecord];
    assert.deepEqual(Object.keys(record).sort(), ['maxRatio', 'ms', 'name', 'ratio', 'reference_ms', 'verdict']);
    assert.deepEqual(record, {
      name: 'login_ms',
      ms: 300.5,
      reference_ms: 300,
      maxRatio: 3,
      ratio: 300.5 / 300,
      verdict: 'ok',
    });
    assert.deepEqual(h.session.records(), [record]);
  });

  test('when fn throws, the error propagates and nothing is recorded', async () => {
    const h = harness([0]);
    const failure = new Error('page crashed');
    const error = await rejection(
      h.session.measure('login_ms', async () => {
        throw failure;
      }),
    );
    assert.equal(error, failure);
    assert.deepEqual(h.annotated, []);
    assert.deepEqual(h.session.records(), []);
    assert.deepEqual(h.session.slowMessages(), []);
  });

  test('a session without any measure has no records, no slow messages and no finish message', () => {
    const h = harness();
    assert.deepEqual(h.session.records(), []);
    assert.deepEqual(h.session.slowMessages(), []);
    assert.equal(finishMessage(h.session.slowMessages()), undefined);
  });

  test('records and slow messages follow the order of the measure calls', async () => {
    const h = harness([0, 100, 0, 1000, 0, 2000]);
    await h.session.measure('login_ms', h.fn(null));
    await h.session.measure('overview_ms', h.fn(null));
    await h.session.measure('history_ms', h.fn(null));
    assert.deepEqual(
      h.annotated.map((record) => record.name),
      ['login_ms', 'overview_ms', 'history_ms'],
    );
    assert.deepEqual(
      h.session.records().map((record) => record.name),
      ['login_ms', 'overview_ms', 'history_ms'],
    );
    const slow = h.session.slowMessages();
    assert.equal(slow.length, 2);
    assert.match(slow[0] as string, /^overview_ms 1000 ms/);
    assert.match(slow[1] as string, /^history_ms 2000 ms/);
    assert.equal(finishMessage(slow), `[slow] ${slow[0]}; ${slow[1]}`);
  });
});

describe('measure: checks before fn runs', () => {
  test('a missing baseline is a configuration error naming scenario, metric and file', async () => {
    const h = harness();
    const spy = h.fn(null);
    const error = await rejection(h.session.measure('unknown_ms', spy));
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error.name}`);
    assert.equal(error.reason, 'config');
    assert.equal(error.file, path.resolve(BASELINES_FILE));
    assert.match(error.message, /^\[config\] /);
    assert.ok(error.message.includes('scenario "demo"'), error.message);
    assert.ok(error.message.includes('"unknown_ms"'), error.message);
    assert.ok(error.message.includes(BASELINES_FILE), error.message);
    assert.equal(h.calls(), 0);
    assert.deepEqual(h.titles, []);
    assert.deepEqual(h.annotated, []);
  });

  test('a name that is an Object.prototype key has no baseline', async () => {
    const h = harness();
    const error = await rejection(h.session.measure('constructor', h.fn(null)));
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error.name}`);
    assert.equal(h.calls(), 0);
  });

  const secretNames: [string, string][] = [
    ['the login in lower case', 'operator1_ms'],
    ['the login in upper case', 'OPERATOR1_ms'],
    ['the login in its own case', 'Operator1'],
    ['the password inside a longer name', 'x_pw_secret_9'],
    ['the password in upper case', 'X_PW_SECRET_9'],
  ];
  for (const [title, name] of secretNames) {
    test(`a name with ${title} is rejected without repeating it`, async () => {
      const h = harness();
      const error = await rejection(h.session.measure(name, h.fn(null)));
      assert.ok(!(error instanceof ConfigError));
      assert.ok(error.message.includes('login or password'), error.message);
      assert.ok(!error.message.includes(name), `the message repeats the name: ${error.message}`);
      assert.ok(!error.message.toLowerCase().includes(name.toLowerCase()));
      assert.equal(h.calls(), 0);
      assert.deepEqual(h.titles, []);
    });
  }

  test('an empty password is not matched against every name', async () => {
    const h = harness([0, 10], { account: { login: 'Operator1', password: '' } });
    await h.session.measure('login_ms', h.fn(null));
    assert.equal(h.annotated.length, 1);
  });

  test('the same name twice in one session fails the second call before its fn runs', async () => {
    const h = harness([0, 10]);
    await h.session.measure('login_ms', h.fn(null));
    const second = h.fn(null);
    const error = await rejection(h.session.measure('login_ms', second));
    assert.ok(error.message.includes('"login_ms"'), error.message);
    assert.ok(error.message.includes('twice'), error.message);
    assert.equal(h.calls(), 1, 'only the first fn ran');
    assert.deepEqual(h.titles, ['login_ms']);
    assert.equal(h.annotated.length, 1);
  });

  test('two sessions do not share their used names', async () => {
    const first = harness([0, 10]);
    const second = harness([0, 10]);
    await first.session.measure('login_ms', first.fn(null));
    await second.session.measure('login_ms', second.fn(null));
    assert.equal(second.annotated.length, 1);
  });

  const badNames: [string, string][] = [
    ['empty', ''],
    ['starts with a digit', '1a'],
    ['has a capital letter', 'Login'],
    ['has a hyphen', 'a-b'],
    ['is __proto__', '__proto__'],
    ['has a space', 'login ms'],
    ['is too long', 'a'.repeat(65)],
  ];
  for (const [title, name] of badNames) {
    test(`a metric name that ${title} is rejected before fn runs`, async () => {
      const h = harness();
      const error = await rejection(h.session.measure(name, h.fn(null)));
      assert.ok(error.message.startsWith('measure: metric name "'), error.message);
      assert.ok(error.message.includes('lowercase'), error.message);
      assert.equal(h.calls(), 0);
      assert.deepEqual(h.titles, []);
    });
  }

  const notStrings: [string, unknown][] = [
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ];
  for (const [title, value] of notStrings) {
    test(`${title} as the name is a TypeError`, async () => {
      const h = harness();
      const error = await rejection(h.session.measure(value as string, h.fn(null)));
      assert.ok(error instanceof TypeError, `expected a TypeError, got ${error.name}`);
      assert.ok(error.message.includes('must be a string'), error.message);
      assert.equal(h.calls(), 0);
    });
  }
});

describe('slowMessage and finishMessage', () => {
  const record: MetricRecord = {
    name: 'overview_ms',
    ms: 1234.56,
    reference_ms: 300,
    maxRatio: 3,
    ratio: 1234.56 / 300,
    verdict: 'slow',
  };

  test('slowMessage prints the time, the limit in milliseconds and a three-decimal ratio', () => {
    assert.equal(slowMessage(record), 'overview_ms 1235 ms (limit 900 ms, ratio 4.115)');
    // A time just above the limit still reads as above it.
    assert.equal(
      slowMessage({ name: 'x_ms', ms: 901.2, reference_ms: 300, maxRatio: 3, ratio: 3.004, verdict: 'slow' }),
      'x_ms 901 ms (limit 900 ms, ratio 3.004)',
    );
    // The limit is rounded to whole milliseconds, half up.
    assert.equal(
      slowMessage({ name: 'y_ms', ms: 600, reference_ms: 333, maxRatio: 1.5, ratio: 600 / 333, verdict: 'slow' }),
      'y_ms 600 ms (limit 500 ms, ratio 1.802)',
    );
  });

  test('finishMessage of an empty list is undefined', () => {
    assert.equal(finishMessage([]), undefined);
  });

  test('finishMessage starts with the slow prefix and joins the parts with a semicolon', () => {
    assert.equal(finishMessage(['a 1 ms']), '[slow] a 1 ms');
    assert.equal(finishMessage(['a 1 ms', 'b 2 ms']), '[slow] a 1 ms; b 2 ms');
  });
});

describe('screenshotOptions', () => {
  test('copies the mask list in order and always sets the fixed colour and timeout', () => {
    const first = { name: 'login' };
    const second = { name: 'password' };
    const masks = [first, second];
    const options = screenshotOptions(masks);
    assert.deepEqual(options.mask, [first, second]);
    assert.equal(options.mask[0], first);
    assert.equal(options.mask[1], second);
    assert.notEqual(options.mask, masks, 'the list is a copy');
    assert.equal(options.maskColor, '#FF00FF');
    assert.equal(options.maskColor, MASK_COLOR);
    assert.equal(options.timeout, 10000);
    assert.equal(options.timeout, SCREENSHOT_TIMEOUT_MS);
  });

  test('an empty list gives an empty mask and still the colour and timeout', () => {
    const options = screenshotOptions([]);
    assert.deepEqual(options, { mask: [], maskColor: '#FF00FF', timeout: 10000 });
  });
});
