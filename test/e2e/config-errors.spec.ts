// A bare Playwright run in the demo project stops with a readable configuration error when env.json
// is missing or when a scenario named in env.json has no file.
//
// Run: npm run e2e -- test/e2e/config-errors.spec.ts
import { expect, test } from '@playwright/test';
import { demoEnv, runDemoPlaywright, withDemoEnv } from '../helpers/demo.ts';

test('a missing env.json stops the run and names the file', async () => {
  const run = await withDemoEnv(null, () => runDemoPlaywright(['test']));
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.timedOut).toBe(false);
  expect(run.status, output).not.toBe(0);
  expect(run.status).not.toBeNull();
  expect(output).toContain('[config]');
  expect(output).toContain('env.json');
  expect(output).toContain("reason: 'config'");
});

test('a scenario without its file stops the run and names the file', async () => {
  const env = await demoEnv({}, { scenarios: { 'e2e-ghost': { 'node-1': 'http://127.0.0.1:9/' } } });
  const run = await withDemoEnv(env, () => runDemoPlaywright(['test']));
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.timedOut).toBe(false);
  expect(run.status, output).not.toBe(0);
  expect(run.status).not.toBeNull();
  expect(output).toContain('[config]');
  expect(output).toContain('e2e-ghost.spec.ts');
  expect(output).toContain("reason: 'config'");
});
