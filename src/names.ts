// Name-safety rules for scenario, node and metric names.
//
// A scenario and a node name together form the project id "<scenario>--<node>" and a file name, so
// the pattern excludes "--", path separators, dots, glob characters, spaces and names that start
// with an underscore (such as __proto__).

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
