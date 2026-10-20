// Tests for src/classify.ts.
// Run: node --test test/classify.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/errors.ts';
import {
  classifyProject,
  classifyTest,
  errorCategoryOf,
  foldCategories,
  foldClasses,
  isSlowError,
  metricGaps,
  metricsFromAnnotations,
  stripAnsi,
  type TestOutcome,
} from '../src/classify.ts';
import type { Baselines } from '../src/baselines.ts';
import {
  CONFIG_PREFIX,
  METRIC_ANNOTATION,
  type ErrorCategory,
  type MetricRecord,
  type PassProject,
  type ProjectClass,
} from '../src/protocol.ts';

function annotation(record: unknown): { type: string; description: string } {
  return { type: METRIC_ANNOTATION, description: JSON.stringify(record) };
}

function okMetric(name: string, ms: number): MetricRecord {
  return { name, ms, reference_ms: 300, maxRatio: 3, ratio: ms / 300, verdict: 'ok' };
}

function outcome(overrides: Partial<TestOutcome> = {}): TestOutcome {
  return { finished: true, status: 'passed', errors: [], annotations: [], ...overrides };
}

function failed(...errors: string[]): TestOutcome {
  return outcome({ status: 'failed', errors });
}

describe('classifyProject', () => {
  test('a passing test with three ok metric annotations gives an ok project with the three metrics in order', () => {
    const metrics = [okMetric('login_ms', 120), okMetric('overview_ms', 90), okMetric('history_ms', 150)];
    const project = classifyProject({
      project: 'demo--node-1',
      scenario: 'demo',
      node: 'node-1',
      tests: [outcome({ annotations: metrics.map(annotation) })],
      runTimedOut: false,
    });
    assert.deepEqual(project, {
      project: 'demo--node-1',
      scenario: 'demo',
      node: 'node-1',
      class: 'ok',
      metrics,
      error_category: null,
    });
  });

  const ident = { project: 'demo--node-1', scenario: 'demo', node: 'node-1', runTimedOut: false };

  test('a project without any test is an error with the category other', () => {
    const project = classifyProject({ ...ident, tests: [] });
    assert.equal(project.class, 'error');
    assert.equal(project.error_category, 'other');
    assert.deepEqual(project.metrics, []);
  });

  test('the tests of one project fold error over slow over ok and keep the metrics of every test in order', () => {
    const first = outcome({ annotations: [annotation(okMetric('login_ms', 100))] });
    const second = { ...failed('[slow] overview_ms'), annotations: [annotation(okMetric('overview_ms', 200))] };
    const third = { ...failed('boom'), annotations: [annotation(okMetric('history_ms', 300))] };
    const project = classifyProject({ ...ident, tests: [first, second, third] });
    assert.equal(project.class, 'error');
    assert.equal(project.error_category, 'other');
    assert.deepEqual(
      project.metrics.map((metric) => metric.name),
      ['login_ms', 'overview_ms', 'history_ms'],
    );
    assert.equal(classifyProject({ ...ident, tests: [first, second] }).class, 'slow');
    assert.equal(classifyProject({ ...ident, tests: [first, first] }).class, 'ok');
  });

  test('the highest category of the error tests is kept and slow or ok projects have none', () => {
    const tests = [failed('boom'), failed('Error: expect(locator).toBeVisible() failed'), outcome({ status: 'timedOut' })];
    assert.equal(classifyProject({ ...ident, tests }).error_category, 'timeout');
    assert.equal(classifyProject({ ...ident, tests: [failed('[slow] a')] }).error_category, null);
    assert.equal(classifyProject({ ...ident, tests: [outcome()] }).error_category, null);
  });

  test('no error text reaches the project', () => {
    const secret = 'placeholder-password-9';
    const project = classifyProject({
      ...ident,
      tests: [failed(`Error: login rejected for ${secret}`, `[slow] ${secret}`)],
    });
    assert.ok(!JSON.stringify(project).includes(secret));
  });
});

describe('classifyTest', () => {
  const cases: [string, TestOutcome, ProjectClass][] = [
    ['passed', outcome(), 'ok'],
    ['failed with one slow error', failed('[slow] a'), 'slow'],
    ['failed with the Error: prefix and a second slow error', failed('Error: [slow] a', '[slow] b'), 'slow'],
    ['failed with a slow error wrapped in colour codes', failed('\u001b[31mError: [slow] a\u001b[39m'), 'slow'],
    ['failed with no space after the prefix', failed('[slow]x'), 'error'],
    ['failed with a leading space', failed(' [slow] a'), 'error'],
    ['failed with a longer word after the bracket', failed('[slowness] a'), 'error'],
    ['failed with another error', failed('boom'), 'error'],
    ['failed with a slow error and another error', failed('[slow] a', 'boom'), 'error'],
    ['failed with no error', failed(), 'error'],
    ['timed out', outcome({ status: 'timedOut' }), 'error'],
    ['skipped', outcome({ status: 'skipped' }), 'error'],
    ['interrupted', outcome({ status: 'interrupted' }), 'error'],
    ['never finished', outcome({ finished: false, status: undefined }), 'error'],
    ['never finished even with a passed status', outcome({ finished: false }), 'error'],
  ];
  for (const [title, input, expected] of cases) {
    test(`${title} gives ${expected}`, () => {
      assert.equal(classifyTest(input), expected);
    });
  }

  test('colour codes are removed before the prefix is looked at', () => {
    assert.equal(stripAnsi('\u001b[1m\u001b[31mred\u001b[39m\u001b[22m'), 'red');
    assert.equal(isSlowError('\u001b[31mError: [slow] a\u001b[39m'), true);
    assert.equal(isSlowError('x \u001b[31m[slow] a'), false);
  });
});

describe('foldClasses', () => {
  const cases: [ProjectClass[], ProjectClass][] = [
    [[], 'error'],
    [['ok', 'ok'], 'ok'],
    [['ok', 'slow'], 'slow'],
    [['slow', 'error', 'ok'], 'error'],
  ];
  for (const [input, expected] of cases) {
    test(`[${input.join(', ')}] gives ${expected}`, () => {
      assert.equal(foldClasses(input), expected);
    });
  }
});

describe('errorCategoryOf', () => {
  const cases: [string, TestOutcome, boolean, ErrorCategory | null][] = [
    ['a configuration error', failed('ConfigError: [config] baselines.json: no baseline for scenario "demo". Add it.'), false, 'config'],
    ['a configuration error wrapped in colour codes', failed('\u001b[31mConfigError: [config] a\u001b[39m'), false, 'config'],
    ['a configuration error on a timed out test', outcome({ status: 'timedOut', errors: ['[config] a'] }), false, 'config'],
    ['a timed out test', outcome({ status: 'timedOut' }), false, 'timeout'],
    ['a test that never finished after the global timeout', outcome({ finished: false, status: undefined }), true, 'timeout'],
    ['a test that never finished without the global timeout', outcome({ finished: false, status: undefined }), false, 'other'],
    ['a test timeout text', failed('Test timeout of 30000ms exceeded.'), false, 'timeout'],
    ['an action timeout text', failed('page.click: Timeout 5000ms exceeded.'), false, 'timeout'],
    ['an expect failure', failed('Error: expect(locator).toBeVisible() failed'), false, 'assertion'],
    ['an expect failure without the Error prefix', failed('expect(received).toBe(expected)'), false, 'assertion'],
    ['any other failure', failed('boom'), false, 'other'],
    ['a skipped test', outcome({ status: 'skipped' }), false, 'other'],
    ['a passed test', outcome(), false, null],
    ['a slow test', failed('[slow] a'), false, null],
  ];
  for (const [title, input, runTimedOut, expected] of cases) {
    test(`${title} gives ${expected}`, () => {
      assert.equal(errorCategoryOf(input, runTimedOut), expected);
    });
  }

  test('the highest category wins in the order config, timeout, assertion, other', () => {
    assert.equal(foldCategories(['other', 'assertion', 'timeout']), 'timeout');
    assert.equal(foldCategories(['other', 'config']), 'config');
    assert.equal(foldCategories([null, 'other']), 'other');
    assert.equal(foldCategories([null, null]), null);
    assert.equal(foldCategories([]), null);
  });

  test('a ConfigError message starts with the config prefix and a space', () => {
    const error = new ConfigError('baselines.json', 'no baseline for scenario "demo"', 'Add it');
    assert.ok(error.message.startsWith(`${CONFIG_PREFIX} `));
    assert.equal(errorCategoryOf(failed(error.stack ?? error.message), false), 'config');
  });
});

describe('metricsFromAnnotations', () => {
  const good = okMetric('login_ms', 120);

  test('a valid record is copied with its six fields in annotation order', () => {
    const other = okMetric('overview_ms', 90);
    assert.deepEqual(metricsFromAnnotations([annotation(good), { type: 'note', description: 'x' }, annotation(other)]), [good, other]);
  });

  test('a test without annotations gives no metrics', () => {
    assert.deepEqual(metricsFromAnnotations([]), []);
  });

  const skipped: [string, unknown][] = [
    ['a description that is not JSON', 'not json {'],
    ['a description that is a JSON array', [good]],
    ['a missing name', { ...good, name: undefined }],
    ['a missing ms', { ...good, ms: undefined }],
    ['a missing reference_ms', { ...good, reference_ms: undefined }],
    ['a missing maxRatio', { ...good, maxRatio: undefined }],
    ['a missing ratio', { ...good, ratio: undefined }],
    ['a missing verdict', { ...good, verdict: undefined }],
    ['ms as a string', { ...good, ms: '120' }],
    ['a negative ms', { ...good, ms: -1 }],
    ['a zero reference_ms', { ...good, reference_ms: 0 }],
    ['a maxRatio below 1', { ...good, maxRatio: 0.5 }],
    ['the verdict fast', { ...good, verdict: 'fast' }],
    ['a name that breaks the metric pattern', { ...good, name: 'Login ms' }],
    ['a name that starts with a digit', { ...good, name: '1login_ms' }],
  ];
  for (const [title, value] of skipped) {
    test(`${title} is skipped without an exception`, () => {
      const description = typeof value === 'string' ? value : JSON.stringify(value);
      assert.deepEqual(metricsFromAnnotations([{ type: METRIC_ANNOTATION, description }]), []);
    });
  }

  test('an annotation without a description is skipped', () => {
    assert.deepEqual(metricsFromAnnotations([{ type: METRIC_ANNOTATION }]), []);
  });

  test('an extra key is dropped from the copy', () => {
    const [copy] = metricsFromAnnotations([annotation({ ...good, secret: 'x' })]);
    assert.deepEqual(copy, good);
    assert.deepEqual(Object.keys(copy ?? {}), ['name', 'ms', 'reference_ms', 'maxRatio', 'ratio', 'verdict']);
  });

  test('numbers are copied exactly as recorded', () => {
    const exact: MetricRecord = { name: 'login_ms', ms: 1234.5678, reference_ms: 300, maxRatio: 3, ratio: 4.115226, verdict: 'slow' };
    assert.deepEqual(metricsFromAnnotations([annotation(exact)]), [exact]);
  });
});

describe('metricGaps', () => {
  const baselines: Baselines = {
    demo: {
      login_ms: { reference_ms: 300, maxRatio: 3 },
      overview_ms: { reference_ms: 300, maxRatio: 3 },
      history_ms: { reference_ms: 300, maxRatio: 3 },
    },
  };

  function project(node: string, projectClass: ProjectClass, measured: string[], scenario = 'demo'): PassProject {
    return {
      project: `${scenario}--${node}`,
      scenario,
      node,
      class: projectClass,
      metrics: measured.map((name) => okMetric(name, 100)),
      error_category: projectClass === 'error' ? 'other' : null,
    };
  }

  test('an unmeasured baseline metric of an ok project is an unused baseline', () => {
    const gaps = metricGaps([project('node-1', 'ok', ['login_ms', 'overview_ms'])], baselines);
    assert.deepEqual(gaps, { not_measured: [], unused_baselines: [{ scenario: 'demo', node: 'node-1', metric: 'history_ms' }] });
  });

  test('an unmeasured baseline metric of a slow project is an unused baseline', () => {
    const gaps = metricGaps([project('node-1', 'slow', ['login_ms', 'overview_ms'])], baselines);
    assert.deepEqual(gaps.unused_baselines, [{ scenario: 'demo', node: 'node-1', metric: 'history_ms' }]);
    assert.deepEqual(gaps.not_measured, []);
  });

  test('an unmeasured baseline metric of an error project is not measured', () => {
    const gaps = metricGaps([project('node-1', 'error', ['login_ms', 'overview_ms'])], baselines);
    assert.deepEqual(gaps, { not_measured: [{ scenario: 'demo', node: 'node-1', metric: 'history_ms' }], unused_baselines: [] });
  });

  test('a scenario without baselines gives nothing', () => {
    assert.deepEqual(metricGaps([project('node-1', 'error', [], 'other')], baselines), { not_measured: [], unused_baselines: [] });
  });

  test('every metric is listed once per node, in project order and then in baseline order', () => {
    const gaps = metricGaps(
      [project('node-1', 'ok', ['login_ms', 'login_ms']), project('node-2', 'error', [])],
      baselines,
    );
    assert.deepEqual(gaps.unused_baselines, [
      { scenario: 'demo', node: 'node-1', metric: 'overview_ms' },
      { scenario: 'demo', node: 'node-1', metric: 'history_ms' },
    ]);
    assert.deepEqual(gaps.not_measured, [
      { scenario: 'demo', node: 'node-2', metric: 'login_ms' },
      { scenario: 'demo', node: 'node-2', metric: 'overview_ms' },
      { scenario: 'demo', node: 'node-2', metric: 'history_ms' },
    ]);
  });

  test('a measured metric that has no baseline changes nothing', () => {
    const gaps = metricGaps([project('node-1', 'ok', ['login_ms', 'overview_ms', 'history_ms', 'extra_ms'])], baselines);
    assert.deepEqual(gaps, { not_measured: [], unused_baselines: [] });
  });
});
