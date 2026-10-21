// The CSV history: metrics.csv gets one row per measured metric of every pass, runs.csv one row per
// run. Both files only grow. This module renders rows and appends them; rows are never read back, and
// only the last byte of an existing file is looked at, so a new row never joins a cut-off last line.
// Only node:fs and node:path are used at run time.
import fs from 'node:fs';
import path from 'node:path';
import type { MetricRow } from './reporters/collect.ts';
import { SCHEMA_VERSION, type Reason, type ResultToken } from './protocol.ts';

export const METRICS_CSV_HEADER: readonly string[] = [
  'run_id',
  'pass',
  'ts',
  'scenario',
  'node',
  'metric',
  'ms',
  'reference_ms',
  'max_ratio',
  'ratio',
  'verdict',
  'schema_version',
];

export const RUNS_CSV_HEADER: readonly string[] = [
  'run_id',
  'ts_start',
  'ts_end',
  'result',
  'exit_code',
  'reason',
  'core_version',
  'schema_version',
];

/** One row of runs.csv. */
export type RunsRow = {
  run_id: string;
  ts_start: string;
  ts_end: string;
  result: ResultToken;
  exit_code: 0 | 1 | 3;
  /** Null for a passing run: the field is then empty. */
  reason: Reason | null;
  core_version: string;
};

const NEEDS_QUOTES = /[",\r\n]/;

/** A field as CSV text: in quotes, with doubled quotes, when it holds a comma, a quote or a line break. */
export function csvField(value: string | number): string {
  const text = String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function line(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(',');
}

/**
 * The rows of one pass, without line ends. ms has one decimal and the ratio three; the reference and
 * the limit are written as recorded. toFixed always uses a dot as the decimal separator.
 */
export function metricsCsvLines(runId: string, pass: 1 | 2, rows: readonly MetricRow[]): string[] {
  return rows.map(({ scenario, node, ts, metric }) =>
    line([
      runId,
      pass,
      ts,
      scenario,
      node,
      metric.name,
      metric.ms.toFixed(1),
      metric.reference_ms,
      metric.maxRatio,
      metric.ratio.toFixed(3),
      metric.verdict,
      SCHEMA_VERSION,
    ]),
  );
}

/** The row of one run, without a line end. */
export function runsCsvLine(row: RunsRow): string {
  return line([
    row.run_id,
    row.ts_start,
    row.ts_end,
    row.result,
    row.exit_code,
    row.reason ?? '',
    row.core_version,
    SCHEMA_VERSION,
  ]);
}

const LINE_FEED = 0x0a;

/** True when the last byte of an existing, non-empty file is not a line feed. */
function endsMidLine(file: string, size: number): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== LINE_FEED;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Appends lines to a CSV file in one write. The header goes first only when the file is missing or
 * empty; an existing file is never rewritten. When an existing file does not end with a line feed
 * (a cut-off last row), one is written first so the new rows never join that line. No lines leave the
 * file, and its absence, alone. Every read or write failure is thrown to the caller.
 */
export function appendCsv(file: string, header: readonly string[], lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const needsHeader = size === 0;
  const prefix = !needsHeader && endsMidLine(file, size) ? '\n' : '';
  const all = needsHeader ? [line(header), ...lines] : lines;
  fs.appendFileSync(file, prefix + all.map((entry) => `${entry}\n`).join(''), 'utf8');
}
