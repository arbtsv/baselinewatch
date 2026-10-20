// Checks per-step slow verdicts through the packed core: a portal that is slow once, then normal,
// and a portal that is always slow.
//
// Run: npm run e2e -- test/e2e/demo-slow.spec.ts
import { expect, test } from '@playwright/test';
import { demoEnv, parseJsonReport, runDemoPlaywright, withDemoEnv, type JsonTest } from '../helpers/demo.ts';
import { startPortal } from '../helpers/portal.ts';

function verdicts(item: JsonTest): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (const annotation of item.annotations) {
    if (annotation.type !== 'blw.metric') continue;
    const entry = JSON.parse(annotation.description ?? '{}') as { name: string; verdict: unknown };
    found[entry.name] = entry.verdict;
  }
  return found;
}

// Playwright puts the error name in front of the message; the slow marker follows it.
const SLOW_MESSAGE = /^(?:Error: )?\[slow\] /;

function expectOneSlowError(item: JsonTest): void {
  expect(item.status).toBe('failed');
  expect(item.errors).toHaveLength(1);
  const [message] = item.errors as [string];
  expect(message).toMatch(SLOW_MESSAGE);
  expect(message).toContain('overview_ms');
  expect(message).not.toContain('login_ms');
  expect(message).not.toContain('history_ms');
}

test('slowOnce: the first run fails with one slow error, the second run passes', async () => {
  const portal = await startPortal('slowOnce');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    await withDemoEnv(env, async () => {
      const first = await runDemoPlaywright(['test', '--reporter=json']);
      expect(first.timedOut).toBe(false);
      expect(first.status).not.toBe(0);
      const firstReport = parseJsonReport(first);
      expect(firstReport.tests).toHaveLength(1);
      const [slowRun] = firstReport.tests as [JsonTest];
      expectOneSlowError(slowRun);
      expect(verdicts(slowRun)).toEqual({ login_ms: 'ok', overview_ms: 'slow', history_ms: 'ok' });

      const second = await runDemoPlaywright(['test', '--reporter=json']);
      expect(second.timedOut).toBe(false);
      expect(second.status, second.stderr).toBe(0);
      const secondReport = parseJsonReport(second);
      expect(secondReport.tests).toHaveLength(1);
      const [normalRun] = secondReport.tests as [JsonTest];
      expect(normalRun.status).toBe('passed');
      expect(verdicts(normalRun)).toEqual({ login_ms: 'ok', overview_ms: 'ok', history_ms: 'ok' });
    });
  } finally {
    await portal.stop();
  }
});

test('slowAlways: the run fails with one slow error naming overview_ms', async () => {
  const portal = await startPortal('slowAlways');
  try {
    const env = await demoEnv({ 'node-1': portal.url });
    const run = await withDemoEnv(env, () => runDemoPlaywright(['test', '--reporter=json']));
    expect(run.timedOut).toBe(false);
    expect(run.status).not.toBe(0);
    const report = parseJsonReport(run);
    expect(report.tests).toHaveLength(1);
    const [item] = report.tests as [JsonTest];
    expectOneSlowError(item);
    expect(verdicts(item)).toEqual({ login_ms: 'ok', overview_ms: 'slow', history_ms: 'ok' });
  } finally {
    await portal.stop();
  }
});
