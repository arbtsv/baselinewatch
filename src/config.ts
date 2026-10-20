// Builds the Playwright configuration from env.json and baselines.json: one project per scenario
// and node. The account never goes into the config; only the path of env.json does.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { loadBaselines, type Baselines } from './baselines.ts';
import { loadEnv, type MonitorEnv } from './env.ts';
import { ConfigError } from './errors.ts';
import type { MonitorOptions, MonitorWorkerOptions } from './fixture.ts';
import { runLayout } from './layout.ts';

/**
 * Timeouts the core fixes for every project, in whole milliseconds. env.json cannot change them:
 * its loader rejects unknown keys, and nothing here reads user input.
 */
export const POLICY = {
  testTimeoutMs: 30_000,
  expectTimeoutMs: 5_000,
  actionTimeoutMs: 10_000,
  navigationTimeoutMs: 15_000,
} as const;

// Browser launch arguments that keep monitoring traffic off the system proxy: the browser connects
// to the portal directly. An explicit direct proxy makes Chromium connect to every host directly
// and takes precedence over the operating system's proxy settings. The no-proxy switch looks
// equivalent but did not override a Windows system proxy, so it is not used. Playwright's own proxy
// launch option is not used for this either. Loopback addresses bypass system proxies anyway, so
// the effect is checked by test/e2e/system-proxy.spec.ts on a machine where a system proxy applies.
export const DIRECT_CONNECTION_ARGS: readonly string[] = ['--proxy-server=direct://'];

export type MonitorConfigOptions = {
  /** Path of env.json, relative to rootDir unless absolute. Default: "env.json". */
  env?: string;
  /** Path of baselines.json, relative to rootDir unless absolute. Default: "baselines.json". */
  baselines?: string;
  /** Project directory that holds scenarios/, env.json and baselines.json. Default: process.cwd(). */
  rootDir?: string;
};

export type MonitorConfigInput = {
  env: MonitorEnv;
  baselines: Baselines;
  rootDir: string;
  envFile: string;
  baselinesFile: string;
};

/**
 * Pure: turns the two parsed files into a config object. It reads no file and prints nothing.
 * Projects follow the order of env.json (scenarios first, then nodes). Each project is named
 * "<scenario>--<node>", runs scenarios/<scenario>.spec.ts and uses the node URL as written in
 * env.json as the base URL. The account is not copied anywhere.
 */
export function buildMonitorConfig(input: MonitorConfigInput): PlaywrightTestConfig<MonitorOptions, MonitorWorkerOptions> {
  const { env, baselines, rootDir, envFile, baselinesFile } = input;
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
  const layout = runLayout(rootDir);
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
    expect: { timeout: POLICY.expectTimeoutMs },
    // The html report is the only reporter; 'never' keeps it from serving the report and waiting
    // for a keypress after a failed run, which would hang an unattended run.
    reporter: [['html', { outputFolder: layout.htmlDir, open: 'never' }]],
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
 * Checks that every scenario has its file scenarios/<scenario>.spec.ts under rootDir. The names are
 * compared exactly as listed by the directory, so "Demo.spec.ts" does not satisfy scenario "demo",
 * on Windows and on Linux alike. A name that would resolve outside scenarios/ is an error as well,
 * on top of the name rules the env.json loader already applies.
 */
export function checkScenarioFiles(rootDir: string, scenarios: readonly string[]): void {
  const scenariosDir = path.join(rootDir, 'scenarios');
  let present: string[];
  try {
    present = fs.readdirSync(scenariosDir);
  } catch {
    present = [];
  }
  for (const scenario of scenarios) {
    const expected = `${scenario}.spec.ts`;
    const target = path.join(scenariosDir, expected);
    const relative = path.relative(scenariosDir, target);
    if (relative.startsWith('..') || relative.includes(path.sep) || path.isAbsolute(relative)) {
      throw new ConfigError(
        target,
        `scenario "${scenario}" in env.json resolves to a file outside the scenarios directory`,
        'Use a plain scenario name without path separators',
      );
    }
    if (!present.includes(expected)) {
      throw new ConfigError(
        target,
        `scenario file not found for scenario "${scenario}" in env.json`,
        `Create scenarios/${expected} or remove the scenario from env.json`,
      );
    }
  }
}

/**
 * Reads env.json and baselines.json and builds the Playwright config for them.
 *
 * Options, all optional:
 * - `env`: path of env.json (default "env.json").
 * - `baselines`: path of baselines.json (default "baselines.json", next to playwright.config.ts).
 * - `rootDir`: the project directory the two paths and scenarios/ are resolved against. It defaults
 *   to process.cwd(), so start Playwright from the project directory.
 *
 * Playwright evaluates the config in the runner and again in every worker; this function has no side
 * effects, so that is safe.
 */
export function defineMonitorConfig(
  options: MonitorConfigOptions = {},
): PlaywrightTestConfig<MonitorOptions, MonitorWorkerOptions> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const envFile = path.resolve(rootDir, options.env ?? 'env.json');
  const baselinesFile = path.resolve(rootDir, options.baselines ?? 'baselines.json');
  const env = loadEnv(envFile);
  const baselines = loadBaselines(baselinesFile);
  checkScenarioFiles(rootDir, Object.keys(env.scenarios));
  return defineConfig(buildMonitorConfig({ env, baselines, rootDir, envFile, baselinesFile }));
}
