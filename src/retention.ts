// Retention: deletes old run directories and report zips by the run id in their names, never by file
// times, and touches nothing else. This module uses node:fs and node:path only and loads no
// Playwright module.
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_ZIP_PATTERN, RUN_ID_PATTERN, runIdFrom, TEMP_ZIP_PATTERN } from './layout.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The newest runs, the current one among them, that are never removed whatever their age. Retention
 * trusts the clock: a clock that jumps forward (a resumed virtual machine, a bad time sync) by more than
 * retention_days would make every earlier run old at once, and the evidence of the latest failures
 * would go with them.
 */
export const KEEP_NEWEST_RUNS = 3;
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
 * is not `keep`, and not among the KEEP_NEWEST_RUNS newest runs (`keep` counts as the newest). Only a
 * real directory or a regular file qualifies: a link or junction is never followed and never removed.
 * Each removal is tried once; one that fails is counted and the rest go on. 0 days (or anything that
 * is not a positive number) removes nothing.
 */
export function applyRetention(options: {
  artifactsDir: string;
  startedAt: Date;
  days: number;
  keep: string;
  /** How many of the newest runs are kept whatever their age, `keep` among them; KEEP_NEWEST_RUNS by default. */
  keepNewest?: number;
  remove?: (target: string) => void;
}): { removed: number; failed: number } {
  const result = { removed: 0, failed: 0 };
  if (!(options.days > 0)) {
    return result;
  }
  const cutoff = retentionCutoff(options.startedAt, options.days).getTime();
  const remove = options.remove ?? removeRecursively;
  const runsDir = path.join(options.artifactsDir, 'runs');
  const runDirs = listEntries(runsDir).filter((entry) => entry.isDirectory());
  const zips = listEntries(options.artifactsDir)
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const runId = (REPORT_ZIP_PATTERN.exec(entry.name) ?? TEMP_ZIP_PATTERN.exec(entry.name))?.[1];
      return runId === undefined ? [] : [{ name: entry.name, runId }];
    });
  // The newest runs, by the moment their ids spell, whether they left a directory, a zip or both.
  const newest = [...new Set([...runDirs.map((entry) => entry.name), ...zips.map((zip) => zip.runId)])]
    .filter((runId) => runId !== options.keep && parseRunId(runId) !== undefined)
    .sort((a, b) => (parseRunId(b) as Date).getTime() - (parseRunId(a) as Date).getTime())
    .slice(0, Math.max(0, (options.keepNewest ?? KEEP_NEWEST_RUNS) - 1));
  const protectedIds = new Set([options.keep, ...newest]);
  const isOld = (runId: string | undefined): boolean => {
    const moment = runId === undefined ? undefined : parseRunId(runId);
    return runId !== undefined && !protectedIds.has(runId) && moment !== undefined && moment.getTime() < cutoff;
  };
  const doomed: string[] = [];
  for (const entry of runDirs) {
    if (isOld(entry.name)) {
      doomed.push(path.join(runsDir, entry.name));
    }
  }
  for (const zip of zips) {
    if (isOld(zip.runId)) {
      doomed.push(path.join(options.artifactsDir, zip.name));
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
