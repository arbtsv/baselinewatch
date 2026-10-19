// Constants and shapes shared between the fixture and the code that reads its output. This module
// imports nothing at runtime and nothing from Playwright, so any consumer can load it cheaply.
import type { Verdict } from './verdict.ts';

/** Annotation type of one measured step; the reporter reads it from the test result. */
export const METRIC_ANNOTATION = 'blw.metric' as const;

/** Start of the single end-of-test error that lists the slow steps; the reporter classifies on it. */
export const SLOW_PREFIX = '[slow]' as const;

/** Fill colour of the masks in the end-of-test screenshot; a later check looks for it in the PNG. */
export const MASK_COLOR = '#FF00FF' as const;

/** Name of the one screenshot attachment every test ends with; the reporter looks it up by name. */
export const SCREENSHOT_ATTACHMENT = 'screenshot' as const;

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
