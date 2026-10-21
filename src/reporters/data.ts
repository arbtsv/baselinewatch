// The Playwright reporter that turns a pass into data: it writes pass-N.json when the pass ends. It
// is the only writer of that file. It decides nothing itself; the pure modules classify the tests
// and build the file. The metrics.csv history is best effort: when its append fails, the pass file
// stays and pass-N.history-error.log next to it says so for the command line. Playwright loads this file by path and constructs the default export with the
// options object that the configuration registered.
import fs from 'node:fs';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { Baselines } from '../baselines.ts';
import { metricGaps } from '../classify.ts';
import { METRICS_CSV_HEADER, appendCsv, metricsCsvLines } from '../csv.ts';
import { historyErrorLogFor } from '../layout.ts';
import { buildPassFile, passFileText, writeFileAtomic } from '../pass-file.ts';
import { ResultCollector } from './collect.ts';

export type DataReporterOptions = {
  runId: string;
  pass: 1 | 2;
  /** True for a run nobody started with blw run; it leaves the CSV history alone. */
  manual: boolean;
  /** Absolute path of pass-N.json. */
  passFile: string;
  /** Absolute path of metrics.csv. */
  metricsCsv: string;
  baselines: Baselines;
};

export default class DataReporter implements Reporter {
  private readonly options: DataReporterOptions;
  private readonly collector = new ResultCollector();
  private startedAt = new Date();

  constructor(options: DataReporterOptions) {
    this.options = options;
  }

  // The console reporter is the one that prints; this one stays silent.
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.startedAt = new Date();
    this.collector.begin(config, suite, this.options.pass);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.collector.record(test, result);
  }

  onEnd(result: FullResult): void {
    const { runId, pass, passFile, baselines } = this.options;
    const projects = this.collector.projects(result.status);
    // The gap lists describe the whole configuration, so only the first pass computes them.
    const gaps = pass === 1 ? metricGaps(projects, baselines) : undefined;
    const file = buildPassFile({ runId, pass, startedAt: this.startedAt, finishedAt: new Date(), projects, gaps });
    writeFileAtomic(passFile, passFileText(file));
    // A manual run leaves the history alone: its rows would mix hand-started runs into the record
    // of scheduled ones.
    if (!this.options.manual) {
      try {
        appendCsv(this.options.metricsCsv, METRICS_CSV_HEADER, metricsCsvLines(runId, pass, this.collector.metricRows()));
      } catch (error) {
        this.reportHistoryFailure(error);
      }
    }
  }

  // The pass file is the record and is already written, so a failed append must not fail the pass.
  // The command line reads nothing else of this process, so the failure goes to a small file next to
  // the pass file: the file name and the error code, never the message.
  private reportHistoryFailure(error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    try {
      fs.writeFileSync(historyErrorLogFor(this.options.passFile), `metrics.csv: ${typeof code === 'string' && code !== '' ? code : 'unknown'}\n`, 'utf8');
    } catch {
      // Nothing more can be done; the pass file and the verdict stand.
    }
  }
}
