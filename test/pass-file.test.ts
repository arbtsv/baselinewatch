// Tests for src/pass-file.ts.
// Run: node --test test/pass-file.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPassFile,
  passFileText,
  readPassFile,
  validatePassFile,
  writeFileAtomic,
  type PassExpectation,
} from '../src/pass-file.ts';
import type { PassFile, PassProject } from '../src/protocol.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-pass-file-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const RUN_ID = '20261020T101500Z-ab12';
const EXPECT: PassExpectation = { runId: RUN_ID, pass: 1, projects: ['demo--node-1'], requireAll: true };

const PROJECT: PassProject = {
  project: 'demo--node-1',
  scenario: 'demo',
  node: 'node-1',
  class: 'ok',
  metrics: [{ name: 'login_ms', ms: 1234.5678, reference_ms: 300, maxRatio: 3, ratio: 4.115226, verdict: 'slow' }],
  error_category: null,
};

describe('pass file on disk', () => {
  test('a pass file written atomically reads back equal', () => {
    const built = buildPassFile({
      runId: RUN_ID,
      pass: 1,
      startedAt: new Date('2026-10-20T10:15:00.000Z'),
      finishedAt: new Date('2026-10-20T10:15:42.500Z'),
      projects: [PROJECT],
    });
    const target = path.join(WORK, 'runs', RUN_ID, 'pass-1.json');
    writeFileAtomic(target, passFileText(built));

    const read = readPassFile(target, EXPECT);
    assert.equal(read.state, 'ok');
    assert.deepEqual(read.state === 'ok' ? read.file : undefined, built);
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp')),
      [],
    );
    assert.ok(fs.readFileSync(target, 'utf8').endsWith('}\n'));
  });

  test('an absent file reads as missing', () => {
    assert.deepEqual(readPassFile(path.join(WORK, 'nothing-here.json'), EXPECT), { state: 'missing' });
  });
});

function validFile(): PassFile {
  return buildPassFile({
    runId: RUN_ID,
    pass: 1,
    startedAt: new Date('2026-10-20T10:15:00.000Z'),
    finishedAt: new Date('2026-10-20T10:15:42.500Z'),
    projects: [PROJECT, { ...PROJECT, project: 'demo--node-2', node: 'node-2', metrics: [] }],
    gaps: { not_measured: [], unused_baselines: [{ scenario: 'demo', node: 'node-1', metric: 'history_ms' }] },
  });
}

const BOTH: PassExpectation = { runId: RUN_ID, pass: 1, projects: ['demo--node-1', 'demo--node-2'], requireAll: true };

// Applies a change to a deep copy of a valid file and returns it as untyped data.
function changed(change: (file: Record<string, any>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(validFile()));
  change(copy);
  return copy;
}

describe('validatePassFile', () => {
  test('a complete valid file is accepted', () => {
    assert.deepEqual(validatePassFile(JSON.parse(passFileText(validFile())), BOTH), validFile());
  });

  test('pass 2 may hold a subset of the allowed projects when not every project is required', () => {
    const file = changed((f) => {
      f.pass = 2;
      f.projects = [f.projects[1]];
      f.unused_baselines = [];
    });
    assert.notEqual(validatePassFile(file, { ...BOTH, pass: 2, requireAll: false }), undefined);
  });

  const rejected: [string, (file: Record<string, any>) => void][] = [
    ['schema_version 2', (f) => (f.schema_version = 2)],
    ['a missing schema_version', (f) => delete f.schema_version],
    ['the run id of another run', (f) => (f.run_id = '20260101T000000Z-ffff')],
    ['pass 3', (f) => (f.pass = 3)],
    ['the other pass than expected', (f) => (f.pass = 2)],
    ['a start time that is not ISO 8601 UTC', (f) => (f.started_at = 'yesterday')],
    ['a finish time with a UTC offset', (f) => (f.finished_at = '2026-10-20T10:15:42+03:00')],
    ['a finish time that is not a string', (f) => (f.finished_at = 1)],
    ['the class fast', (f) => (f.projects[0].class = 'fast')],
    ['the category net', (f) => (f.projects[0].error_category = 'net')],
    ['a missing category', (f) => delete f.projects[0].error_category],
    ['a metric with the verdict fast', (f) => (f.projects[0].metrics[0].verdict = 'fast')],
    ['a metric with a negative ms', (f) => (f.projects[0].metrics[0].ms = -5)],
    ['metrics that are not a list', (f) => (f.projects[0].metrics = {})],
    ['projects that are not a list', (f) => (f.projects = {})],
    ['a project that is not an object', (f) => (f.projects[0] = 'demo--node-1')],
    ['a node that does not belong to the project name', (f) => (f.projects[0].node = 'node-2')],
    ['a scenario that does not belong to the project name', (f) => (f.projects[0].scenario = 'other')],
    [
      'a scenario name with capital letters',
      (f) => {
        f.projects[0].scenario = 'Demo';
        f.projects[0].project = 'Demo--node-1';
      },
    ],
    ['the same project twice', (f) => (f.projects[1] = structuredClone(f.projects[0]))],
    [
      'a project outside the allowed list',
      (f) => {
        f.projects[1].project = 'demo--node-3';
        f.projects[1].node = 'node-3';
      },
    ],
    ['a gap list that is not a list', (f) => (f.not_measured = null)],
    ['a gap entry without a metric', (f) => (f.unused_baselines[0] = { scenario: 'demo', node: 'node-1' })],
    ['a gap entry with a metric name that breaks the pattern', (f) => (f.unused_baselines[0].metric = 'History ms')],
    ['a gap entry with a node name that breaks the pattern', (f) => (f.unused_baselines[0].node = 'Node 1')],
    ['a gap entry that is a plain string', (f) => (f.unused_baselines[0] = 'demo--node-1:history_ms')],
  ];
  for (const [title, change] of rejected) {
    test(`${title} is rejected`, () => {
      assert.equal(validatePassFile(changed(change), BOTH), undefined);
    });
  }

  test('a missing configured project is rejected when every project is required', () => {
    const file = changed((f) => f.projects.pop());
    assert.equal(validatePassFile(file, { ...BOTH, requireAll: true }), undefined);
  });

  test('a value that is not an object is rejected', () => {
    for (const value of [null, 'text', 5, [], undefined]) {
      assert.equal(validatePassFile(value, BOTH), undefined);
    }
  });
});

describe('readPassFile with damaged files', () => {
  function write(name: string, text: string): string {
    const file = path.join(WORK, name);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  }

  test('a file that is not JSON reads as invalid', () => {
    assert.deepEqual(readPassFile(write('broken.json', '{ "schema_version": 1, '), BOTH), { state: 'invalid' });
  });

  test('an empty file reads as invalid', () => {
    assert.deepEqual(readPassFile(write('empty.json', ''), BOTH), { state: 'invalid' });
  });

  test('a path that is a directory reads as invalid', () => {
    assert.deepEqual(readPassFile(WORK, BOTH), { state: 'invalid' });
  });

  test('a byte order mark in front of valid JSON is accepted', () => {
    const file = write('bom.json', '﻿' + passFileText(validFile()));
    assert.equal(readPassFile(file, BOTH).state, 'ok');
  });

  test('a valid file for another run reads as invalid', () => {
    const file = write('other-run.json', passFileText(validFile()));
    assert.deepEqual(readPassFile(file, { ...BOTH, runId: '20260101T000000Z-ffff' }), { state: 'invalid' });
  });
});
