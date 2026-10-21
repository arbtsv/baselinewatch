// The Playwright reporter that prints the progress of a pass: one line per project when the pass
// ends. It prints only the class of each project, never an error message or scenario output, so
// nothing a page or a scenario produced can reach the console through it. It reports itself as
// printing, which keeps Playwright from adding its own line reporter. Playwright loads this file by
// path and constructs the default export with the options object that the configuration registered.
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { print } from '../output.ts';
import type { ProjectClass } from '../protocol.ts';
import { ResultCollector } from './collect.ts';

export type ConsoleReporterOptions = {
  pass: 1 | 2;
};

/** The progress line of one project, for example "[pass 1] demo--node-1: ok". */
export function passLine(pass: 1 | 2, project: string, klass: ProjectClass): string {
  return `[pass ${pass}] ${project}: ${klass}`;
}

export default class ConsoleReporter implements Reporter {
  private readonly options: ConsoleReporterOptions;
  private readonly collector = new ResultCollector();

  constructor(options: ConsoleReporterOptions) {
    this.options = options;
  }

  printsToStdio(): boolean {
    return true;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.collector.begin(config, suite, this.options.pass);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.collector.record(test, result);
  }

  onEnd(result: FullResult): void {
    for (const project of this.collector.projects(result.status)) {
      print(passLine(this.options.pass, project.project, project.class));
    }
  }
}
