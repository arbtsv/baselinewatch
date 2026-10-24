// Name-safety rules for scenario, node and metric names.
//
// A scenario and a node name together form the project id "<scenario>--<node>" and a file name, so
// the pattern excludes "--", path separators, dots, glob characters, spaces and names that start
// with an underscore (such as __proto__).
//
// The account check lives here too: names end up in metrics.csv, runs.csv, summary.json and
// report.txt, which are never redacted, so a name must not hold the account login or password.
// The module loads no Playwright module.
import type { Baselines } from './baselines.ts';
import type { MonitorEnv } from './env.ts';
import { ConfigError } from './errors.ts';
import { MIN_REDACT_LENGTH } from './protocol.ts';

export const NAME_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
export const METRIC_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_NAME_LENGTH = 64;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function nameProblem(kind: 'scenario' | 'node' | 'metric', name: string): string | undefined {
  if (kind === 'metric') {
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !METRIC_PATTERN.test(name)) {
      return `must start with a lowercase letter and use only lowercase letters, digits and _ (at most ${MAX_NAME_LENGTH} characters)`;
    }
    return undefined;
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    return 'must be 1-64 lowercase letters or digits, separated by single - or _';
  }
  if (WINDOWS_DEVICE_NAME.test(name)) {
    return 'is a reserved device name on Windows';
  }
  return undefined;
}

/**
 * A value of this many characters or more is a leak as a substring, wherever it sits in a name: it is
 * the length from which a value is redacted at all, and a name is written to files that are not
 * redacted. A shorter value cannot be redacted either, so it is a leak only as a whole word, which
 * keeps a login of one or two letters from rejecting every name that holds the letter.
 */
export const WHOLE_WORD_BELOW = MIN_REDACT_LENGTH;

const METRIC_ALPHABET = /^[a-z0-9_]+$/;
const NAME_ALPHABET = /^[a-z0-9_-]+$/;

/**
 * Which account field a name holds, or undefined. The name and the value are compared without case.
 * A value with a character outside the alphabet of the name kind (a-z, 0-9, _ and, for scenario and
 * node names, -) can never be part of such a name and is skipped. A value of WHOLE_WORD_BELOW or
 * more characters is a leak when it occurs anywhere in the name, so login "ops" rejects "ops_page_ms",
 * "page_ops" and "opsview_page_ms"; a shorter one is a leak only as a whole word, so login "ab"
 * rejects "ab_page_ms" and accepts "abview_page_ms".
 * Words are separated by _ (and by - in scenario and node names). The login is checked first. The
 * value itself is never returned, logged or thrown, and a name can always be renamed to pass.
 */
export function leakedField(
  account: { login: string; password: string },
  name: string,
  kind: 'metric' | 'scenario' | 'node' = 'metric',
): 'login' | 'password' | undefined {
  const alphabet = kind === 'metric' ? METRIC_ALPHABET : NAME_ALPHABET;
  const lowered = name.toLowerCase();
  const asWords = `_${lowered.replaceAll('-', '_')}_`;
  for (const field of ['login', 'password'] as const) {
    const value = account[field].toLowerCase();
    if (value === '' || !alphabet.test(value)) {
      continue;
    }
    const hit =
      value.length >= WHOLE_WORD_BELOW ? lowered.includes(value) : asWords.includes(`_${value.replaceAll('-', '_')}_`);
    if (hit) {
      return field;
    }
  }
  return undefined;
}

/**
 * Throws a ConfigError on the first scenario name, node name or metric name that holds the account
 * login or password (see leakedField). The message names the file, the scenario and the field and
 * never the name or the value. Scenario names are checked before they appear in any later message.
 */
export function checkAccountNames(input: {
  env: MonitorEnv;
  baselines: Baselines;
  envFile: string;
  baselinesFile: string;
}): void {
  const { env, baselines, envFile, baselinesFile } = input;
  const { account } = env;
  for (const [scenario, body] of Object.entries(env.scenarios)) {
    const scenarioField = leakedField(account, scenario, 'scenario');
    if (scenarioField !== undefined) {
      throw new ConfigError(
        envFile,
        `a scenario name contains the account ${scenarioField}`,
        'Rename that scenario in env.json, baselines.json and its spec file',
      );
    }
    for (const node of Object.keys(body.nodes)) {
      const nodeField = leakedField(account, node, 'node');
      if (nodeField !== undefined) {
        throw new ConfigError(
          envFile,
          `a node name of scenario "${scenario}" contains the account ${nodeField}`,
          'Rename that node in env.json',
        );
      }
    }
    if (!Object.hasOwn(baselines, scenario)) {
      continue;
    }
    for (const metric of Object.keys(baselines[scenario] ?? {})) {
      const metricField = leakedField(account, metric, 'metric');
      if (metricField !== undefined) {
        throw new ConfigError(
          baselinesFile,
          `a metric name of scenario "${scenario}" contains the account ${metricField}`,
          `Rename that metric in baselines.json and in scenarios/${scenario}.spec.ts`,
        );
      }
    }
  }
}
