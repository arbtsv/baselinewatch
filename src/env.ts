// Loader for env.json: the environment name, locale, account and the scenario -> node -> URL map.
import { ConfigError, isPlainObject, readJsonConfig } from './errors.ts';
import { nameProblem } from './names.ts';
import { didYouMean } from './suggest.ts';

export type Locale = 'en' | 'ru';
export type Account = { login: string; password: string };
export type MonitorEnv = {
  environment: string;
  locale: Locale;
  account: Account;
  retention_days: number;
  scenarios: Record<string, { nodes: Record<string, string> }>;
};

export const DEFAULT_RETENTION_DAYS = 30 as const;

const TOP_KEYS = ['environment', 'locale', 'account', 'retention_days', 'scenarios'] as const;
const ACCOUNT_KEYS = ['login', 'password'] as const;
const SCENARIO_KEYS = ['nodes'] as const;

const FIX_MISSING = 'Add it as in env.example.json';
const FIX_VALUE = 'Fix the value as in env.example.json';
const FIX_UNKNOWN = 'Remove it or correct its name';

// A key as it may appear in a message: control characters hidden, long keys cut.
function shown(key: string): string {
  const clean = key.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 40 ? clean.slice(0, 40) : clean;
}

// Rejects every key outside the allowed list, with a hint when the key is a near miss.
function rejectUnknownKeys(file: string, object: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) {
      continue;
    }
    const hint = didYouMean(key, allowed);
    const suffix = hint === undefined ? '' : ` (did you mean "${hint}"?)`;
    throw new ConfigError(file, `${where}unknown key "${shown(key)}"${suffix}`, FIX_UNKNOWN);
  }
}

function requireKey(file: string, object: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.hasOwn(object, key)) {
    throw new ConfigError(file, `${where}missing "${key}"`, FIX_MISSING);
  }
  return object[key];
}

function nonEmptyString(file: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(file, `${label} must be a non-empty string`, FIX_VALUE);
  }
  return value;
}

// Only http and https, and no user name or password in the URL. The URL itself is never echoed.
function isPlainWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
}

function checkScenarios(file: string, value: unknown): MonitorEnv['scenarios'] {
  if (!isPlainObject(value)) {
    throw new ConfigError(file, 'scenarios must be an object that maps scenario names to their nodes', FIX_VALUE);
  }
  const names = Object.keys(value);
  if (names.length === 0) {
    throw new ConfigError(file, 'scenarios must name at least one scenario', FIX_VALUE);
  }
  const scenarios: MonitorEnv['scenarios'] = {};
  for (const scenario of names) {
    const scenarioRule = nameProblem('scenario', scenario);
    if (scenarioRule !== undefined) {
      throw new ConfigError(file, `scenario name "${shown(scenario)}" ${scenarioRule}`, 'Rename the scenario');
    }
    const body = value[scenario];
    const path = `scenarios.${scenario}`;
    if (!isPlainObject(body)) {
      throw new ConfigError(file, `${path} must be an object with the key "nodes"`, FIX_VALUE);
    }
    rejectUnknownKeys(file, body, SCENARIO_KEYS, `${path}: `);
    const nodes = requireKey(file, body, 'nodes', `${path}: `);
    if (!isPlainObject(nodes)) {
      throw new ConfigError(file, `${path}.nodes must be an object that maps node names to URLs`, FIX_VALUE);
    }
    const nodeNames = Object.keys(nodes);
    if (nodeNames.length === 0) {
      throw new ConfigError(file, `${path}.nodes must name at least one node`, FIX_VALUE);
    }
    const copy: Record<string, string> = {};
    for (const node of nodeNames) {
      const nodeRule = nameProblem('node', node);
      if (nodeRule !== undefined) {
        throw new ConfigError(file, `${path}: node name "${shown(node)}" ${nodeRule}`, 'Rename the node');
      }
      const url = nodes[node];
      if (!isPlainWebUrl(url)) {
        throw new ConfigError(file, `${path}.nodes.${node} must be an http or https URL without user name or password`, FIX_VALUE);
      }
      copy[node] = url;
    }
    scenarios[scenario] = { nodes: copy };
  }
  return scenarios;
}

// Reads env.json on every call (no cache, nothing written). Any problem is a ConfigError that names
// the file and the key; no message carries the login, the password or a node URL.
export function loadEnv(file: string): MonitorEnv {
  const parsed = readJsonConfig(file, 'Create it from env.example.json and fill in the account and node URLs');
  if (!isPlainObject(parsed)) {
    throw new ConfigError(file, 'must be a JSON object', 'Start from env.example.json');
  }
  rejectUnknownKeys(file, parsed, TOP_KEYS, '');

  const environment = nonEmptyString(file, requireKey(file, parsed, 'environment', ''), 'environment');

  const locale = requireKey(file, parsed, 'locale', '');
  if (locale !== 'en' && locale !== 'ru') {
    throw new ConfigError(file, 'locale must be "en" or "ru"', FIX_VALUE);
  }

  const accountValue = requireKey(file, parsed, 'account', '');
  if (!isPlainObject(accountValue)) {
    throw new ConfigError(file, 'account must be an object with login and password', FIX_VALUE);
  }
  rejectUnknownKeys(file, accountValue, ACCOUNT_KEYS, 'account: ');
  const login = nonEmptyString(file, requireKey(file, accountValue, 'login', 'account: '), 'account.login');
  const password = nonEmptyString(file, requireKey(file, accountValue, 'password', 'account: '), 'account.password');

  let retentionDays: number = DEFAULT_RETENTION_DAYS;
  if (Object.hasOwn(parsed, 'retention_days')) {
    const days = parsed.retention_days;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 0) {
      throw new ConfigError(file, 'retention_days must be a whole number of days, 0 or more', FIX_VALUE);
    }
    // A JSON "-0" is a valid zero; keep the stored value a plain 0.
    retentionDays = days === 0 ? 0 : days;
  }

  const scenarios = checkScenarios(file, requireKey(file, parsed, 'scenarios', ''));

  return { environment, locale, account: { login, password }, retention_days: retentionDays, scenarios };
}
