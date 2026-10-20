// Pure rendering of what the operator reads: the text of report.txt and the localized console lines.
// Every function takes the language catalog as a parameter, reads no file and prints nothing. The
// machine lines (RESULT=, REASON=) are not made here; they come from the outcome module.
import type { Catalog } from './i18n/catalog.ts';
import type { MetricRef, NotReadyReason, Summary, SummaryNode } from './protocol.ts';

const COLUMN_GAP = '  ';
const EMPTY_CELL = '-';

// One line of cells, left-aligned to the given widths, without trailing spaces.
function tableLine(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 0))
    .join(COLUMN_GAP)
    .trimEnd();
}

// The rows of one node: one per metric, or a single row with dashes when it measured nothing. The
// class and the recheck repeat on every row.
function nodeRows(node: SummaryNode): string[][] {
  const recheck = node.recheck ?? EMPTY_CELL;
  if (node.metrics.length === 0) {
    return [[node.scenario, node.node, node.class, ...Array<string>(5).fill(EMPTY_CELL), EMPTY_CELL, recheck]];
  }
  return node.metrics.map((metric) => [
    node.scenario,
    node.node,
    node.class,
    metric.name,
    metric.ms.toFixed(1),
    String(metric.reference_ms),
    String(Math.round(metric.reference_ms * metric.maxRatio)),
    metric.ratio.toFixed(3),
    metric.verdict,
    recheck,
  ]);
}

function tableLines(summary: Summary, catalog: Catalog): string[] {
  if (summary.nodes.length === 0) {
    return [catalog.noNodes];
  }
  const header = [
    catalog.colScenario,
    catalog.colNode,
    catalog.colClass,
    catalog.colMetric,
    catalog.colMs,
    catalog.colReference,
    catalog.colLimit,
    catalog.colRatio,
    catalog.colVerdict,
    catalog.colRecheck,
  ];
  const rows = [header, ...summary.nodes.flatMap(nodeRows)];
  const widths = header.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows.map((row) => tableLine(row, widths));
}

function sectionLines(title: string, entries: readonly string[], none: string): string[] {
  return [title, ...(entries.length === 0 ? [`  ${none}`] : entries.map((entry) => `  ${entry}`))];
}

function metricRefLine(ref: MetricRef): string {
  return `${ref.scenario} / ${ref.node} / ${ref.metric}`;
}

/**
 * The text of report.txt. LF line ends, one trailing newline, no byte order mark. The header, the
 * table of nodes and metrics, the three sections and the result line close it.
 */
export function renderReport(summary: Summary, catalog: Catalog): string {
  const result = catalog.resultLine(summary.result, summary.reason);
  const lines = [
    catalog.reportTitle,
    `${catalog.labelRunId}: ${summary.run_id}`,
    `${catalog.labelStartedAt}: ${summary.started_at}`,
    `${catalog.labelFinishedAt}: ${summary.finished_at}`,
    `${catalog.labelLocale}: ${summary.locale}`,
    result,
    '',
    ...tableLines(summary, catalog),
    '',
    ...sectionLines(catalog.sectionNotMeasured, summary.not_measured.map(metricRefLine), catalog.none),
    '',
    ...sectionLines(catalog.sectionUnusedBaselines, summary.unused_baselines.map(metricRefLine), catalog.none),
    '',
    ...sectionLines(catalog.sectionWarnings, summary.warnings.map((warning) => catalog.warning(warning)), catalog.none),
    '',
    result,
  ];
  return `${lines.join('\n')}\n`;
}

/** The localized console lines after a run: the result and where the report is. */
export function consoleSummary(summary: Summary, catalog: Catalog, reportPath: string): string[] {
  return [catalog.resultLine(summary.result, summary.reason), catalog.reportSaved(reportPath)];
}

/**
 * The console lines when the environment is not ready: the localized framing line, then the
 * configuration error message exactly as it came, when there is one.
 */
export function notReadyLines(reason: NotReadyReason, message: string | undefined, catalog: Catalog): string[] {
  return message === undefined ? [catalog.notReady(reason)] : [catalog.notReady(reason), message];
}

/** The one generic console line after an unexpected failure. */
export function internalErrorLines(logPath: string, catalog: Catalog): string[] {
  return [catalog.internalError(logPath)];
}
