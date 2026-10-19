// A failing demo run ends non-zero well inside a minute and leaves only the artifacts the core's
// run policy allows: no retry directories, no traces, no videos, no built-in screenshots.
//
// Run: npm run e2e -- test/e2e/bounded.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_DIR, demoEnv, runDemoPlaywright, withDemoEnv } from '../helpers/demo.ts';
import { loadPortalModule, startPortal, type PortalMode } from '../helpers/portal.ts';

const RUN_DIR = path.join(DEMO_DIR, 'artifacts', 'runs', 'manual');
const PASS_DIR = path.join(RUN_DIR, 'pass-1');
const BOUND_MS = 60_000;

type Entry = { name: string; relative: string };

function walk(dir: string, base: string = dir): Entry[] {
  const entries: Entry[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    entries.push({ name: item.name, relative: path.relative(base, full) });
    if (item.isDirectory()) entries.push(...walk(full, base));
  }
  return entries;
}

const MODES: PortalMode[] = ['loginError', 'slowAlways'];

for (const mode of MODES) {
  test(`${mode} portal: the run fails fast and leaves only policy-conforming artifacts`, async () => {
    const { DEMO_ACCOUNT } = await loadPortalModule();
    const portal = await startPortal(mode);
    try {
      // Only this run's files are inspected below.
      fs.rmSync(RUN_DIR, { recursive: true, force: true });
      const env = await demoEnv({ 'node-1': portal.url });
      // No reporter flag: the run uses the reporters from the config itself.
      const run = await withDemoEnv(env, () => runDemoPlaywright(['test'], { timeoutMs: 90_000 }));

      expect(run.timedOut).toBe(false);
      expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
      expect(run.status).not.toBeNull();
      expect(run.durationMs).toBeLessThan(BOUND_MS);

      const outputDir = path.join(PASS_DIR, 'test-results');
      const found = fs.existsSync(outputDir) ? walk(outputDir) : [];
      expect(found.filter((entry) => entry.name === 'trace.zip')).toEqual([]);
      expect(found.filter((entry) => entry.name.endsWith('.webm'))).toEqual([]);
      expect(found.filter((entry) => /^test-failed-.*\.png$/.test(entry.name))).toEqual([]);
      expect(found.filter((entry) => entry.name.endsWith('-retry1'))).toEqual([]);
      expect(fs.existsSync(path.join(PASS_DIR, 'html', 'index.html'))).toBe(true);

      for (const output of [run.stdout, run.stderr]) {
        expect(output).not.toContain(DEMO_ACCOUNT.login);
        expect(output).not.toContain(DEMO_ACCOUNT.password);
      }
    } finally {
      await portal.stop();
    }
  });
}
