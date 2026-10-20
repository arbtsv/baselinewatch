// Bookkeeping that the reporters of a pass share: which projects the pass is expected to cover, which
// tests were announced when it began, the last result of each test and what the pure classification
// makes of them. Playwright types are imported as types only, so this module stays cheap to load and
// the unit tests drive it with plain objects.
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { classifyProject, metricsFromAnnotations, type TestOutcome } from '../classify.ts';
import type { MetricRecord, PassProject } from '../protocol.ts';

/** One measured metric of one finished test, with the scenario and node it belongs to. */
export type MetricRow = { scenario: string; node: string; ts: string; metric: MetricRecord };

type ExpectedProject = { project: string; scenario: string; node: string };
type SeededTest = { project: string; result: TestResult | undefined };

const NAME_SEPARATOR = '--';

// Scenario and node of a project: from its metadata, else from the "<scenario>--<node>" name.
function expectedOf(project: FullConfig['projects'][number]): ExpectedProject {
  const metadata: Record<string, unknown> = project.metadata ?? {};
  const { scenario, node } = metadata;
  if (typeof scenario === 'string' && typeof node === 'string') {
    return { project: project.name, scenario, node };
  }
  const cut = project.name.indexOf(NAME_SEPARATOR);
  if (cut < 0) {
    return { project: project.name, scenario: project.name, node: '' };
  }
  return {
    project: project.name,
    scenario: project.name.slice(0, cut),
    node: project.name.slice(cut + NAME_SEPARATOR.length),
  };
}

function projectNameOf(test: TestCase): string | undefined {
  return test.parent.project()?.name;
}

function outcomeOf(seeded: SeededTest): TestOutcome {
  const { result } = seeded;
  if (result === undefined) {
    return { finished: false, status: undefined, errors: [], annotations: [] };
  }
  return {
    finished: true,
    status: result.status,
    errors: result.errors.map((error) => error.message ?? error.value ?? ''),
    annotations: result.annotations,
  };
}

export class ResultCollector {
  private expected: ExpectedProject[] = [];
  // A Map keeps the order in which the tests were announced.
  private readonly tests = new Map<string, SeededTest>();

  /**
   * Pass 1 expects every project of the configuration, so a project without any test cannot vanish
   * from the report. Pass 2 expects only the projects that have tests in the suite, because the
   * command line filters the pass to the slow projects. Every announced test is seeded without a
   * result: one that never reaches its end (a global timeout) stays unfinished.
   */
  begin(config: FullConfig, suite: Suite, pass: 1 | 2): void {
    this.tests.clear();
    const announced = suite.allTests();
    const present = new Set<string>();
    for (const test of announced) {
      const name = projectNameOf(test);
      if (name === undefined) {
        continue;
      }
      present.add(name);
      this.tests.set(test.id, { project: name, result: undefined });
    }
    this.expected = config.projects
      .filter((project) => pass === 1 || present.has(project.name))
      .map(expectedOf);
  }

  /** Keeps the last result of a test: a retry replaces the earlier attempt. */
  record(test: TestCase, result: TestResult): void {
    const known = this.tests.get(test.id);
    const project = known?.project ?? projectNameOf(test);
    if (project === undefined) {
      return;
    }
    this.tests.set(test.id, { project, result });
  }

  /** One classified project per expected project, in configuration order. */
  projects(runStatus: FullResult['status']): PassProject[] {
    return this.expected.map((expected) =>
      classifyProject({
        project: expected.project,
        scenario: expected.scenario,
        node: expected.node,
        tests: this.testsOf(expected.project).map(outcomeOf),
        runTimedOut: runStatus === 'timedout',
      }),
    );
  }

  /**
   * Every metric of every finished test, project by project in configuration order and in the order
   * the test measured them. A project that ended in error still contributes what it measured.
   */
  metricRows(): MetricRow[] {
    const rows: MetricRow[] = [];
    for (const expected of this.expected) {
      for (const seeded of this.testsOf(expected.project)) {
        const { result } = seeded;
        if (result === undefined) {
          continue;
        }
        const ts = result.startTime.toISOString();
        for (const metric of metricsFromAnnotations(result.annotations)) {
          rows.push({ scenario: expected.scenario, node: expected.node, ts, metric });
        }
      }
    }
    return rows;
  }

  private testsOf(project: string): SeededTest[] {
    return [...this.tests.values()].filter((seeded) => seeded.project === project);
  }
}
