// Where one run keeps its files. For now every run is the manual run and its only pass is pass 1;
// a later phase replaces these two constants with the run id and the pass number of the scheduler.
import path from 'node:path';

export const MANUAL_RUN_ID = 'manual' as const;
const FIRST_PASS = 1;

export type RunLayout = {
  runId: string;
  pass: number;
  /** <root>/artifacts/runs/<run id> */
  runDir: string;
  /** <runDir>/pass-<pass> */
  passDir: string;
  /** Playwright's outputDir for the pass. */
  outputDir: string;
  /** Output folder of the html report for the pass. */
  htmlDir: string;
};

/** Pure path computation: nothing is created or read. */
export function runLayout(rootDir: string): RunLayout {
  const runId: string = MANUAL_RUN_ID;
  const pass = FIRST_PASS;
  const runDir = path.join(rootDir, 'artifacts', 'runs', runId);
  const passDir = path.join(runDir, `pass-${pass}`);
  return {
    runId,
    pass,
    runDir,
    passDir,
    outputDir: path.join(passDir, 'test-results'),
    htmlDir: path.join(passDir, 'html'),
  };
}
