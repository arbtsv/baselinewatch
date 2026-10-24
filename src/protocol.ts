// Constants and shapes shared between the fixture and the code that reads its output. This module
// imports nothing at runtime and nothing from Playwright, so any consumer can load it cheaply.
import type { Locale } from './env.ts';
import type { Verdict } from './verdict.ts';

/** Annotation type of one measured step; the reporter reads it from the test result. */
export const METRIC_ANNOTATION = 'blw.metric' as const;

/** Start of the single end-of-test error that lists the slow steps; the reporter classifies on it. */
export const SLOW_PREFIX = '[slow]' as const;

/** Fill colour of the masks in the end-of-test screenshot; a later check looks for it in the PNG. */
export const MASK_COLOR = '#FF00FF' as const;

/** Name of the one screenshot attachment every test ends with; the reporter looks it up by name. */
export const SCREENSHOT_ATTACHMENT = 'screenshot' as const;

/**
 * The shortest account login or password a run hides. A shorter value is not redacted anywhere, and
 * blw run warns about it. The redaction module re-exports this constant.
 */
export const MIN_REDACT_LENGTH = 3 as const;

/** Time the end-of-test screenshot may take, in milliseconds. */
export const SCREENSHOT_TIMEOUT_MS = 10_000 as const;

/** Own time budget of the end-of-test fixture, so the screenshot is still taken after a test timeout. */
export const FINISH_FIXTURE_TIMEOUT_MS = 15_000 as const;

/** The JSON value of one metric annotation. */
export type MetricRecord = {
  name: string;
  ms: number;
  reference_ms: number;
  maxRatio: number;
  ratio: number;
  verdict: Verdict;
};

/**
 * The options of the end-of-test screenshot: every registered locator is masked, in registration
 * order, with the fixed mask colour.
 */
export function screenshotOptions<L>(masks: readonly L[]): { mask: L[]; maskColor: string; timeout: number } {
  return { mask: [...masks], maskColor: MASK_COLOR, timeout: SCREENSHOT_TIMEOUT_MS };
}

/** Version of every JSON file a run writes; a reader rejects any other value. */
export const SCHEMA_VERSION = 1 as const;

/** Start of a configuration error message; the reporter sorts such errors into their own category. */
export const CONFIG_PREFIX = '[config]' as const;

/** Playwright globalTimeout of every run, in milliseconds. */
export const GLOBAL_TIMEOUT_MS = 900_000 as const;

/** How long after the global timeout the command line kills a child that is still alive. */
export const WATCHDOG_GRACE_MS = 30_000 as const;

/** The class of a project in one pass. */
export const PROJECT_CLASSES = ['ok', 'slow', 'error'] as const;
export type ProjectClass = (typeof PROJECT_CLASSES)[number];

/** A best-effort reason for an error project; it never changes the verdict. */
export const ERROR_CATEGORIES = ['config', 'timeout', 'assertion', 'other'] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** The outcome of the second look at a slow project. */
export const RECHECKS = ['ok', 'still_slow', 'error'] as const;
export type Recheck = (typeof RECHECKS)[number];

/** The overall status of a run. */
export const RUN_STATUSES = ['pass', 'fail', 'not_ready'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The result word printed on the RESULT= line. */
export const RESULT_TOKENS = ['PASS', 'FAIL'] as const;
export type ResultToken = (typeof RESULT_TOKENS)[number];

/** Why a run was not ready to measure (exit code 3). */
export const NOT_READY_REASONS = ['config', 'locked', 'browser', 'playwright_copies', 'usage', 'node'] as const;
export type NotReadyReason = (typeof NOT_READY_REASONS)[number];

/** Why a run that did measure failed (exit code 1). */
export const FAIL_REASONS = ['slow', 'error', 'report_not_built'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** Every token that can follow REASON=. */
export type Reason = NotReadyReason | FailReason;

/** The process exit codes of a run. */
export const EXIT_CODES = { pass: 0, fail: 1, notReady: 3 } as const;

/**
 * Codes of the warnings a summary can carry; the report translates them from structure. A
 * history_not_written warning without pass names the runs.csv row of the run, and with pass n the
 * metrics.csv rows of pass n. lock_taken_over: a stale lock of an earlier run was taken over.
 * retention_failed: old run items could not be deleted (count). secret_too_short: the login or the
 * password is too short to hide (field). binary_left_out: files were left out of the zip because
 * they could not be cleaned of the login or the password (count). zip_skipped: the zip is made on Windows only.
 * zip_failed: the zip could not be built. No warning carries a path, a file name or a value, and none
 * changes the exit code or the verdict.
 */
export const WARNING_CODES = [
  'pass_invalid',
  'pass_2_not_built',
  'history_not_written',
  'lock_taken_over',
  'retention_failed',
  'secret_too_short',
  'binary_left_out',
  'zip_skipped',
  'zip_failed',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** The account field a warning can name. */
export const WARNING_FIELDS = ['login', 'password'] as const;
export type WarningField = (typeof WARNING_FIELDS)[number];

/** Start of the result line a run prints for a scheduler. */
export const RESULT_LINE_PREFIX = 'RESULT=' as const;

/** Start of the reason line a run prints for a scheduler. */
export const REASON_LINE_PREFIX = 'REASON=' as const;

/** One baseline metric of one node, named in a metric gap list. */
export type MetricRef = { scenario: string; node: string; metric: string };

/**
 * A condition worth showing next to a run result; the optional fields say where it happened, which
 * account field it concerns and how many items it counts.
 */
export type RunWarning = {
  code: WarningCode;
  pass?: 1 | 2;
  scenario?: string;
  node?: string;
  field?: WarningField;
  count?: number;
};

/** One project of a pass: its class, what it measured and the best-effort error category. */
export type PassProject = {
  project: string;
  scenario: string;
  node: string;
  class: ProjectClass;
  metrics: MetricRecord[];
  error_category: ErrorCategory | null;
};

/** The file the reporter writes at the end of one pass. */
export type PassFile = {
  schema_version: 1;
  run_id: string;
  pass: 1 | 2;
  started_at: string;
  finished_at: string;
  projects: PassProject[];
  not_measured: MetricRef[];
  unused_baselines: MetricRef[];
};

/** One node in the summary: its first-pass class, its metrics and the outcome of its second look. */
export type SummaryNode = {
  scenario: string;
  node: string;
  class: ProjectClass;
  metrics: MetricRecord[];
  recheck: Recheck | null;
};

/** The file the command line writes at the end of a run. */
export type Summary = {
  schema_version: 1;
  run_id: string;
  core_version: string;
  status: RunStatus;
  result: ResultToken;
  exit_code: 0 | 1 | 3;
  reason: Reason | null;
  locale: Locale;
  started_at: string;
  finished_at: string;
  nodes: SummaryNode[];
  not_measured: MetricRef[];
  unused_baselines: MetricRef[];
  warnings: RunWarning[];
};
