// The scenario file check. It lives apart from src/config.ts because that module loads Playwright
// and the command line must be able to run this check without it.
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.ts';

/**
 * Checks that every scenario has its file scenarios/<scenario>.spec.ts under rootDir. The names are
 * compared exactly as listed by the directory, so "Demo.spec.ts" does not satisfy scenario "demo",
 * on Windows and on Linux alike. A name that would resolve outside scenarios/ is an error as well,
 * on top of the name rules the env.json loader already applies. A missing file is reported with the
 * absolute scenarios directory that was searched, so a scheduler log shows the resolved root.
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
        `scenario file not found for scenario "${scenario}" in env.json (looked in ${path.resolve(scenariosDir)})`,
        `Create scenarios/${expected} or remove the scenario from env.json`,
      );
    }
  }
}
