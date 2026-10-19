// A browser started with the monitor config's launch options connects directly, even on a machine
// where a system proxy applies. Loopback addresses bypass system proxies anyway, so this check opens
// a reserved host name that no proxy bypass rule covers and reads the browser's net-log to see which
// proxy the browser chose. It skips where no system proxy applies to that name.
//
// Run: npm run e2e -- test/e2e/system-proxy.spec.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type LaunchOptions } from '@playwright/test';
import { buildMonitorConfig } from '../../src/config.ts';

const PROBE_URL = 'http://probe.example.test:4101/';

// The launch options under test come from the real config, not from a copied literal. The function
// is pure: it reads and writes nothing.
const rootDir = path.join(os.tmpdir(), 'blw-system-proxy');
const built = buildMonitorConfig({
  env: {
    environment: 'demo',
    locale: 'en',
    account: { login: 'probe-login', password: 'placeholder-password' },
    retention_days: 30,
    scenarios: { probe: { nodes: { 'node-1': PROBE_URL } } },
  },
  baselines: {},
  rootDir,
  envFile: path.join(rootDir, 'env.json'),
  baselinesFile: path.join(rootDir, 'baselines.json'),
});
const monitorLaunchOptions: LaunchOptions | undefined = built.use?.launchOptions;

type Probe = { decisions: string[]; navigation: string };

async function probe(label: string, launchOptions: LaunchOptions | undefined): Promise<Probe> {
  const file = test.info().outputPath(`${label}.netlog.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const browser = await chromium.launch({
    ...launchOptions,
    args: [...(launchOptions?.args ?? []), `--log-net-log=${file}`],
  });
  let navigation: string;
  try {
    const page = await browser.newPage();
    try {
      const response = await page.goto(PROBE_URL, { timeout: 15_000 });
      navigation = response ? `HTTP ${response.status()}` : 'no response';
    } catch (error) {
      navigation = String(error instanceof Error ? error.message : error).split('\n')[0] ?? 'error';
    }
  } finally {
    await browser.close();
  }
  // Plain text instead of JSON.parse: the file still reads if its tail is unfinished.
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const decisions = [...text.matchAll(/"proxy_info"\s*:\s*"([^"]*)"/g)].map((match) => match[1] ?? '');
  return { decisions, navigation };
}

function isDirect(value: string): boolean {
  return value.replace(/^[\s[\]]+|[\s[\]]+$/g, '') === 'DIRECT';
}

test("the monitor's launch options bypass a system proxy for a non-loopback host", async () => {
  const control = await probe('default', undefined);
  // Fail closed: a net-log without any proxy decision must not turn into a silent skip.
  expect(control.decisions.length, 'the net-log of the default launch carries no proxy decision').toBeGreaterThan(0);
  test.skip(
    control.decisions.every(isDirect),
    'no system proxy applies to probe.example.test on this machine',
  );

  const subject = await probe('monitor', monitorLaunchOptions);
  expect(subject.decisions.length, 'the net-log of the monitor launch carries no proxy decision').toBeGreaterThan(0);
  expect(
    subject.decisions.filter((decision) => !isDirect(decision)),
    `control decisions: ${JSON.stringify(control.decisions)} (${control.navigation}); ` +
      `monitor decisions: ${JSON.stringify(subject.decisions)} (${subject.navigation})`,
  ).toEqual([]);
});
