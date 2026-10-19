// Checks the end-of-test screenshot taken by the fixture in every outcome, maskLocator, and the
// measure contract end to end, through the packed core.
//
// Run: npm run e2e -- test/e2e/measure.spec.ts
import { expect, test } from '@playwright/test';
import {
  demoEnv,
  parseJsonReport,
  runDemoPlaywright,
  withDemoEnv,
  withScenario,
  type JsonTest,
} from '../helpers/demo.ts';
import { startPortal } from '../helpers/portal.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function screenshots(item: JsonTest): JsonTest['attachments'] {
  return item.attachments.filter((attachment) => attachment.name === 'screenshot');
}

function expectOnePng(item: JsonTest): void {
  const found = screenshots(item);
  expect(found).toHaveLength(1);
  const [shot] = found as [JsonTest['attachments'][number]];
  expect(shot.contentType).toBe('image/png');
  // The fixture attaches the bytes from memory, so the JSON report carries them as base64 text and
  // no path; the html reporter is the one that writes the single file.
  expect(shot.path).toBeUndefined();
  expect(shot.body).toBeTruthy();
  const bytes = Buffer.from(shot.body as string, 'base64');
  expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
}

async function onlyTest(args: string[]): Promise<JsonTest> {
  const run = await runDemoPlaywright(['test', '--reporter=json', ...args]);
  expect(run.timedOut).toBe(false);
  const report = parseJsonReport(run);
  expect(report.tests).toHaveLength(1);
  return report.tests[0] as JsonTest;
}

const MASK_SOURCE = `import { test } from 'baselinewatch';

test('mask a heading and take no measure', async ({ page, maskLocator }) => {
  await page.goto('/');
  maskLocator(page.getByRole('heading', { name: 'Sign in' }));
});
`;

const HANG_SOURCE = `import { test } from 'baselinewatch';

test('hang until the test times out', async ({ page }) => {
  test.setTimeout(3_000);
  await page.goto('/');
  await page.waitForTimeout(20_000);
});
`;

const NOBASELINE_SOURCE = `import { test } from 'baselinewatch';

test('measure a metric that has no baseline', async ({ page, measure }) => {
  await page.goto('/');
  await measure('unknown_ms', async () => {
    throw new Error('fn-was-called');
  });
});
`;

test('after a pass: one PNG screenshot attachment', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const item = await withDemoEnv(env, () => onlyTest([]));
    expect(item.status).toBe('passed');
    expect(item.errors).toEqual([]);
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});

test('after a failure: one screenshot and no slow error', async () => {
  const portal = await startPortal('broken');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const item = await withDemoEnv(env, () => onlyTest([]));
    expect(item.status).toBe('failed');
    expect(item.errors.length).toBeGreaterThan(0);
    for (const message of item.errors) {
      expect(message).not.toMatch(/^(?:Error: )?\[slow\]/);
    }
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});

test('after a timeout: the screenshot is still taken', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-hang': { 'node-1': portal.url } } });
    const item = await withScenario('e2e-hang', HANG_SOURCE, () => withDemoEnv(env, () => onlyTest([])));
    expect(item.status).toBe('timedOut');
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});

test('maskLocator without any measure: passes with one screenshot', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-mask': { 'node-1': portal.url } } });
    const item = await withScenario('e2e-mask', MASK_SOURCE, () => withDemoEnv(env, () => onlyTest([])));
    expect(item.status).toBe('passed');
    expect(item.errors).toEqual([]);
    expect(item.annotations.filter((annotation) => annotation.type === 'blw.metric')).toEqual([]);
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});

test('a metric without a baseline fails with a config message and never calls fn', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-nobaseline': { 'node-1': portal.url } } });
    const item = await withScenario('e2e-nobaseline', NOBASELINE_SOURCE, () => withDemoEnv(env, () => onlyTest([])));
    expect(item.status).toBe('failed');
    expect(item.errors.length).toBeGreaterThan(0);
    expect(item.errors.some((message) => message.includes('[config]'))).toBe(true);
    expect(item.errors.some((message) => message.includes('e2e-nobaseline') && message.includes('unknown_ms'))).toBe(true);
    for (const message of item.errors) {
      expect(message).not.toContain('fn-was-called');
    }
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});

test('a slow step gives one slow error and still one screenshot', async () => {
  const portal = await startPortal('slowOnce');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const item = await withDemoEnv(env, () => onlyTest([]));
    expect(item.status).toBe('failed');
    expect(item.errors).toHaveLength(1);
    expect(item.errors[0]).toMatch(/^(?:Error: )?\[slow\] /);
    expectOnePng(item);
  } finally {
    await portal.stop();
  }
});
