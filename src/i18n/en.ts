// The English strings of the report and the console. Machine tokens stay out of this file.
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
    }
  },
  resultLine: (result, reason) => (reason === null ? `Result: ${result}` : `Result: ${result} (${reason})`),
  reportSaved: (path) => `Report: ${path}`,
  notReady: (reason) => `The environment is not ready (${reason}).`,
  internalError: (logPath) => `baselinewatch stopped with an internal error; details: ${logPath}`,
};
