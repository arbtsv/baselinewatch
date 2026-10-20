// Checks the end-of-test screenshot taken by the fixture in every outcome, maskLocator, and the
// measure contract end to end, through the packed core.
//
// Run: npm run e2e -- test/e2e/measure.spec.ts
import zlib from 'node:zlib';
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

/** Counts the pixels of the mask colour (#FF00FF) in the screenshot attachment of a test. */
function maskPixels(item: JsonTest): number {
  const [shot] = screenshots(item) as [JsonTest['attachments'][number]];
  const png = Buffer.from(shot.body as string, 'base64');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const parts: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let count = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (line[i - channels] as number) : 0;
      const up = previous[i] as number;
      const upLeft = i >= channels ? (previous[i - channels] as number) : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const dl = Math.abs(guess - left);
        const du = Math.abs(guess - up);
        const dul = Math.abs(guess - upLeft);
        add = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      line[i] = ((line[i] as number) + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      if (line[x * channels] === 255 && line[x * channels + 1] === 0 && line[x * channels + 2] === 255) count++;
    }
    previous = line;
  }
  return count;
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
    // Only the JSON reporter is visible here and it does not list the fill step; the html report is outside this check.
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
