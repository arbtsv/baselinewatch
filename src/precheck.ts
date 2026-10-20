// The checks that stop a run before Playwright starts, in this order: the project files (config),
// exactly one copy of @playwright/test (playwright_copies) and an installed headless browser
// (browser). Each failure becomes exit code 3 in the command line. Playwright is never imported
// here: the browser lookup reaches the project's own copy through createRequire at run time, and
// every lookup that touches the disk or the module system can be replaced in a test.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadBaselines, type Baselines } from './baselines.ts';
import { loadEnv, type Locale, type MonitorEnv } from './env.ts';
import { ConfigError, isConfigError } from './errors.ts';
import { checkScenarioFiles } from './scenarios.ts';

export type PrelaunchFailure = { reason: 'config' | 'playwright_copies' | 'browser'; message: string; locale?: Locale };

/** What the project files say: both parsed files and the project ids in env.json order. */
export type PrecheckOk = { env: MonitorEnv; baselines: Baselines; projects: string[] };

/** The lookups of the checks, so a test can answer them without a Playwright installation. */
export type PrecheckDeps = {
  /** Resolves a package request the way Node would from the given file. */
  resolveFrom: (fromFile: string, request: string) => string;
  realpath: (file: string) => string;
  exists: (file: string) => boolean;
  /** The headless shell executable of the project's Playwright; undefined when the registry API is missing. */
  headlessShellPath: (root: string) => string | undefined;
  /** Launches headless Chromium and closes it again; true when that worked. */
  launchProbe: (root: string) => Promise<boolean>;
};

const ENV_FILE = 'env.json';
const BASELINES_FILE = 'baselines.json';
const CONFIG_FILE = 'playwright.config.ts';
const TEST_PACKAGE = '@playwright/test/package.json';
const HEADLESS_SHELL = 'chromium-headless-shell';

const COPIES_MESSAGE =
  'Exactly one installed copy of @playwright/test is required, and the project and baselinewatch must use the same one. ' +
  "List @playwright/test in the project's package.json and install it there.";
const BROWSER_MESSAGE =
  'The headless Chromium browser that Playwright uses is not installed. Install it with: npx playwright install chromium';

/** Reads and checks the project files under root. Any problem is a ConfigError that names the file. */
export function checkProjectFiles(root: string): PrecheckOk {
  const base = path.resolve(root);
  const env = loadEnv(path.join(base, ENV_FILE));
  const baselines = loadBaselines(path.join(base, BASELINES_FILE));
  checkScenarioFiles(base, Object.keys(env.scenarios));
  const configFile = path.join(base, CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    throw new ConfigError(configFile, `file not found (looked for ${configFile})`, `Create ${CONFIG_FILE} in the project directory`);
  }
  const projects: string[] = [];
  for (const [scenario, body] of Object.entries(env.scenarios)) {
    for (const node of Object.keys(body.nodes)) {
      projects.push(`${scenario}--${node}`);
    }
  }
  return { env, baselines, projects };
}

// The project's own Playwright: @playwright/test, then the playwright package next to it.
function projectPlaywright(root: string): NodeJS.Require {
  const testPackage = createRequire(path.join(root, 'package.json')).resolve(TEST_PACKAGE);
  const playwrightPackage = createRequire(testPackage).resolve('playwright/package.json');
  return createRequire(playwrightPackage);
}

type RegistryHolder = {
  findExecutable?: (name: string) => { executablePath?: () => unknown } | undefined;
};

// Headless runs use the chromium-headless-shell executable, not the one the public
// chromium.executablePath() names. The registry that knows it is internal to Playwright, so every
// step is guarded: undefined means "could not ask", and the launch probe decides instead.
function defaultHeadlessShellPath(root: string): string | undefined {
  try {
    const bundle = projectPlaywright(root)('playwright-core/lib/coreBundle') as { registry?: { registry?: RegistryHolder } };
    const holder = bundle.registry?.registry;
    if (typeof holder?.findExecutable !== 'function') {
      return undefined;
    }
    const executable = holder.findExecutable(HEADLESS_SHELL);
    const file = typeof executable?.executablePath === 'function' ? executable.executablePath() : undefined;
    return typeof file === 'string' && file !== '' ? file : undefined;
  } catch {
    return undefined;
  }
}

type LaunchApi = { chromium: { launch: (options: { headless: boolean }) => Promise<{ close: () => Promise<void> }> } };

async function defaultLaunchProbe(root: string): Promise<boolean> {
  try {
    const { chromium } = projectPlaywright(root)('playwright-core') as LaunchApi;
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: PrecheckDeps = {
  resolveFrom: (fromFile, request) => createRequire(fromFile).resolve(request),
  realpath: (file) => fs.realpathSync(file),
  exists: (file) => fs.existsSync(file),
  headlessShellPath: defaultHeadlessShellPath,
  launchProbe: defaultLaunchProbe,
};

function withDefaults(deps: Partial<PrecheckDeps> | undefined): PrecheckDeps {
  return { ...DEFAULT_DEPS, ...deps };
}

/**
 * Exactly one resolved copy of @playwright/test: the real path of its package.json must be the same
 * from the project root and from the core. A package that cannot be resolved on either side is
 * reported the same way, because the run could not use it either.
 */
export function checkPlaywrightCopies(root: string, coreFile: string, deps?: Partial<PrecheckDeps>): PrelaunchFailure | undefined {
  const d = withDefaults(deps);
  try {
    const fromProject = d.realpath(d.resolveFrom(path.join(root, 'package.json'), TEST_PACKAGE));
    const fromCore = d.realpath(d.resolveFrom(coreFile, TEST_PACKAGE));
    if (fromProject === fromCore) {
      return undefined;
    }
  } catch {
    // Falls through to the failure: an unresolvable package is no usable copy.
  }
  return { reason: 'playwright_copies', message: COPIES_MESSAGE };
}

/** The headless browser is installed: its executable exists, or a short headless launch works. */
export async function checkBrowser(root: string, deps?: Partial<PrecheckDeps>): Promise<PrelaunchFailure | undefined> {
  const d = withDefaults(deps);
  let shell: string | undefined;
  try {
    shell = d.headlessShellPath(root);
  } catch {
    shell = undefined;
  }
  let installed: boolean;
  if (shell !== undefined) {
    installed = d.exists(shell);
  } else {
    try {
      installed = await d.launchProbe(root);
    } catch {
      installed = false;
    }
  }
  return installed ? undefined : { reason: 'browser', message: BROWSER_MESSAGE };
}

// The locale of a readable env.json, for the framing line of a configuration failure elsewhere in
// the project; undefined when env.json itself is the problem.
function readableLocale(root: string): Locale | undefined {
  try {
    return loadEnv(path.join(path.resolve(root), ENV_FILE)).locale;
  } catch {
    return undefined;
  }
}

/**
 * Runs the three checks in order and stops at the first failure. A failure after env.json loaded
 * carries its locale. Arguments are checked before this, by parseRunArgs.
 */
export async function runPrechecks(
  root: string,
  coreFile: string,
  deps?: Partial<PrecheckDeps>,
): Promise<{ ok: true; value: PrecheckOk } | { ok: false; failure: PrelaunchFailure }> {
  let value: PrecheckOk;
  try {
    value = checkProjectFiles(root);
  } catch (error) {
    if (!isConfigError(error)) {
      throw error;
    }
    const locale = readableLocale(root);
    return { ok: false, failure: { reason: 'config', message: error.message, ...(locale === undefined ? {} : { locale }) } };
  }
  const locale = value.env.locale;
  const copies = checkPlaywrightCopies(root, coreFile, deps);
  if (copies !== undefined) {
    return { ok: false, failure: { ...copies, locale } };
  }
  const browser = await checkBrowser(root, deps);
  if (browser !== undefined) {
    return { ok: false, failure: { ...browser, locale } };
  }
  return { ok: true, value };
}
