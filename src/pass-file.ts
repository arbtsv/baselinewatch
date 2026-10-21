// The pass file: the one-way data contract between the Playwright run and the command line.
// It builds the file, writes it so that a reader never sees half of it, and reads it back with full
// validation. Only node:fs and node:path are used; nothing here imports Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { isRecord, metricRecordOf } from './classify.ts';
import { MAX_NAME_LENGTH, METRIC_PATTERN, nameProblem } from './names.ts';
import {
  ERROR_CATEGORIES,
  PROJECT_CLASSES,
  SCHEMA_VERSION,
  type ErrorCategory,
  type MetricRef,
  type PassFile,
  type PassProject,
  type ProjectClass,
} from './protocol.ts';

/** What a reader expects of the file it opens. */
export type PassExpectation = {
  runId: string;
  pass: 1 | 2;
  /** The project ids this run may contain. */
  projects: readonly string[];
  /** True when every one of the projects must be present (pass 1). */
  requireAll: boolean;
};

export type PassRead = { state: 'ok'; file: PassFile } | { state: 'missing' } | { state: 'invalid' };

type Gaps = { not_measured: MetricRef[]; unused_baselines: MetricRef[] };

/** Builds the file content for one pass. */
export function buildPassFile(input: {
  runId: string;
  pass: 1 | 2;
  startedAt: Date;
  finishedAt: Date;
  projects: PassProject[];
  gaps?: Gaps;
}): PassFile {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: input.runId,
    pass: input.pass,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    projects: input.projects,
    not_measured: input.gaps?.not_measured ?? [],
    unused_baselines: input.gaps?.unused_baselines ?? [],
  };
}

/** The text of the file: JSON with two-space indentation and a final newline. */
export function passFileText(file: PassFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/** Writes through a temp file in the same directory and renames it over the target. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// A scenario or node name as read from disk: the same rule env.json obeys, Windows device names included.
function isName(value: unknown): value is string {
  return typeof value === 'string' && nameProblem('scenario', value) === undefined;
}

function isMetricName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && METRIC_PATTERN.test(value);
}

// ISO 8601 in UTC, as toISOString writes it.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

// A project must agree with itself: class error exactly when an error category is recorded, class ok
// only without a slow metric, class slow only with at least one. Anything else is a damaged file.
function projectOf(value: unknown): PassProject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { project, scenario, node, metrics, error_category } = value;
  if (!isName(scenario) || !isName(node) || project !== `${scenario}--${node}`) {
    return undefined;
  }
  const projectClass = value.class;
  if (!PROJECT_CLASSES.includes(projectClass as ProjectClass)) {
    return undefined;
  }
  if (error_category !== null && !ERROR_CATEGORIES.includes(error_category as ErrorCategory)) {
    return undefined;
  }
  if (!Array.isArray(metrics)) {
    return undefined;
  }
  const checked: PassProject['metrics'] = [];
  for (const entry of metrics) {
    const metric = metricRecordOf(entry);
    if (metric === undefined) {
      return undefined;
    }
    checked.push(metric);
  }
  if ((projectClass === 'error') !== (error_category !== null)) {
    return undefined;
  }
  const anySlow = checked.some((metric) => metric.verdict === 'slow');
  if ((projectClass === 'ok' && anySlow) || (projectClass === 'slow' && !anySlow)) {
    return undefined;
  }
  return {
    project,
    scenario,
    node,
    class: projectClass as ProjectClass,
    metrics: checked,
    error_category: error_category as ErrorCategory | null,
  };
}

function refsOf(value: unknown): MetricRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs: MetricRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const { scenario, node, metric } = entry;
    if (!isName(scenario) || !isName(node) || !isMetricName(metric)) {
      return undefined;
    }
    refs.push({ scenario, node, metric });
  }
  return refs;
}

// No duplicates, nothing outside the allowed list and, when asked, every allowed project present.
function projectsMatch(projects: readonly PassProject[], expect: PassExpectation): boolean {
  const seen = new Set<string>();
  for (const { project } of projects) {
    if (seen.has(project) || !expect.projects.includes(project)) {
      return false;
    }
    seen.add(project);
  }
  return !expect.requireAll || expect.projects.every((project) => seen.has(project));
}

/** Checks a parsed value against the expectation; the result is a clean copy, or undefined. */
export function validatePassFile(value: unknown, expect: PassExpectation): PassFile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.schema_version !== SCHEMA_VERSION || value.run_id !== expect.runId || value.pass !== expect.pass) {
    return undefined;
  }
  const { started_at, finished_at } = value;
  if (!isIsoUtc(started_at) || !isIsoUtc(finished_at)) {
    return undefined;
  }
  if (!Array.isArray(value.projects)) {
    return undefined;
  }
  const projects: PassProject[] = [];
  for (const entry of value.projects) {
    const project = projectOf(entry);
    if (project === undefined) {
      return undefined;
    }
    projects.push(project);
  }
  if (!projectsMatch(projects, expect)) {
    return undefined;
  }
  const notMeasured = refsOf(value.not_measured);
  const unusedBaselines = refsOf(value.unused_baselines);
  if (notMeasured === undefined || unusedBaselines === undefined) {
    return undefined;
  }
  return {
    schema_version: SCHEMA_VERSION,
    run_id: expect.runId,
    pass: expect.pass,
    started_at,
    finished_at,
    projects,
    not_measured: notMeasured,
    unused_baselines: unusedBaselines,
  };
}

/** Reads and validates a pass file. It never throws: a problem is the state missing or invalid. */
export function readPassFile(file: string, expect: PassExpectation): PassRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  const checked = validatePassFile(parsed, expect);
  return checked === undefined ? { state: 'invalid' } : { state: 'ok', file: checked };
}
