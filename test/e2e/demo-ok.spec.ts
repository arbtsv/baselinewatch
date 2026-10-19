// Runs the demo scenario through the packed core against the portal in ok mode.
//
// Run: npm run e2e -- test/e2e/demo-ok.spec.ts
import { expect, test } from '@playwright/test';
import { demoEnv, parseJsonReport, runDemoPlaywright, withDemoEnv, type JsonTest } from '../helpers/demo.ts';
import { loadPortalModule, startPortal } from '../helpers/portal.ts';

const METRIC_KEYS = ['maxRatio', 'ms', 'name', 'ratio', 'reference_ms', 'verdict'];

function metrics(item: JsonTest): Record<string, unknown>[] {
  return item.annotations
    .filter((annotation) => annotation.type === 'blw.metric')
    .map((annotation) => JSON.parse(annotation.description ?? '{}') as Record<string, unknown>);
}

test('ok portal: the demo scenario passes with three ok metrics in order', async () => {
  const { DEMO_ACCOUNT } = await loadPortalModule();
  const portal = await startPortal('ok');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const run = await withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json']));
    expect(run.timedOut).toBe(false);
    expect(run.status, run.stderr).toBe(0);

    const report = parseJsonReport(run);
    expect(report.tests).toHaveLength(1);
    const [item] = report.tests as [JsonTest];
    expect(item.project).toBe('demo--node-1');
    expect(item.status).toBe('passed');

    const recorded = metrics(item);
    expect(recorded.map((entry) => entry.name)).toEqual(['login_ms', 'overview_ms', 'history_ms']);
    for (const entry of recorded) {
      expect(entry.verdict).toBe('ok');
      expect(Object.keys(entry).sort()).toEqual(METRIC_KEYS);
    }

    // The JSON reporter prints the project use and metadata, so this shows that the
    // account never travels through the config.
    for (const output of [run.stdout, run.stderr]) {
      expect(output).not.toContain(DEMO_ACCOUNT.login);
      expect(output).not.toContain(DEMO_ACCOUNT.password);
    }
  } finally {
    await portal.stop();
  }
});

test('two nodes give two projects, each against its own portal', async () => {
  const first = await startPortal('ok');
  const second = await startPortal('ok');
  try {
    const env = await demoEnv({ 'node-1': first.url, 'node-2': second.url });
    const run = await withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json']));
    expect(run.timedOut).toBe(false);
    expect(run.status, run.stderr).toBe(0);

    const report = parseJsonReport(run);
    expect(report.tests.map((item) => item.project).sort()).toEqual(['demo--node-1', 'demo--node-2']);
    for (const item of report.tests) {
      expect(item.status).toBe('passed');
      expect(metrics(item).map((entry) => entry.name)).toEqual(['login_ms', 'overview_ms', 'history_ms']);
    }
  } finally {
    await first.stop();
    await second.stop();
  }
});
