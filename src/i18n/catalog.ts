// The one key type that every language catalog satisfies. A language that misses a key, or gives it
// another kind of value, fails the typecheck; a unit test repeats the check at run time. The machine
// tokens (RESULT=, REASON=, the class, recheck and reason tokens) are never catalog values.
import type { NotReadyReason, Reason, ResultToken, RunWarning } from '../protocol.ts';

export type Catalog = {
  // Header labels of the report.
  reportTitle: string;
  labelRunId: string;
  labelStartedAt: string;
  labelFinishedAt: string;
  labelLocale: string;
  labelResult: string;
  // Column titles of the table of nodes and metrics.
  colScenario: string;
  colNode: string;
  colClass: string;
  colMetric: string;
  colMs: string;
  colReference: string;
  colLimit: string;
  colRatio: string;
  colVerdict: string;
  colRecheck: string;
  // The table of a run that measured no node.
  noNodes: string;
  // Section headings and the marker of an empty section.
  sectionNotMeasured: string;
  sectionUnusedBaselines: string;
  sectionWarnings: string;
  none: string;
  // Sentences. Each takes typed arguments, so a translation cannot drop a value.
  /** One localized sentence per warning code. */
  warning: (warning: RunWarning) => string;
  /** The result of the run, for example 'Result: FAIL (slow)'; the tokens stay as they are. */
  resultLine: (result: ResultToken, reason: Reason | null) => string;
  /** The console line that names the report file. */
  reportSaved: (path: string) => string;
  /** The framing line before a configuration error message on exit 3. */
  notReady: (reason: NotReadyReason) => string;
  /** One generic line after an unexpected failure; the details are in the log file. */
  internalError: (logPath: string) => string;
};
