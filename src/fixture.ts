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

type EditableField = { value: string; disabled: boolean; readOnly: boolean; select(): void };
type PageDocument = {
  execCommand(command: string, showUi: boolean, value: string): boolean;
  getSelection(): { selectAllChildren(node: unknown): void } | null;
};

/** Runs in the page: empties form fields and editable elements, without any event. */
function emptyFieldsInPage(elements: (HTMLElement | SVGElement)[]): void {
  for (const element of elements) {
    const field = element as unknown as EditableField;
    if ('value' in field && typeof field.select === 'function') field.value = '';
    else if ((element as HTMLElement).isContentEditable) element.textContent = '';
  }
}

/**
 * Playwright writes a snapshot of the page when a test fails, and the snapshot lists the value of every
 * field. The fields filled with fillSecret are emptied once the screenshot is taken (or has failed), so
 * the snapshot and the html report built from it do not carry what fillSecret entered. A field that is
 * gone is skipped at once, and a failure to empty one never fails the test.
 */
async function emptyFields(locators: Locator[]): Promise<void> {
  for (const locator of locators) {
    try {
      if ((await locator.count()) > 0) await locator.evaluateAll(emptyFieldsInPage);
    } catch {
      // The page may be closing; the test result must not depend on this clean-up.
    }
  }
}

/**
 * Runs in the page, after fill('') has waited until the field is visible, enabled and editable and
 * has refused a target that cannot be filled. It enters the text the way Playwright's own fill does
 * (focus, select, insert text), so the page sees ordinary input events. It is passed to evaluate and
 * not to fill because fill puts its argument into the step title, and the step titles end up in the
 * html report.
 */
function enterText(element: HTMLElement | SVGElement, text: string): void {
  const field = element as unknown as EditableField;
  const doc = (globalThis as unknown as { document: PageDocument }).document;
  const isField = 'value' in field && typeof field.select === 'function';
  element.focus();
  if (isField) {
    field.select();
  } else if ((element as HTMLElement).isContentEditable) {
    doc.getSelection()?.selectAllChildren(element);
  } else {
    throw new Error('baselinewatch: the target is not an editable field');
  }
  if (!doc.execCommand('insertText', false, text)) {
    if (!isField) throw new Error('baselinewatch: the text could not be entered');
    // The setter of the prototype, so that a framework that tracks the value sees the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    if (setter) setter.call(field, text);
    else field.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

export type MonitorFixtures = {
  measure: Measure;
  /**
   * Fills a field with a secret; the locator is registered for masking before the fill. The value is
   * not put into a step title, and the field is emptied when the test ends, so it is not in the
   * failure snapshot either. A failed expect still makes Playwright snapshot the page at that moment.
   */
  fillSecret: (locator: Locator, value: string) => Promise<void>;
  /** Registers a locator to be masked in the end-of-test screenshot; the page is not touched. */
  maskLocator: (locator: Locator) => void;
};

export type MonitorWorkerFixtures = { account: Account };

type TestState = {
  masks: Locator[];
  /** The locators filled with fillSecret; only these are emptied when the test ends. */
  secrets: Locator[];
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
    await use({ masks: [], secrets: [], session: undefined });
  },

  fillSecret: async ({ blwTestState }, use) => {
    await use(async (locator, value) => {
      // Register first, so a fill that fails still leaves the field masked.
      blwTestState.masks.push(locator);
      blwTestState.secrets.push(locator);
      // fill waits until the field is visible, enabled and editable, and refuses a target that cannot
      // be filled; an empty string leaves nothing in its step title.
      await locator.fill('');
      await locator.evaluate(enterText, value);
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
      try {
        const body = await page.screenshot(screenshotOptions(blwTestState.masks));
        await testInfo.attach(SCREENSHOT_ATTACHMENT, { body, contentType: 'image/png' });
      } finally {
        await emptyFields(blwTestState.secrets);
      }
      const slow = finishMessage(blwTestState.session ? blwTestState.session.slowMessages() : []);
      if (slow !== undefined && testInfo.status === testInfo.expectedStatus) throw new Error(slow);
    },
    { auto: true, timeout: FINISH_FIXTURE_TIMEOUT_MS },
  ],
});

export { expect };
