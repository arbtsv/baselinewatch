// The measure contract as a pure module: the checks on a metric name, the timing, the verdict and
// the messages, with the step, the clock and the annotation injected. It imports nothing from
// Playwright, so the whole contract runs in plain unit tests.
import { ConfigError } from './errors.ts';
import { leakedField, nameProblem } from './names.ts';
import { MIN_REDACT_LENGTH, SLOW_PREFIX, type MetricRecord } from './protocol.ts';
import { judge, type BaselineEntry } from './verdict.ts';

/** Runs fn inside a step named after the metric, times it and judges it against the baseline. */
export type Measure = <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;

export type MeasureDeps = {
  scenario: string;
  baselines: Readonly<Record<string, BaselineEntry>>;
  baselinesFile: string;
  account: { login: string; password: string };
  step: <T>(title: string, body: () => Promise<T>) => Promise<T>;
  now: () => number;
  annotate: (record: MetricRecord) => void;
};

export type MeasureSession = { measure: Measure; records(): MetricRecord[]; slowMessages(): string[] };

/** The error of a retried test: the retry stops in fixture setup, before the test body runs. */
export const RETRY_GUARD_MESSAGE = 'baselinewatch: retries are off, so a failed test is not run again in the same run';

/**
 * One part of the slow error, for people to read: the time and the limit (reference_ms times
 * maxRatio) in whole milliseconds, and the ratio with three decimals, so a ratio just above
 * maxRatio never reads as equal to it.
 */
export function slowMessage(record: MetricRecord): string {
  return `${record.name} ${Math.round(record.ms)} ms (limit ${Math.round(record.reference_ms * record.maxRatio)} ms, ratio ${record.ratio.toFixed(3)})`;
}

/** The text of the single slow error, or undefined when no step was slow. */
export function finishMessage(slow: readonly string[]): string | undefined {
  if (slow.length === 0) return undefined;
  return `${SLOW_PREFIX} ${slow.join('; ')}`;
}

const HOLDS_ACCOUNT_MESSAGE = 'measure: the metric name contains the account login or password; choose another name';

// True when the name holds, in any case, a login or password of MIN_REDACT_LENGTH or more characters
// as a plain substring. Such a name is never printed: the console redactor hides the value, but this
// is the second line for a bare playwright test.
function holdsAccountValue(account: MeasureDeps['account'], name: string): boolean {
  const lowered = name.toLowerCase();
  return [account.login, account.password].some(
    (value) => value.length >= MIN_REDACT_LENGTH && lowered.includes(value.toLowerCase()),
  );
}

/**
 * One session per test. measure(name, fn) checks, in this order and before fn runs: the name is a
 * string; it does not hold the account login or password under the rule of leakedField (the error
 * does not repeat the name); it follows the metric rule; it was not measured before in this session;
 * the scenario has a baseline for it. A name that holds a login or password of MIN_REDACT_LENGTH or
 * more characters as a substring is never repeated in any of these errors, even when the rule
 * accepts it and it is measured. Then it runs fn in a step titled with the name and records the
 * timing, the annotation and, for a slow step, the message.
 */
export function createMeasure(deps: MeasureDeps): MeasureSession {
  const { scenario, baselines, baselinesFile, account, step, now, annotate } = deps;
  const records: MetricRecord[] = [];
  const slow: string[] = [];
  const used = new Set<string>();

  const measure: Measure = async (name, fn) => {
    if (typeof name !== 'string') {
      throw new TypeError('measure: the metric name must be a string');
    }
    if (leakedField(account, name) !== undefined) {
      throw new Error(HOLDS_ACCOUNT_MESSAGE);
    }
    const quiet = holdsAccountValue(account, name);
    const problem = nameProblem('metric', name);
    if (problem !== undefined) {
      throw new Error(quiet ? HOLDS_ACCOUNT_MESSAGE : `measure: metric name "${name}" ${problem}`);
    }
    if (used.has(name)) {
      throw new Error(quiet ? HOLDS_ACCOUNT_MESSAGE : `measure: metric "${name}" is measured twice in one test; use distinct names`);
    }
    used.add(name);
    if (!Object.hasOwn(baselines, name)) {
      throw quiet
        ? new ConfigError(
            baselinesFile,
            `no baseline for a metric of scenario "${scenario}" whose name holds an account value`,
            'Rename that metric or add a baseline for it to baselines.json',
          )
        : new ConfigError(
            baselinesFile,
            `no baseline for metric "${name}" in scenario "${scenario}"`,
            `Add "${scenario}" -> "${name}" with reference_ms and maxRatio to baselines.json`,
          );
    }
    const entry = baselines[name] as BaselineEntry;
    return step(name, async () => {
      const started = now();
      const value = await fn();
      const ms = now() - started;
      const { ratio, verdict } = judge(ms, entry);
      const record: MetricRecord = {
        name,
        ms,
        reference_ms: entry.reference_ms,
        maxRatio: entry.maxRatio,
        ratio,
        verdict,
      };
      records.push(record);
      annotate(record);
      if (verdict === 'slow') slow.push(slowMessage(record));
      return value;
    });
  };

  return { measure, records: () => [...records], slowMessages: () => [...slow] };
}
