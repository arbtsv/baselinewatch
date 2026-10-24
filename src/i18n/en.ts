// The English strings of the report and the console. Machine tokens stay out of this file.
import { MIN_REDACT_LENGTH } from '../protocol.ts';
import type { Catalog } from './catalog.ts';

export const en: Catalog = {
  reportTitle: 'baselinewatch report',
  labelRunId: 'Run id',
  labelStartedAt: 'Started at',
  labelFinishedAt: 'Finished at',
  labelLocale: 'Locale',
  colScenario: 'Scenario',
  colNode: 'Node',
  colClass: 'Class',
  colMetric: 'Metric',
  colMs: 'ms',
  colReference: 'Reference',
  colLimit: 'Limit',
  colRatio: 'Ratio',
  colVerdict: 'Verdict',
  colRecheck: 'Recheck',
  noNodes: 'No node was measured.',
  sectionNotMeasured: 'Not measured',
  sectionUnusedBaselines: 'Unused baselines',
  sectionWarnings: 'Warnings',
  none: '(none)',
  warning: (warning) => {
    switch (warning.code) {
      case 'pass_invalid':
        return warning.pass === undefined
          ? 'A pass file is missing or damaged; its results were not used.'
          : `The file of pass ${warning.pass} is missing or damaged; its results were not used.`;
      case 'pass_2_not_built':
        return `The second look at ${warning.scenario ?? '?'} / ${warning.node ?? '?'} left no result.`;
      case 'history_not_written':
        return warning.pass === undefined
          ? 'The run history (runs.csv) could not be updated; details are in cli-error.log in the run directory.'
          : `The metric rows of pass ${warning.pass} could not be added to metrics.csv.`;
      case 'lock_taken_over':
        return 'A lock left by an earlier run that is no longer active was taken over.';
      case 'retention_failed':
        return `Old run items that could not be deleted: ${warning.count ?? '?'}; the next run tries again.`;
      case 'secret_too_short':
        return `The account ${warning.field ?? 'login or password'} is shorter than ${MIN_REDACT_LENGTH} characters and is not hidden in the run output.`;
      case 'binary_left_out':
        return `Files left out of the zip because they could not be cleaned of the account login or password: ${warning.count ?? '?'}.`;
      case 'zip_skipped':
        return 'The zip was not built: it is made on Windows only.';
      case 'zip_failed':
        return 'The zip could not be built; the run files are in the run directory.';
    }
  },
  resultLine: (result, reason) => (reason === null ? `Result: ${result}` : `Result: ${result} (${reason})`),
  reportSaved: (path) => `Report: ${path}`,
  notReady: (reason) => `The environment is not ready (${reason}).`,
  internalError: (logPath) => `baselinewatch stopped with an internal error; details: ${logPath}`,
};
