// The Playwright-bound shell: option fixtures set by the project config, the account fixture, the
// measure and fillSecret fixtures, and the end-of-test check that turns slow steps into one error.
import { test as base, expect, type Locator } from '@playwright/test';
import { loadEnv, type Account } from './env.ts';
import {
  createMeasure,
  finishMessage,
  RETRY_GUARD_MESSAGE,
  type Measure,
  type MeasureSession,
} from './measure.ts';
import {
  FINISH_FIXTURE_TIMEOUT_MS,
  METRIC_ANNOTATION,
  SCREENSHOT_ATTACHMENT,
  screenshotOptions,
} from './protocol.ts';
import type { BaselineEntry } from './verdict.ts';

/** Test-scoped options, set per project by defineMonitorConfig. */
export type MonitorOptions = {
  blwScenario: string;
  /** The metrics of this project's scenario only. */
  blwBaselines: Record<string, BaselineEntry>;
  /** Absolute path of baselines.json, used in error messages. */
  blwBaselinesFile: string;
};

/** Worker-scoped option: the absolute path of env.json. The account itself never travels in config. */
export type MonitorWorkerOptions = { blwEnvFile: string };

export type { Measure };

export type MonitorFixtures = {
  measure: Measure;
  /** Fills a field with a secret; the locator is registered for masking before the fill. */
  fillSecret: (locator: Locator, value: string) => Promise<void>;
  /** Registers a locator to be masked in the end-of-test screenshot; the page is not touched. */
  maskLocator: (locator: Locator) => void;
};

export type MonitorWorkerFixtures = { account: Account };

type TestState = {
  masks: Locator[];
  /** Set when the test used measure; the finish step reads the slow parts from it. */
  session: MeasureSession | undefined;
};

type InternalFixtures = {
  blwTestState: TestState;
  blwRetryGuard: void;
  blwFinish: void;
};

export const test = base.extend<
  MonitorOptions & MonitorFixtures & InternalFixtures,
  MonitorWorkerOptions & MonitorWorkerFixtures
>({
  blwScenario: ['', { option: true }],
  blwBaselines: [{}, { option: true }],
  blwBaselinesFile: ['baselines.json', { option: true }],
  blwEnvFile: ['', { option: true, scope: 'worker' }],

  account: [
    async ({ blwEnvFile }, use) => {
      if (blwEnvFile === '') {
        throw new Error('baselinewatch: run scenarios through defineMonitorConfig');
      }
      await use(loadEnv(blwEnvFile).account);
    },
    { scope: 'worker' },
  ],

  // Playwright reads the fixture dependencies from the first parameter, so it must be a pattern.
  blwTestState: async ({}, use) => {
    await use({ masks: [], session: undefined });
  },

  fillSecret: async ({ blwTestState }, use) => {
    await use(async (locator, value) => {
      // Register first, so a fill that fails still leaves the field masked.
      blwTestState.masks.push(locator);
      await locator.fill(value);
    });
  },

  maskLocator: async ({ blwTestState }, use) => {
    await use((locator) => {
      blwTestState.masks.push(locator);
    });
  },

  measure: async ({ blwScenario, blwBaselines, blwBaselinesFile, account, blwTestState }, use, testInfo) => {
    const session = createMeasure({
      scenario: blwScenario,
      baselines: blwBaselines,
      baselinesFile: blwBaselinesFile,
      account,
      step: (title, body) => base.step(title, body),
      now: () => performance.now(),
      annotate: (record) => {
        testInfo.annotations.push({ type: METRIC_ANNOTATION, description: JSON.stringify(record) });
      },
    });
    blwTestState.session = session;
    await use(session.measure);
  },

  // A repeated sign-in can lock the account, so a retry requested on the command line stops here, in
  // fixture setup, before the test body runs.
  blwRetryGuard: [
    async ({}, use, testInfo) => {
      if (testInfo.retry > 0) throw new Error(RETRY_GUARD_MESSAGE);
      await use();
    },
    { auto: true },
  ],

  blwFinish: [
    async ({ page, blwTestState }, use, testInfo) => {
      await use();
      // A failed screenshot is an ordinary test error. The slow error is added only to a test that
      // would otherwise pass, so a failed test never carries it; the slow verdicts stay in the
      // annotations either way. Only the default page is captured.
      const body = await page.screenshot(screenshotOptions(blwTestState.masks));
      await testInfo.attach(SCREENSHOT_ATTACHMENT, { body, contentType: 'image/png' });
      const slow = finishMessage(blwTestState.session ? blwTestState.session.slowMessages() : []);
      if (slow !== undefined && testInfo.status === testInfo.expectedStatus) throw new Error(slow);
    },
    { auto: true, timeout: FINISH_FIXTURE_TIMEOUT_MS },
  ],
});

export { expect };
