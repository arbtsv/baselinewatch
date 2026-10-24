// Where one run keeps its files. A run started by `blw run` has a run id and two passes, and keeps
// everything under artifacts/runs/<run id>/. A run that nobody started that way (npx playwright
// test by hand) is the manual run: runs/manual, pass 1. The cumulative files (metrics.csv, runs.csv,
// summary.json, report.txt) sit at the artifacts root.
import path from 'node:path';
import { ConfigError } from './errors.ts';

export const MANUAL_RUN_ID = 'manual' as const;

/** UTC, compact, whole seconds: 20261020T123456Z. Nothing else may become a directory name. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z$/;

// The run id inside a zip name, written out so that no other text can match.
const RUN_ID_IN_NAME = String.raw`(\d{8}T\d{6}Z)`;

/** report_<run id>.zip at the artifacts root; the first group is the run id. */
export const REPORT_ZIP_PATTERN = new RegExp(`^report_${RUN_ID_IN_NAME}\\.zip$`);

/**
 * .report_<run id>.<pid>.tmp.zip, the name a zip has while it is being built; the first group is the run
 * id. It ends in .zip because tar picks the archive format from the extension.
 */
export const TEMP_ZIP_PATTERN = new RegExp(`^\\.report_${RUN_ID_IN_NAME}\\.\\d+\\.tmp\\.zip$`);

/** The name of the finished zip of a run. */
export function reportZipName(runId: string): string {
  return `report_${runId}.zip`;
}

/** The name of the zip of a run while the process with this pid builds it. */
export function tempZipName(runId: string, pid: number): string {
  return `.report_${runId}.${pid}.tmp.zip`;
}

export type RunContext = {
  runId: string;
  pass: 1 | 2;
  /** True when no scheduler-side run started this Playwright process. */
  manual: boolean;
};

export const MANUAL_RUN: RunContext = { runId: MANUAL_RUN_ID, pass: 1, manual: true };

export type RunLayout = {
  runId: string;
  pass: 1 | 2;
  /** <root>/artifacts */
  artifactsDir: string;
  /** <root>/artifacts/runs/<run id> */
  runDir: string;
  /** <runDir>/pass-<pass> */
  passDir: string;
  /** Playwright's outputDir for the pass. */
  outputDir: string;
  /** Output folder of the html report for the pass. */
  htmlDir: string;
  /** <runDir>/pass-<pass>.json */
  passFile: string;
  /** <runDir>/pass-<pass>.stderr.log */
  stderrLog: string;
  /** <runDir>/cli-error.log */
  cliErrorLog: string;
  /** <artifactsDir>/metrics.csv */
  metricsCsv: string;
  /** <artifactsDir>/runs.csv */
  runsCsv: string;
  /** <artifactsDir>/summary.json */
  summaryJson: string;
  /** <artifactsDir>/report.txt */
  reportTxt: string;
  /** <artifactsDir>/report_<run id>.zip */
  reportZip: string;
};

const RUN_FIX = 'Unset both for a manual run, or start the run with blw run';

/**
 * Reads the run id and the pass from BLW_RUN_ID and BLW_PASS. Both unset (or empty) is the manual
 * run; anything else must be a well-formed pair, because the run id becomes a directory name.
 */
export function readRunContext(env: NodeJS.ProcessEnv): RunContext {
  const runId = env.BLW_RUN_ID;
  const pass = env.BLW_PASS;
  const runIdSet = runId !== undefined && runId !== '';
  const passSet = pass !== undefined && pass !== '';
  if (!runIdSet && !passSet) {
    return MANUAL_RUN;
  }
  if (!runIdSet || !passSet) {
    throw new ConfigError('BLW_RUN_ID', 'BLW_RUN_ID and BLW_PASS must be set together', RUN_FIX);
  }
  // A whitelist: the run id becomes a directory name, so separators and dot segments cannot pass.
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ConfigError('BLW_RUN_ID', 'must be a UTC run id such as 20261020T123456Z', RUN_FIX);
  }
  if (pass !== '1' && pass !== '2') {
    throw new ConfigError('BLW_PASS', 'must be 1 or 2', RUN_FIX);
  }
  return { runId, pass: pass === '1' ? 1 : 2, manual: false };
}

/** The run id of a moment: UTC, compact, whole seconds. */
export function runIdFrom(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
}

/**
 * The file next to a pass file where the data reporter says that its metrics.csv rows were not
 * appended: <runDir>/pass-<n>.json -> <runDir>/pass-<n>.history-error.log. Pure.
 */
export function historyErrorLogFor(passFile: string): string {
  const base = path.basename(passFile, '.json');
  return path.join(path.dirname(passFile), `${base}.history-error.log`);
}

/** Pure path computation: nothing is created or read. */
export function runLayout(rootDir: string, run: RunContext): RunLayout {
  const artifactsDir = path.join(rootDir, 'artifacts');
  const runDir = path.join(artifactsDir, 'runs', run.runId);
  const passDir = path.join(runDir, `pass-${run.pass}`);
  return {
    runId: run.runId,
    pass: run.pass,
    artifactsDir,
    runDir,
    passDir,
    outputDir: path.join(passDir, 'test-results'),
    htmlDir: path.join(passDir, 'html'),
    passFile: path.join(runDir, `pass-${run.pass}.json`),
    stderrLog: path.join(runDir, `pass-${run.pass}.stderr.log`),
    cliErrorLog: path.join(runDir, 'cli-error.log'),
    metricsCsv: path.join(artifactsDir, 'metrics.csv'),
    runsCsv: path.join(artifactsDir, 'runs.csv'),
    summaryJson: path.join(artifactsDir, 'summary.json'),
    reportTxt: path.join(artifactsDir, 'report.txt'),
    reportZip: path.join(artifactsDir, reportZipName(run.runId)),
  };
}
