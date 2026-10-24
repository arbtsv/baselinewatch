// Checks the end-of-test screenshot taken by the fixture in every outcome, maskLocator, and the
// measure contract end to end, through the packed core.
//
// Run: npm run e2e -- test/e2e/measure.spec.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  cleanArtifacts,
  DEMO_ARTIFACTS_DIR,
  demoEnv,
  expectNoDemoSecrets,
  parseJsonReport,
  runDemoPlaywright,
  withDemoEnv,
  withScenario,
  type JsonTest,
} from '../helpers/demo.ts';
import { countColour, decodePng } from '../helpers/png.ts';
import { startPortal } from '../helpers/portal.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const MANUAL_RESULTS = path.join(DEMO_ARTIFACTS_DIR, 'runs', 'manual', 'pass-1', 'test-results');

function screenshots(item: JsonTest): JsonTest['attachments'] {
  return item.attachments.filter((attachment) => attachment.name === 'screenshot');
}

function expectOnePng(item: JsonTest): void {
  const found = screenshots(item);
  expect(found).toHaveLength(1);
  const [shot] = found as [JsonTest['attachments'][number]];
  expect(shot.contentType).toBe('image/png');
  // The fixture attaches a file, so the JSON report names the copy that Playwright made in the output
  // directory of the test and carries no bytes.
  expect(shot.body).toBeUndefined();
  expect(shot.path).toBeDefined();
  const file = shot.path as string;
  expect(path.isAbsolute(file)).toBe(true);
  expect(fs.existsSync(file)).toBe(true);
  const bytes = fs.readFileSync(file);
  expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  const image = decodePng(bytes);
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);
  expect(path.relative(MANUAL_RESULTS, file).startsWith('..')).toBe(false);
  // One file in the whole output of the test: a second copy next to the attachment would show here.
  const testDirectory = path.dirname(path.dirname(file));
  const copies = (fs.readdirSync(testDirectory, { recursive: true }) as string[]).filter((name) =>
    path.basename(name).startsWith('screenshot'),
  );
  expect(copies).toHaveLength(1);
}

function shotDirectories(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('blw-shot-')).sort();
}

/** Counts the pixels of the mask colour (#FF00FF) in the screenshot attachment of a test. */
function maskPixels(item: JsonTest): number {
  const [shot] = screenshots(item) as [JsonTest['attachments'][number]];
  return countColour(decodePng(fs.readFileSync(shot.path as string)), [0xff, 0x00, 0xff]);
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

const SECRET_VALUE = 'secret-value-not-real-4711';

const FILL_SECRET_SOURCE = `import { test } from 'baselinewatch';

test('fill a field with a secret', async ({ page, fillSecret }) => {
  await page.goto('/');
  await fillSecret(page.getByLabel('Login'), '${SECRET_VALUE}');
});
`;

const PLAIN_FILL_SOURCE = `import { test } from 'baselinewatch';

test('fill a field without any mask', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Login').fill('${SECRET_VALUE}');
});
`;

// A heading is not editable, so the fill is refused at once; the registration must still count.
const FILL_SECRET_FAILS_SOURCE = `import { test } from 'baselinewatch';

test('fill a target that refuses the fill', async ({ page, fillSecret }) => {
  await page.goto('/');
  await fillSecret(page.getByRole('heading', { name: 'Sign in' }), '${SECRET_VALUE}');
});
`;

test('after a pass: one PNG screenshot attachment', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const before = shotDirectories();
    const item = await withDemoEnv(env, () => onlyTest([]));
    expect(item.status).toBe('passed');
    expect(item.errors).toEqual([]);
    expectOnePng(item);
    // The temporary source of the attachment is gone once the test has ended.
    expect(shotDirectories()).toEqual(before);
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

test('fillSecret masks the filled field in the one screenshot', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-secret': { 'node-1': portal.url } } });
    const run = await withScenario('e2e-secret', FILL_SECRET_SOURCE, () =>
      withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json'])),
    );
    expect(run.timedOut).toBe(false);
    const item = parseJsonReport(run).tests[0] as JsonTest;
    expect(item.status).toBe('passed');
    expectOnePng(item);
    expect(maskPixels(item)).toBeGreaterThan(0);
    // Only the JSON reporter is visible here and it does not list the fill step; the files of a run are checked below.
    expect(run.stdout).not.toContain(SECRET_VALUE);
  } finally {
    await portal.stop();
  }
});

test('a plain fill leaves the screenshot without mask pixels', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-plainfill': { 'node-1': portal.url } } });
    const item = await withScenario('e2e-plainfill', PLAIN_FILL_SOURCE, () => withDemoEnv(env, () => onlyTest([])));
    expect(item.status).toBe('passed');
    expectOnePng(item);
    expect(maskPixels(item)).toBe(0);
  } finally {
    await portal.stop();
  }
});

test('fillSecret registers the mask before a fill that fails, and the one screenshot still shows it', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-secretfail': { 'node-1': portal.url } } });
    const item = await withScenario('e2e-secretfail', FILL_SECRET_FAILS_SOURCE, () =>
      withDemoEnv(env, () => onlyTest([])),
    );
    expect(item.status).toBe('failed');
    expect(item.errors.length).toBeGreaterThan(0);
    expectOnePng(item);
    expect(maskPixels(item)).toBeGreaterThan(0);
  } finally {
    await portal.stop();
  }
});

// The password comes from env.json at run time, as in a real scenario, so the source of the spec
// that Playwright embeds in its reports does not hold it.
const SECRET_THEN_THROW_SOURCE = `import { test } from 'baselinewatch';

test('fail after a secret fill', async ({ page, account, fillSecret }) => {
  await page.goto('/');
  await fillSecret(page.getByLabel('Password'), account.password);
  throw new Error('stop after the fill');
});
`;

test('a secret entered with fillSecret is in no file of the run, html report data included', async () => {
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({}, { scenarios: { 'e2e-secretthrow': { 'node-1': portal.url } } });
    cleanArtifacts();
    const run = await withScenario('e2e-secretthrow', SECRET_THEN_THROW_SOURCE, () =>
      withDemoEnv(env, () => runDemoPlaywright(['test'])),
    );
    expect(run.timedOut).toBe(false);
    // The scenario must have reached the fill and failed on the throw; otherwise nothing was entered
    // and the secret check below would pass for the wrong reason.
    expect(run.status).not.toBe(0);
    const passDir = path.join(DEMO_ARTIFACTS_DIR, 'runs', 'manual', 'pass-1');
    expect(fs.existsSync(path.join(passDir, 'html', 'index.html'))).toBe(true);
    const snapshots = fs
      .readdirSync(path.join(passDir, 'test-results'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(passDir, 'test-results', entry.name, 'error-context.md'))
      .filter((file) => fs.existsSync(file));
    expect(snapshots).toHaveLength(1);
    const snapshot = fs.readFileSync(snapshots[0] as string, 'utf8');
    expect(snapshot).toContain('stop after the fill');
    // The snapshot lists the password field, and the field is empty.
    expect(snapshot).toMatch(/textbox "Password"[^\n:]*(?:\n|$)/);
    await expectNoDemoSecrets(run, 'manual', { snapshots: true });
  } finally {
    await portal.stop();
  }
});
