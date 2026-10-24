// Retention: deletes old run directories and report zips by the run id in their names, never by file
// times, and touches nothing else. This module uses node:fs and node:path only and loads no
// Playwright module.
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_ZIP_PATTERN, RUN_ID_PATTERN, runIdFrom, TEMP_ZIP_PATTERN } from './layout.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_ID_PARTS = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * The moment a run id spells, or undefined when the name is not a run id or spells a moment that does
 * not exist (month 13, February 30, second 60): the date is built and written back, and it must come
 * out as the same name.
 */
export function parseRunId(name: string): Date | undefined {
  const parts = RUN_ID_PARTS.exec(name);
  if (parts === null || !RUN_ID_PATTERN.test(name)) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) || runIdFrom(date) !== name ? undefined : date;
}

/** The moment before which a run is old: the start of this run minus the retention in whole days. */
export function retentionCutoff(startedAt: Date, days: number): Date {
  return new Date(startedAt.getTime() - days * DAY_MS);
}

function removeRecursively(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function listEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Removes artifacts/runs/<run id> directories, report_<run id>.zip files and temporary
 * .report_<run id>.<pid>.tmp.zip files of artifacts whose run id is strictly older than the cutoff and
 * is not `keep`. Only a real directory or a regular file qualifies: a link or junction is never
 * followed and never removed. Each removal is tried once; one that fails is counted and the rest go
 * on. 0 days (or anything that is not a positive number) removes nothing.
 */
export function applyRetention(options: {
  artifactsDir: string;
  startedAt: Date;
  days: number;
  keep: string;
  remove?: (target: string) => void;
}): { removed: number; failed: number } {
  const result = { removed: 0, failed: 0 };
  if (!(options.days > 0)) {
    return result;
  }
  const cutoff = retentionCutoff(options.startedAt, options.days).getTime();
  const remove = options.remove ?? removeRecursively;
  const isOld = (runId: string | undefined): boolean => {
    const moment = runId === undefined ? undefined : parseRunId(runId);
    return runId !== options.keep && moment !== undefined && moment.getTime() < cutoff;
  };
  const doomed: string[] = [];
  const runsDir = path.join(options.artifactsDir, 'runs');
  for (const entry of listEntries(runsDir)) {
    if (entry.isDirectory() && isOld(entry.name)) {
      doomed.push(path.join(runsDir, entry.name));
    }
  }
  for (const entry of listEntries(options.artifactsDir)) {
    if (!entry.isFile()) {
      continue;
    }
    const runId = (REPORT_ZIP_PATTERN.exec(entry.name) ?? TEMP_ZIP_PATTERN.exec(entry.name))?.[1];
    if (isOld(runId)) {
      doomed.push(path.join(options.artifactsDir, entry.name));
    }
  }
  for (const target of doomed) {
    try {
      remove(target);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
