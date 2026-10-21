// The outcome table of a run. The command line decides only from the pass files: the verdict comes
// from pass 1 alone, pass 2 only says what became of the slow projects. Everything here is pure; it
// reads no file, prints nothing and loads no Playwright module.
import type { Locale } from './env.ts';
import type { PassRead } from './pass-file.ts';
import {
  EXIT_CODES,
  REASON_LINE_PREFIX,
  RESULT_LINE_PREFIX,
  SCHEMA_VERSION,
  type MetricRef,
  type NotReadyReason,
  type PassFile,
  type PassProject,
  type Reason,
  type Recheck,
  type ResultToken,
  type RunStatus,
  type RunWarning,
  type Summary,
  type SummaryNode,
} from './protocol.ts';

/** Everything a run decides, before the run id, the version and the clock are added. */
export type Decision = {
  status: RunStatus;
  result: ResultToken;
  exit_code: 0 | 1 | 3;
  reason: Reason | null;
  nodes: SummaryNode[];
  not_measured: MetricRef[];
  unused_baselines: MetricRef[];
  warnings: RunWarning[];
};

/** What the file module cannot know: who ran, with which version, when and in which language. */
export type SummaryMeta = { runId: string; coreVersion: string; locale: Locale; startedAt: Date; finishedAt: Date };

/**
 * The projects pass 2 may repeat: those pass 1 classified slow and env.json configures, each once,
 * in the order of `configured`. A project that is not configured is dropped, so a damaged pass file
 * can never put a foreign name on the command line; an error project is never repeated.
 */
export function slowProjects(pass1: PassFile, configured: readonly string[]): string[] {
  const slow = new Set(pass1.projects.filter((project) => project.class === 'slow').map((project) => project.project));
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const name of configured) {
    if (slow.has(name) && !seen.has(name)) {
      seen.add(name);
      wanted.push(name);
    }
  }
  return wanted;
}

function recheckOf(project: PassProject | undefined): Recheck {
  switch (project?.class) {
    case 'ok':
      return 'ok';
    case 'slow':
      return 'still_slow';
    default:
      return 'error';
  }
}

// The verdict of pass 1: an error beats a slow project, a slow project beats a clean run.
function reasonOf(projects: readonly PassProject[]): 'error' | 'slow' | null {
  if (projects.some((project) => project.class === 'error')) {
    return 'error';
  }
  return projects.some((project) => project.class === 'slow') ? 'slow' : null;
}

function reportNotBuilt(warnings: RunWarning[]): Decision {
  return {
    status: 'fail',
    result: 'FAIL',
    exit_code: EXIT_CODES.fail,
    reason: 'report_not_built',
    nodes: [],
    not_measured: [],
    unused_baselines: [],
    warnings,
  };
}

// What is wrong with pass 2, for the slow projects that were handed to it: a damaged file is one
// warning, a missing file or a project the file lacks is one warning per project.
function passTwoWarnings(pass2: PassRead | undefined, rechecked: readonly PassProject[]): RunWarning[] {
  if (pass2 === undefined || rechecked.length === 0) {
    return [];
  }
  if (pass2.state === 'invalid') {
    return [{ code: 'pass_invalid', pass: 2 }];
  }
  const present = pass2.state === 'ok' ? new Set(pass2.file.projects.map((project) => project.project)) : new Set<string>();
  return rechecked
    .filter((project) => !present.has(project.project))
    .map((project) => ({ code: 'pass_2_not_built', scenario: project.scenario, node: project.node }));
}

/**
 * Turns the two pass reads into the outcome. `requested` lists the projects that were handed to
 * pass 2; a project that pass 1 did not classify slow is ignored there. Without a pass 2 read every
 * recheck is null. A pass 1 that is missing, damaged or empty never gives a pass.
 */
export function decide(input: { pass1: PassRead; pass2?: PassRead; requested: readonly string[] }): Decision {
  const { pass1, pass2, requested } = input;
  if (pass1.state !== 'ok' || pass1.file.projects.length === 0) {
    return reportNotBuilt(pass1.state === 'invalid' ? [{ code: 'pass_invalid', pass: 1 }] : []);
  }
  const first = pass1.file;
  const second = pass2?.state === 'ok' ? new Map(pass2.file.projects.map((project) => [project.project, project])) : undefined;
  const asked = new Set(requested);
  const rechecked = first.projects.filter((project) => project.class === 'slow' && asked.has(project.project));
  const nodes: SummaryNode[] = first.projects.map((project) => ({
    scenario: project.scenario,
    node: project.node,
    class: project.class,
    metrics: project.metrics,
    recheck: pass2 !== undefined && rechecked.includes(project) ? recheckOf(second?.get(project.project)) : null,
  }));
  const reason = reasonOf(first.projects);
  return {
    status: reason === null ? 'pass' : 'fail',
    result: reason === null ? 'PASS' : 'FAIL',
    exit_code: reason === null ? EXIT_CODES.pass : EXIT_CODES.fail,
    reason,
    nodes,
    not_measured: first.not_measured,
    unused_baselines: first.unused_baselines,
    warnings: passTwoWarnings(pass2, rechecked),
  };
}

/** A run that stopped before it measured anything: exit code 3 with the reason it was not ready. */
export function notReady(reason: NotReadyReason): Decision {
  return {
    status: 'not_ready',
    result: 'FAIL',
    exit_code: EXIT_CODES.notReady,
    reason,
    nodes: [],
    not_measured: [],
    unused_baselines: [],
    warnings: [],
  };
}

/** The summary.json content: the decision plus the run's identity and times. */
export function toSummary(decision: Decision, meta: SummaryMeta): Summary {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: meta.runId,
    core_version: meta.coreVersion,
    status: decision.status,
    result: decision.result,
    exit_code: decision.exit_code,
    reason: decision.reason,
    locale: meta.locale,
    started_at: meta.startedAt.toISOString(),
    finished_at: meta.finishedAt.toISOString(),
    nodes: decision.nodes,
    not_measured: decision.not_measured,
    unused_baselines: decision.unused_baselines,
    warnings: decision.warnings,
  };
}

/** The machine lines a scheduler reads: REASON= when there is one, RESULT= always, and last. */
export function exitLines(summary: Pick<Summary, 'result' | 'reason'>): string[] {
  const lines: string[] = [];
  if (summary.reason !== null) {
    lines.push(`${REASON_LINE_PREFIX}${summary.reason}`);
  }
  lines.push(`${RESULT_LINE_PREFIX}${summary.result}`);
  return lines;
}
