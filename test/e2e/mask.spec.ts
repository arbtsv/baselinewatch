// The pixel check of the password mask. Portal mode broken answers a sign-in with the form again and
// shows the typed password in clear text; every pixel inside the password field of the screenshot that
// the fixture takes at the end of the test must then be the mask colour. A control run that fills the
// same fields without fillSecret shows that the check can fail.
//
// Run: npm run e2e -- test/e2e/mask.spec.ts
// Proof of 20 runs in a row: npm run e2e -- test/e2e/mask.spec.ts --repeat-each=20 -g "every pixel"
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { MASK_COLOR } from '../../src/protocol.ts';
import { demoEnv, parseJsonReport, runDemoPlaywright, withDemoEnv, withScenario, type JsonTest } from '../helpers/demo.ts';
import { countNotColour, decodePng, maskCheckArea } from '../helpers/png.ts';
import { startPortal } from '../helpers/portal.ts';

const BOX_ANNOTATION = 'e2e.password-box';

/** The mask colour the fixture uses, as an RGB triple. */
function maskRgb(): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(MASK_COLOR);
  if (match === null) throw new Error(`the mask colour ${MASK_COLOR} is not #RRGGBB`);
  return [parseInt(match[1] as string, 16), parseInt(match[2] as string, 16), parseInt(match[3] as string, 16)];
}

// After the sign-in click the broken portal answers with the form again, password in clear text.
function scenario(fill: 'fillSecret' | 'plain'): string {
  const fillLines =
    fill === 'fillSecret'
      ? `await fillSecret(page.getByLabel('Login'), account.login);
  await fillSecret(page.getByLabel('Password'), account.password);`
      : `await page.getByLabel('Login').fill(account.login);
  await page.getByLabel('Password').fill(account.password);`;
  return `import { test } from 'baselinewatch';

test('the password field in clear text', async ({ page, account${fill === 'fillSecret' ? ', fillSecret' : ''} }, testInfo) => {
  await page.goto('/');
  ${fillLines}
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/login');
  const box = await page.getByLabel('Password').boundingBox();
  const scale = await page.evaluate(() => window.devicePixelRatio);
  testInfo.annotations.push({ type: '${BOX_ANNOTATION}', description: JSON.stringify({ box, scale, viewport: page.viewportSize() }) });
});
`;
}

type Probe = {
  box: { x: number; y: number; width: number; height: number };
  scale: number;
  viewport: { width: number; height: number };
};

/** Runs the scenario against the broken portal and returns what it measured and the screenshot file it left. */
async function probe(name: string, source: string): Promise<{ found: Probe; png: Buffer }> {
  const portal = await startPortal('broken');
  try {
    const env = await demoEnv({}, { scenarios: { [name]: { 'node-1': portal.url } } });
    const run = await withScenario(name, source, () => withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json'])));
    expect(run.timedOut).toBe(false);
    const [item] = parseJsonReport(run).tests as [JsonTest];
    expect(item.status, item.errors.join('\n')).toBe('passed');
    const note = item.annotations.find((annotation) => annotation.type === BOX_ANNOTATION);
    expect(note, 'the scenario did not record the box').toBeDefined();
    const shots = item.attachments.filter((attachment) => attachment.name === 'screenshot');
    expect(shots).toHaveLength(1);
    const [shot] = shots as [JsonTest['attachments'][number]];
    expect(shot.body).toBeUndefined();
    expect(shot.path, 'the screenshot is not attached as a file').toBeDefined();
    return { found: JSON.parse(note?.description ?? '{}') as Probe, png: fs.readFileSync(shot.path as string) };
  } finally {
    await portal.stop();
  }
}

test('mode broken: every pixel inside the masked password field is the mask colour', async () => {
  const { found, png } = await probe('e2e-maskcheck', scenario('fillSecret'));
  const image = decodePng(png);
  // The fixture takes a viewport screenshot, so the box needs no scroll offset: the image must be the viewport times the scale.
  expect(image.width).toBe(Math.round(found.viewport.width * found.scale));
  expect(image.height).toBe(Math.round(found.viewport.height * found.scale));
  const area = maskCheckArea(found.box, found.scale);
  expect((area.x1 - area.x0) * (area.y1 - area.y0)).toBeGreaterThan(1000);
  expect(countNotColour(image, area, maskRgb())).toBe(0);
});

test('control: without fillSecret the same area is not the mask colour, so the check can fail', async () => {
  const { found, png } = await probe('e2e-nomaskcheck', scenario('plain'));
  const image = decodePng(png);
  const area = maskCheckArea(found.box, found.scale);
  const total = (area.x1 - area.x0) * (area.y1 - area.y0);
  expect(countNotColour(image, area, maskRgb())).toBe(total);
});
