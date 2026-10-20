// Loader for baselines.json: scenario -> metric -> { reference_ms, maxRatio }.
import { ConfigError, isPlainObject, readJsonConfig } from './errors.ts';
import { nameProblem } from './names.ts';
import type { BaselineEntry } from './verdict.ts';

export type Baselines = Record<string, Record<string, BaselineEntry>>;

const SET_VALUES = 'Set the approved values in baselines.json';

function cut(key: string): string {
  return key.length > 40 ? key.slice(0, 40) : key;
}

// Reads baselines.json on every call (no cache). Unknown keys inside an entry are skipped without a
// warning; the result holds fresh objects with only reference_ms and maxRatio per entry.
export function loadBaselines(file: string): Baselines {
  const parsed = readJsonConfig(file, 'Create baselines.json next to playwright.config.ts with the approved reference times');
  if (!isPlainObject(parsed)) {
    throw new ConfigError(file, 'must be a JSON object that maps scenario names to metrics', SET_VALUES);
  }
  const table: Baselines = {};
  for (const scenario of Object.keys(parsed)) {
    const scenarioRule = nameProblem('scenario', scenario);
    if (scenarioRule !== undefined) {
      throw new ConfigError(file, `scenario name "${cut(scenario)}" ${scenarioRule}`, 'Use the scenario name from env.json');
    }
    const metrics = parsed[scenario];
    if (!isPlainObject(metrics)) {
      throw new ConfigError(file, `scenario "${scenario}" must be an object that maps metric names to entries`, SET_VALUES);
    }
    const copy: Record<string, BaselineEntry> = {};
    for (const metric of Object.keys(metrics)) {
      const metricRule = nameProblem('metric', metric);
      if (metricRule !== undefined) {
        throw new ConfigError(file, `scenario "${scenario}": metric name "${cut(metric)}" ${metricRule}`, SET_VALUES);
      }
      const entry = metrics[metric];
      const where = `scenario "${scenario}", metric "${metric}"`;
      if (!isPlainObject(entry)) {
        throw new ConfigError(file, `${where}: the entry must be an object with reference_ms and maxRatio`, SET_VALUES);
      }
      const reference = Object.hasOwn(entry, 'reference_ms') ? entry.reference_ms : undefined;
      const ratio = Object.hasOwn(entry, 'maxRatio') ? entry.maxRatio : undefined;
      if (typeof reference !== 'number' || !Number.isFinite(reference) || !(reference > 0)) {
        throw new ConfigError(file, `${where}: reference_ms must be a number above 0`, SET_VALUES);
      }
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || !(ratio >= 1)) {
        throw new ConfigError(file, `${where}: maxRatio must be a number of at least 1`, SET_VALUES);
      }
      copy[metric] = { reference_ms: reference, maxRatio: ratio };
    }
    table[scenario] = copy;
  }
  return table;
}
