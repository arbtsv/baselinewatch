// Tests for src/retention.ts: old run directories and report zips are removed by the run id in their
// names. The file system is a temporary directory; the dates are fixed.
// Run: node --test test/retention.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRetention, KEEP_NEWEST_RUNS, parseRunId, retentionCutoff } from '../src/retention.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-retention-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const STARTED = new Date('2026-10-20T10:00:00.000Z');
const CURRENT = '20261020T100000Z';
const DAY = 24 * 60 * 60 * 1000;

let counter = 0;

/** A fresh artifacts directory with a runs directory in it. */
function freshArtifacts(): string {
  counter += 1;
  const dir = path.join(WORK, `artifacts-${counter}`);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}

function makeRunDir(artifactsDir: string, name: string): string {
  const dir = path.join(artifactsDir, 'runs', name);
  fs.mkdirSync(path.join(dir, 'pass-1', 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pass-1.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'pass-1', 'test-results', 'trace.txt'), 'trace');
  return dir;
}

function makeFile(artifactsDir: string, ...parts: string[]): string {
  const file = path.join(artifactsDir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
}

const exists = (target: string): boolean => fs.existsSync(target);

describe('parseRunId', () => {
  test('a run id is the UTC moment it spells', () => {
    assert.equal(parseRunId('20261020T100000Z')?.toISOString(), '2026-10-20T10:00:00.000Z');
    assert.equal(parseRunId('20240229T235959Z')?.toISOString(), '2024-02-29T23:59:59.000Z');
  });

  test('anything that is not a possible moment is undefined', () => {
    for (const name of ['20261340T250000Z', '20260230T100000Z', '20261020T100060Z', 'manual', '20261020T100000Z.zip', '', 'notes.txt']) {
      assert.equal(parseRunId(name), undefined, name);
    }
  });
});

describe('retentionCutoff', () => {
  test('the cutoff is the start minus whole days', () => {
    assert.equal(retentionCutoff(STARTED, 1).toISOString(), '2026-10-19T10:00:00.000Z');
    assert.equal(retentionCutoff(STARTED, 30).getTime(), STARTED.getTime() - 30 * DAY);
    assert.equal(retentionCutoff(STARTED, 0).getTime(), STARTED.getTime());
  });
});

describe('applyRetention', () => {
  test('old run directories and zips go, everything else stays', () => {
    const dir = freshArtifacts();
    const old = makeRunDir(dir, '20261018T100000Z');
    const oldZip = makeFile(dir, 'report_20261018T100000Z.zip');
    const oldTemp = makeFile(dir, '.report_20261018T100000Z.77.tmp.zip');
    const kept = [
      makeRunDir(dir, '20261019T110000Z'),
      makeFile(dir, 'report_20261019T110000Z.zip'),
      makeRunDir(dir, 'manual'),
      makeFile(dir, 'runs', 'notes.txt'),
      makeRunDir(dir, '20261340T250000Z'),
      makeFile(dir, 'runs', '20261001T000000Z'),
      makeFile(dir, 'metrics.csv'),
      makeFile(dir, 'runs.csv'),
      makeFile(dir, 'report.txt'),
      makeFile(dir, 'summary.json'),
      makeFile(dir, 'cli-error.log'),
      makeFile(dir, 'report_20261001T000000Z.zip.part'),
      makeFile(dir, '.report_20261001T000000Z.tmp.zip'),
      makeFile(dir, 'report_manual.zip'),
      makeRunDir(dir, CURRENT),
    ];
    fs.mkdirSync(path.join(dir, 'report_20261001T000000Z.zip'));
    kept.push(path.join(dir, 'report_20261001T000000Z.zip'));
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(result, { removed: 3, failed: 0 });
    for (const gone of [old, oldZip, oldTemp]) {
      assert.equal(exists(gone), false, gone);
    }
    for (const stays of kept) {
      assert.equal(exists(stays), true, stays);
    }
  });

  test('an entry exactly at the cutoff stays and one second older goes', () => {
    const dir = freshArtifacts();
    const atCutoff = makeRunDir(dir, '20261019T100000Z');
    const older = makeRunDir(dir, '20261019T095959Z');
    const zipAtCutoff = makeFile(dir, 'report_20261019T100000Z.zip');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal(exists(atCutoff), true);
    assert.equal(exists(zipAtCutoff), true);
    assert.equal(exists(older), false);
  });

  test('the run that is kept by name stays even when it is older than the cutoff', () => {
    const dir = freshArtifacts();
    const protectedRun = makeRunDir(dir, '20261001T000000Z');
    const protectedZip = makeFile(dir, 'report_20261001T000000Z.zip');
    const other = makeRunDir(dir, '20261002T000000Z');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: '20261001T000000Z' });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal(exists(protectedRun), true);
    assert.equal(exists(protectedZip), true);
    assert.equal(exists(other), false);
  });

  test('a run id from the future is not old', () => {
    const dir = freshArtifacts();
    const future = makeRunDir(dir, '20271020T100000Z');
    assert.deepEqual(applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT }), { removed: 0, failed: 0 });
    assert.equal(exists(future), true);
  });

  test('0 days keeps everything and never calls remove', () => {
    const dir = freshArtifacts();
    const old = makeRunDir(dir, '20200101T000000Z');
    const oldZip = makeFile(dir, 'report_20200101T000000Z.zip');
    const calls: string[] = [];
    const result = applyRetention({
      keepNewest: 1,
      artifactsDir: dir,
      startedAt: STARTED,
      days: 0,
      keep: CURRENT,
      remove: (target) => {
        calls.push(target);
      },
    });
    assert.deepEqual(result, { removed: 0, failed: 0 });
    assert.deepEqual(calls, []);
    assert.equal(exists(old), true);
    assert.equal(exists(oldZip), true);
  });

  test('a missing runs directory, or a missing artifacts directory, is no error', () => {
    const noRuns = path.join(WORK, 'only-zips');
    fs.mkdirSync(noRuns, { recursive: true });
    const oldZip = makeFile(noRuns, 'report_20200101T000000Z.zip');
    assert.deepEqual(applyRetention({ artifactsDir: noRuns, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT }), { removed: 1, failed: 0 });
    assert.equal(exists(oldZip), false);
    const nothing = path.join(WORK, 'does-not-exist');
    assert.deepEqual(applyRetention({ artifactsDir: nothing, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT }), { removed: 0, failed: 0 });
    assert.equal(exists(nothing), false);
  });

  test('a removal that throws is counted, tried once and does not stop the others', () => {
    const dir = freshArtifacts();
    const stuck = makeRunDir(dir, '20261001T000000Z');
    const goneRun = makeRunDir(dir, '20261002T000000Z');
    const goneZip = makeFile(dir, 'report_20261003T000000Z.zip');
    const tried: string[] = [];
    const result = applyRetention({
      keepNewest: 1,
      artifactsDir: dir,
      startedAt: STARTED,
      days: 1,
      keep: CURRENT,
      remove: (target) => {
        tried.push(target);
        if (target === stuck) {
          throw Object.assign(new Error('held open'), { code: 'EPERM' });
        }
        fs.rmSync(target, { recursive: true, force: true });
      },
    });
    assert.deepEqual(result, { removed: 2, failed: 1 });
    assert.equal(tried.filter((target) => target === stuck).length, 1);
    assert.equal(exists(stuck), true);
    assert.equal(exists(goneRun), false);
    assert.equal(exists(goneZip), false);
  });

  test('a junction or symlink with a run id name is neither followed nor removed', () => {
    const dir = freshArtifacts();
    const outside = path.join(WORK, `outside-${counter}`);
    fs.mkdirSync(outside, { recursive: true });
    const precious = path.join(outside, 'precious.txt');
    fs.writeFileSync(precious, 'keep me');
    const link = path.join(dir, 'runs', '20261001T000000Z');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(result, { removed: 0, failed: 0 });
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(precious, 'utf8'), 'keep me');
  });

  test('a junction inside an old run directory is not followed when the run directory goes', () => {
    const dir = freshArtifacts();
    const outside = path.join(WORK, `outside-nested-${counter}`);
    fs.mkdirSync(outside, { recursive: true });
    const precious = path.join(outside, 'precious.txt');
    fs.writeFileSync(precious, 'keep me');
    const old = makeRunDir(dir, '20261001T000000Z');
    fs.symlinkSync(outside, path.join(old, 'pass-1', 'test-results', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal(exists(old), false);
    assert.equal(fs.readFileSync(precious, 'utf8'), 'keep me');
  });

  test('the age comes from the name, not from the file times', () => {
    const dir = freshArtifacts();
    const recentName = makeRunDir(dir, '20261020T090000Z');
    const oldName = makeRunDir(dir, '20200101T000000Z');
    const longAgo = new Date('2001-01-01T00:00:00Z');
    const justNow = new Date();
    fs.utimesSync(recentName, longAgo, longAgo);
    fs.utimesSync(oldName, justNow, justNow);
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 1, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    assert.equal(exists(recentName), true);
    assert.equal(exists(oldName), false);
  });
});

describe('the newest runs are never removed', () => {
  const oldIds = ['20240101T000000Z', '20240102T000000Z', '20240103T000000Z', '20240104T000000Z', '20240105T000000Z'];

  test('by default the current run and the two newest before it stay, however old they are', () => {
    assert.equal(KEEP_NEWEST_RUNS, 3);
    const dir = freshArtifacts();
    const runs = oldIds.map((id) => makeRunDir(dir, id));
    const zips = oldIds.map((id) => makeFile(dir, `report_${id}.zip`));
    const current = makeRunDir(dir, CURRENT);
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 30, keep: CURRENT });
    assert.deepEqual(result, { removed: 6, failed: 0 });
    for (const index of [0, 1, 2]) {
      assert.equal(exists(runs[index] as string), false, oldIds[index]);
      assert.equal(exists(zips[index] as string), false, oldIds[index]);
    }
    for (const index of [3, 4]) {
      assert.equal(exists(runs[index] as string), true, oldIds[index]);
      assert.equal(exists(zips[index] as string), true, oldIds[index]);
    }
    assert.equal(exists(current), true);
  });

  test('a clock that jumped two years forward leaves the latest runs and the history', () => {
    const dir = freshArtifacts();
    const runs = oldIds.map((id) => makeRunDir(dir, id));
    const history = makeFile(dir, 'runs.csv');
    const jumped = new Date('2028-10-20T10:00:00.000Z');
    const result = applyRetention({ artifactsDir: dir, startedAt: jumped, days: 30, keep: '20281020T100000Z' });
    assert.deepEqual(result, { removed: 3, failed: 0 });
    assert.equal(exists(runs[4] as string), true);
    assert.equal(exists(runs[3] as string), true);
    assert.equal(exists(runs[0] as string), false);
    assert.equal(exists(history), true);
  });

  test('a run that left only a zip counts as a run, and a run with a directory and a zip counts once', () => {
    const dir = freshArtifacts();
    const zipOnly = makeFile(dir, 'report_20240105T000000Z.zip');
    const both = makeRunDir(dir, '20240104T000000Z');
    const bothZip = makeFile(dir, 'report_20240104T000000Z.zip');
    const third = makeRunDir(dir, '20240103T000000Z');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 30, keep: CURRENT });
    assert.deepEqual(result, { removed: 1, failed: 0 });
    for (const stays of [zipOnly, both, bothZip]) {
      assert.equal(exists(stays), true, stays);
    }
    assert.equal(exists(third), false);
  });

  test('names that are not run ids do not take a place among the newest', () => {
    const dir = freshArtifacts();
    makeRunDir(dir, 'manual');
    makeRunDir(dir, '20261340T250000Z');
    const old = makeRunDir(dir, '20240101T000000Z');
    const result = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 30, keepNewest: 2, keep: CURRENT });
    assert.deepEqual(result, { removed: 0, failed: 0 });
    assert.equal(exists(old), true);
    const none = applyRetention({ artifactsDir: dir, startedAt: STARTED, days: 30, keepNewest: 1, keep: CURRENT });
    assert.deepEqual(none, { removed: 1, failed: 0 });
    assert.equal(exists(old), false);
  });
});
