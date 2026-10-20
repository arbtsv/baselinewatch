// Builds the Playwright configuration from env.json and baselines.json: one project per scenario
// and node. The account never goes into the config; only the path of env.json does.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { loadBaselines, type Baselines } from './baselines.ts';
import { loadEnv, type MonitorEnv } from './env.ts';
import type { MonitorOptions, MonitorWorkerOptions } from './fixture.ts';
import { MANUAL_RUN, readRunContext, runLayout, type RunContext } from './layout.ts';
import { GLOBAL_TIMEOUT_MS } from './protocol.ts';
import { checkScenarioFiles } from './scenarios.ts';

// The CLI checks scenario files without loading Playwright; existing callers keep this export.
export { checkScenarioFiles } from './scenarios.ts';

/**
 * Timeouts the core fixes for every project, in whole milliseconds. env.json cannot change them:
 * its loader rejects unknown keys, and nothing here reads user input.
 */
export const POLICY = {
  testTimeoutMs: 30_000,
  expectTimeoutMs: 5_000,
  actionTimeoutMs: 10_000,
  navigationTimeoutMs: 15_000,
  // The whole Playwright run, not one test: a run that is still going after this long is cut off.
  globalTimeoutMs: GLOBAL_TIMEOUT_MS,
} as const;

// Browser launch arguments that keep monitoring traffic off the system proxy: the browser connects
// to the portal directly. An explicit direct proxy makes Chromium connect to every host directly
// and takes precedence over the operating system's proxy settings. The no-proxy switch looks
// equivalent but did not override a Windows system proxy, so it is not used. Playwright's own proxy
// launch option is not used for this either. Loopback addresses bypass system proxies anyway, so
// the effect is checked by test/e2e/system-proxy.spec.ts on a machine where a system proxy applies.
export const DIRECT_CONNECTION_ARGS: readonly string[] = ['--proxy-server=direct://'];

// The reporters are loaded by Playwright from a file path. This module's own extension picks the
// matching one: .ts when the sources run directly, .js from the built package.
const MODULE_EXTENSION = path.extname(fileURLToPath(import.meta.url));

function reporterFile(name: 'data' | 'console'): string {
  return fileURLToPath(new URL(`./reporters/${name}${MODULE_EXTENSION}`, import.meta.url));
}

export type MonitorConfigOptions = {
  /** Path of env.json, relative to rootDir unless absolute. Default: "env.json". */
  env?: string;
  /** Path of baselines.json, relative to rootDir unless absolute. Default: "baselines.json". */
  baselines?: string;
  /**
   * Project directory that holds scenarios/, env.json and baselines.json. Default: BLW_ROOT when
   * blw run started Playwright, else process.cwd().
   */
  rootDir?: string;
};

export type MonitorConfigInput = {
  env: MonitorEnv;
  baselines: Baselines;
  rootDir: string;
  envFile: string;
  baselinesFile: string;
  /** Which run and pass this process belongs to. Default: the manual run. */
  run?: RunContext;
};

/**
 * Pure: turns the two parsed files into a config object. It reads no file and prints nothing.
 * Projects follow the order of env.json (scenarios first, then nodes). Each project is named
 * "<scenario>--<node>", runs scenarios/<scenario>.spec.ts and uses the node URL as written in
 * env.json as the base URL. The account is not copied anywhere.
 */
export function buildMonitorConfig(input: MonitorConfigInput): PlaywrightTestConfig<MonitorOptions, MonitorWorkerOptions> {
  const { env, baselines, rootDir, envFile, baselinesFile, run } = input;
  const projects: NonNullable<PlaywrightTestConfig<MonitorOptions, MonitorWorkerOptions>['projects']> = [];
  for (const [scenario, body] of Object.entries(env.scenarios)) {
    const scenarioBaselines = Object.hasOwn(baselines, scenario) ? baselines[scenario] : {};
    for (const [node, url] of Object.entries(body.nodes)) {
      projects.push({
        name: `${scenario}--${node}`,
        testMatch: `${scenario}.spec.ts`,
        metadata: { scenario, node },
        use: {
          baseURL: url,
          blwScenario: scenario,
          blwBaselines: scenarioBaselines,
          blwBaselinesFile: baselinesFile,
          blwEnvFile: envFile,
        },
      });
    }
  }
  const layout = runLayout(rootDir, run ?? MANUAL_RUN);
  return {
    testDir: path.join(rootDir, 'scenarios'),
    outputDir: layout.outputDir,
    // A failed sign-in must never be repeated: repeating a rejected login can lock the account.
    retries: 0,
    workers: 1,
    fullyParallel: false,
    // A focused test would silently skip the other scenarios and still report a pass.
    forbidOnly: true,
    timeout: POLICY.testTimeoutMs,
    globalTimeout: POLICY.globalTimeoutMs,
    expect: { timeout: POLICY.expectTimeoutMs },
    // The data reporter writes pass-N.json and the CSV history and prints nothing. The console
    // reporter prints the progress lines; it reports itself as printing, so Playwright adds no
    // reporter of its own. The html report is the local debugging report; 'never' keeps it from
    // serving the report and waiting for a keypress after a failed run, which would hang an
    // unattended run.
    reporter: [
      [
        reporterFile('data'),
        {
          runId: layout.runId,
          pass: layout.pass,
          manual: (run ?? MANUAL_RUN).manual,
          passFile: layout.passFile,
          metricsCsv: layout.metricsCsv,
          baselines,
        },
      ],
      [reporterFile('console'), { pass: layout.pass }],
      ['html', { outputFolder: layout.htmlDir, open: 'never' }],
    ],
    use: {
      trace: 'off',
      video: 'off',
      screenshot: 'off',
      actionTimeout: POLICY.actionTimeoutMs,
      navigationTimeout: POLICY.navigationTimeoutMs,
      launchOptions: { args: [...DIRECT_CONNECTION_ARGS] },
    },
    projects,
  };
}

/**
 * Reads env.json and baselines.json and builds the Playwright config for them.
 *
 * Options, all optional:
 * - `env`: path of env.json (default "env.json").
 * - `baselines`: path of baselines.json (default "baselines.json", next to playwright.config.ts).
 * - `rootDir`: the project directory the two paths and scenarios/ are resolved against. It defaults
 *   to BLW_ROOT, which blw run sets, and otherwise to process.cwd(), so a hand-started run needs
 *   Playwright to start from the project directory.
 *
 * The run id and the pass come from BLW_RUN_ID and BLW_PASS; without them this is the manual run.
 *
 * Playwright evaluates the config in the runner and again in every worker; this function reads the
 * environment and the two files but has no side effects, so that is safe.
 */
export function defineMonitorConfig(
  options: MonitorConfigOptions = {},
): PlaywrightTestConfig<MonitorOptions, MonitorWorkerOptions> {
  const rootDir = path.resolve(options.rootDir ?? process.env.BLW_ROOT ?? process.cwd());
  const run = readRunContext(process.env);
  const envFile = path.resolve(rootDir, options.env ?? 'env.json');
  const baselinesFile = path.resolve(rootDir, options.baselines ?? 'baselines.json');
  const env = loadEnv(envFile);
  const baselines = loadBaselines(baselinesFile);
  checkScenarioFiles(rootDir, Object.keys(env.scenarios));
  return defineConfig(buildMonitorConfig({ env, baselines, rootDir, envFile, baselinesFile, run }));
}
