// Pure classification of Playwright test outcomes into a project class, an error category, the
// measured metrics and the metric gaps. This module imports nothing from Playwright, so the reporter
// and the unit tests share it without a browser.
import type { Baselines } from './baselines.ts';
import { METRIC_PATTERN, MAX_NAME_LENGTH } from './names.ts';
import {
  CONFIG_PREFIX,
  ERROR_CATEGORIES,
  METRIC_ANNOTATION,
  SLOW_PREFIX,
  type ErrorCategory,
  type MetricRecord,
  type MetricRef,
  type PassProject,
  type ProjectClass,
} from './protocol.ts';

/** What the reporter knows about one test of a project when the run ends. */
export type TestOutcome = {
  /** False when the test was seeded at the start of the run but never reported an end. */
  finished: boolean;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | undefined;
  /** Raw error messages; this module removes the colour codes itself. */
  errors: string[];
  annotations: readonly { type: string; description?: string }[];
};

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An end-of-test slow error: the prefix, one space, with Playwright's optional "Error: " in front.
const SLOW_ERROR = new RegExp(`^(?:Error: )?${escapeForRegExp(SLOW_PREFIX)} `);
// A configuration error as Playwright prints it, with an optional error class name in front.
const CONFIG_ERROR = new RegExp(`^(?:\\w+: )?${escapeForRegExp(CONFIG_PREFIX)} `);
const TIMEOUT_EXCEEDED = /Timeout \d+ms exceeded/;
const EXPECT_ERROR = /^(?:Error: )?expect\(/;

/** Removes the terminal colour codes from a message. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** True when the message, without colour codes, is a slow error: the slow prefix at its very start. */
export function isSlowError(message: string): boolean {
  return SLOW_ERROR.test(stripAnsi(message));
}

/**
 * ok when the test passed; slow when it failed and every error is a slow error; error in every other
 * case, so a test that did not finish, was skipped or timed out can never count as measured.
 */
export function classifyTest(outcome: TestOutcome): ProjectClass {
  if (!outcome.finished) {
    return 'error';
  }
  if (outcome.status === 'passed') {
    return 'ok';
  }
  if (outcome.status === 'failed' && outcome.errors.length > 0 && outcome.errors.every(isSlowError)) {
    return 'slow';
  }
  return 'error';
}

/** Error over slow over ok; no tests at all is an error. */
export function foldClasses(classes: readonly ProjectClass[]): ProjectClass {
  if (classes.length === 0 || classes.includes('error')) {
    return 'error';
  }
  return classes.includes('slow') ? 'slow' : 'ok';
}

/**
 * A best-effort reason for an error test, read from the structure of its messages. It is null for a
 * test that is not an error and never changes a verdict.
 */
export function errorCategoryOf(outcome: TestOutcome, runTimedOut: boolean): ErrorCategory | null {
  if (classifyTest(outcome) !== 'error') {
    return null;
  }
  const errors = outcome.errors.map(stripAnsi);
  if (errors.some((message) => CONFIG_ERROR.test(message))) {
    return 'config';
  }
  const timedOut =
    outcome.status === 'timedOut' ||
    (!outcome.finished && runTimedOut) ||
    errors.some((message) => message.includes('Test timeout of') || TIMEOUT_EXCEEDED.test(message));
  if (timedOut) {
    return 'timeout';
  }
  if (errors.some((message) => EXPECT_ERROR.test(message))) {
    return 'assertion';
  }
  return 'other';
}

/** The highest category present, in the order config, timeout, assertion, other; null for none. */
export function foldCategories(categories: readonly (ErrorCategory | null)[]): ErrorCategory | null {
  for (const category of ERROR_CATEGORIES) {
    if (categories.includes(category)) {
      return category;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads one metric record from a parsed value. All six fields must be present with the right types and
 * ranges; the copy holds those six fields only, unrounded. Anything else gives undefined.
 */
export function metricRecordOf(value: unknown): MetricRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, ms, reference_ms, maxRatio, ratio, verdict } = value;
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !METRIC_PATTERN.test(name)) {
    return undefined;
  }
  if (!isFiniteNumber(ms) || ms < 0) {
    return undefined;
  }
  if (!isFiniteNumber(reference_ms) || !(reference_ms > 0)) {
    return undefined;
  }
  if (!isFiniteNumber(maxRatio) || !(maxRatio >= 1)) {
    return undefined;
  }
  if (!isFiniteNumber(ratio)) {
    return undefined;
  }
  if (verdict !== 'ok' && verdict !== 'slow') {
    return undefined;
  }
  return { name, ms, reference_ms, maxRatio, ratio, verdict };
}

/** The metrics recorded in the annotations of one test, in annotation order; bad ones are skipped. */
export function metricsFromAnnotations(annotations: TestOutcome['annotations']): MetricRecord[] {
  const metrics: MetricRecord[] = [];
  for (const annotation of annotations) {
    if (annotation.type !== METRIC_ANNOTATION || typeof annotation.description !== 'string') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(annotation.description);
    } catch {
      continue;
    }
    const metric = metricRecordOf(parsed);
    if (metric !== undefined) {
      metrics.push(metric);
    }
  }
  return metrics;
}

/**
 * Combines the tests of one project: the metrics of all tests in order, the folded class and, for an
 * error project, the highest category. No error text is copied.
 */
export function classifyProject(input: {
  project: string;
  scenario: string;
  node: string;
  tests: readonly TestOutcome[];
  runTimedOut: boolean;
}): PassProject {
  const projectClass = foldClasses(input.tests.map(classifyTest));
  let category: ErrorCategory | null = null;
  if (projectClass === 'error') {
    // A project without any test has no error test to read a category from.
    category = foldCategories(input.tests.map((test) => errorCategoryOf(test, input.runTimedOut))) ?? 'other';
  }
  return {
    project: input.project,
    scenario: input.scenario,
    node: input.node,
    class: projectClass,
    metrics: input.tests.flatMap((test) => metricsFromAnnotations(test.annotations)),
    error_category: category,
  };
}

/**
 * The baseline metrics a project did not measure, for the first pass. Each one is listed once, by
 * project in the given order and then by baseline order: under not_measured when the project is an
 * error (its test stopped before the step), under unused_baselines otherwise (the scenario no longer
 * measures it). A scenario without baselines gives nothing.
 */
export function metricGaps(
  projects: readonly PassProject[],
  baselines: Baselines,
): { not_measured: MetricRef[]; unused_baselines: MetricRef[] } {
  const notMeasured: MetricRef[] = [];
  const unusedBaselines: MetricRef[] = [];
  for (const project of projects) {
    if (!Object.hasOwn(baselines, project.scenario)) {
      continue;
    }
    const measured = new Set(project.metrics.map((metric) => metric.name));
    const target = project.class === 'error' ? notMeasured : unusedBaselines;
    for (const metric of Object.keys(baselines[project.scenario] ?? {})) {
      if (!measured.has(metric)) {
        target.push({ scenario: project.scenario, node: project.node, metric });
      }
    }
  }
  return { not_measured: notMeasured, unused_baselines: unusedBaselines };
}
