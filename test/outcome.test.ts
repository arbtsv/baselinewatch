// Tests for src/outcome.ts: the outcome table that turns pass files into status, exit code, reason
// and recheck.
// Run: node --test test/outcome.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, exitLines, notReady, slowProjects, toSummary } from '../src/outcome.ts';
import { FAIL_REASONS, isMachineLine, NOT_READY_REASONS, RESULT_TOKENS } from '../src/protocol.ts';
import { buildPassFile, passFileText, readPassFile, writeFileAtomic, type PassRead } from '../src/pass-file.ts';
import type { PassFile, PassProject } from '../src/protocol.ts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-outcome-'));
after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

const RUN_ID = '20261020T101500Z';
const CONFIGURED = ['demo--node-1', 'demo--node-2'];

function project(node: string, projectClass: PassProject['class']): PassProject {
  return {
    project: `demo--${node}`,
    scenario: 'demo',
    node,
    class: projectClass,
    metrics: [{ name: 'login_ms', ms: 900, reference_ms: 300, maxRatio: 3, ratio: 3, verdict: projectClass === 'slow' ? 'slow' : 'ok' }],
    error_category: projectClass === 'error' ? 'other' : null,
  };
}

describe('outcome from pass files on disk', () => {
  test('a slow node rechecked ok still fails the run', () => {
    const dir = path.join(WORK, 'runs', RUN_ID);
    const started = new Date('2026-10-20T10:15:00.000Z');
    const finished = new Date('2026-10-20T10:15:30.000Z');
    writeFileAtomic(
      path.join(dir, 'pass-1.json'),
      passFileText(
        buildPassFile({
          runId: RUN_ID,
          pass: 1,
          startedAt: started,
          finishedAt: finished,
          projects: [project('node-1', 'slow'), project('node-2', 'ok')],
        }),
      ),
    );
    writeFileAtomic(
      path.join(dir, 'pass-2.json'),
      passFileText(
        buildPassFile({
          runId: RUN_ID,
          pass: 2,
          startedAt: finished,
          finishedAt: new Date('2026-10-20T10:15:40.000Z'),
          projects: [project('node-1', 'ok')],
        }),
      ),
    );

    const pass1 = readPassFile(path.join(dir, 'pass-1.json'), {
      runId: RUN_ID,
      pass: 1,
      projects: CONFIGURED,
      requireAll: true,
    });
    const pass2 = readPassFile(path.join(dir, 'pass-2.json'), {
      runId: RUN_ID,
      pass: 2,
      projects: ['demo--node-1'],
      requireAll: false,
    });
    assert.equal(pass1.state, 'ok');
    assert.equal(pass2.state, 'ok');

    const decision = decide({ pass1, pass2, requested: ['demo--node-1'] });
    const summary = toSummary(decision, {
      runId: RUN_ID,
      coreVersion: '0.1.0',
      locale: 'en',
      startedAt: started,
      finishedAt: new Date('2026-10-20T10:15:40.000Z'),
    });

    assert.equal(summary.status, 'fail');
    assert.equal(summary.result, 'FAIL');
    assert.equal(summary.exit_code, 1);
    assert.equal(summary.reason, 'slow');
    assert.deepEqual(
      summary.nodes.map((node) => [node.node, node.class, node.recheck]),
      [
        ['node-1', 'slow', 'ok'],
        ['node-2', 'ok', null],
      ],
    );
    assert.deepEqual(exitLines(summary), ['REASON=slow', 'RESULT=FAIL']);
  });

  test('a pass 1 whose class contradicts its metrics fails closed', () => {
    const dir = path.join(WORK, 'runs', 'contradiction');
    const contradicting: PassProject = {
      ...project('node-1', 'ok'),
      metrics: [{ name: 'login_ms', ms: 900, reference_ms: 300, maxRatio: 3, ratio: 3, verdict: 'slow' }],
    };
    writeFileAtomic(
      path.join(dir, 'pass-1.json'),
      passFileText(
        buildPassFile({
          runId: RUN_ID,
          pass: 1,
          startedAt: new Date('2026-10-20T10:15:00.000Z'),
          finishedAt: new Date('2026-10-20T10:15:30.000Z'),
          projects: [contradicting, project('node-2', 'ok')],
        }),
      ),
    );

    const pass1 = readPassFile(path.join(dir, 'pass-1.json'), {
      runId: RUN_ID,
      pass: 1,
      projects: CONFIGURED,
      requireAll: true,
    });
    assert.equal(pass1.state, 'invalid');

    const decision = decide({ pass1, requested: CONFIGURED });
    assert.equal(decision.status, 'fail');
    assert.equal(decision.result, 'FAIL');
    assert.equal(decision.exit_code, 1);
    assert.equal(decision.reason, 'report_not_built');
    assert.deepEqual(decision.nodes, []);
    assert.deepEqual(decision.warnings, [{ code: 'pass_invalid', pass: 1 }]);
  });
});

// ---- The outcome table, with the pass reads built in memory. ----

const T0 = new Date('2026-10-20T10:15:00.000Z');
const T1 = new Date('2026-10-20T10:15:30.000Z');
const META = { runId: RUN_ID, coreVersion: '0.1.0', locale: 'en' as const, startedAt: T0, finishedAt: T1 };

function passOf(pass: 1 | 2, projects: PassProject[], gaps?: Parameters<typeof buildPassFile>[0]['gaps']): PassRead {
  return { state: 'ok', file: buildPassFile({ runId: RUN_ID, pass, startedAt: T0, finishedAt: T1, projects, gaps }) };
}

const MISSING: PassRead = { state: 'missing' };
const INVALID: PassRead = { state: 'invalid' };

type Row = {
  name: string;
  pass1: PassRead;
  pass2?: PassRead;
  requested?: string[];
  expect: {
    status: 'pass' | 'fail';
    result: 'PASS' | 'FAIL';
    exit: 0 | 1;
    reason: string | null;
    rechecks: Array<string | null>;
    warnings: unknown[];
    lines: string[];
  };
};

const FAIL_SLOW = ['REASON=slow', 'RESULT=FAIL'];
const FAIL_ERROR = ['REASON=error', 'RESULT=FAIL'];
const FAIL_NOT_BUILT = ['REASON=report_not_built', 'RESULT=FAIL'];

const ROWS: Row[] = [
  {
    name: 'every project ok passes with exit 0 and no reason',
    pass1: passOf(1, [project('node-1', 'ok'), project('node-2', 'ok')]),
    expect: { status: 'pass', result: 'PASS', exit: 0, reason: null, rechecks: [null, null], warnings: [], lines: ['RESULT=PASS'] },
  },
  {
    name: 'ok and slow fail with slow before any pass 2 was read',
    pass1: passOf(1, [project('node-1', 'ok'), project('node-2', 'slow')]),
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'slow', rechecks: [null, null], warnings: [], lines: FAIL_SLOW },
  },
  {
    name: 'slow and error fail with error',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'error')]),
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'error', rechecks: [null, null], warnings: [], lines: FAIL_ERROR },
  },
  {
    name: 'error alone fails with error',
    pass1: passOf(1, [project('node-1', 'ok'), project('node-2', 'error')]),
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'error', rechecks: [null, null], warnings: [], lines: FAIL_ERROR },
  },
  {
    name: 'a missing pass 1 is report_not_built without a warning',
    pass1: MISSING,
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'report_not_built', rechecks: [], warnings: [], lines: FAIL_NOT_BUILT },
  },
  {
    name: 'an invalid pass 1 is report_not_built with a pass_invalid warning',
    pass1: INVALID,
    expect: {
      status: 'fail',
      result: 'FAIL',
      exit: 1,
      reason: 'report_not_built',
      rechecks: [],
      warnings: [{ code: 'pass_invalid', pass: 1 }],
      lines: FAIL_NOT_BUILT,
    },
  },
  {
    name: 'a pass 1 without projects is report_not_built',
    pass1: passOf(1, []),
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'report_not_built', rechecks: [], warnings: [], lines: FAIL_NOT_BUILT },
  },
  {
    name: 'pass 2 ok for the slow node: recheck ok, run still fails with slow',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'ok')]),
    pass2: passOf(2, [project('node-1', 'ok')]),
    requested: ['demo--node-1'],
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'slow', rechecks: ['ok', null], warnings: [], lines: FAIL_SLOW },
  },
  {
    name: 'pass 2 slow for the slow node: recheck still_slow',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'ok')]),
    pass2: passOf(2, [project('node-1', 'slow')]),
    requested: ['demo--node-1'],
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'slow', rechecks: ['still_slow', null], warnings: [], lines: FAIL_SLOW },
  },
  {
    name: 'pass 2 error for the slow node: recheck error, run still fails with slow',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'ok')]),
    pass2: passOf(2, [project('node-1', 'error')]),
    requested: ['demo--node-1'],
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'slow', rechecks: ['error', null], warnings: [], lines: FAIL_SLOW },
  },
  {
    name: 'a slow node absent from pass 2 gets recheck error and a pass_2_not_built warning',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'slow')]),
    pass2: passOf(2, [project('node-2', 'ok')]),
    requested: ['demo--node-1', 'demo--node-2'],
    expect: {
      status: 'fail',
      result: 'FAIL',
      exit: 1,
      reason: 'slow',
      rechecks: ['error', 'ok'],
      warnings: [{ code: 'pass_2_not_built', scenario: 'demo', node: 'node-1' }],
      lines: FAIL_SLOW,
    },
  },
  {
    name: 'a missing pass 2 gives recheck error and a pass_2_not_built warning per slow node',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'slow')]),
    pass2: MISSING,
    requested: ['demo--node-1', 'demo--node-2'],
    expect: {
      status: 'fail',
      result: 'FAIL',
      exit: 1,
      reason: 'slow',
      rechecks: ['error', 'error'],
      warnings: [
        { code: 'pass_2_not_built', scenario: 'demo', node: 'node-1' },
        { code: 'pass_2_not_built', scenario: 'demo', node: 'node-2' },
      ],
      lines: FAIL_SLOW,
    },
  },
  {
    name: 'an invalid pass 2 gives recheck error for every slow node and one pass_invalid warning',
    pass1: passOf(1, [project('node-1', 'slow'), project('node-2', 'slow')]),
    pass2: INVALID,
    requested: ['demo--node-1', 'demo--node-2'],
    expect: {
      status: 'fail',
      result: 'FAIL',
      exit: 1,
      reason: 'slow',
      rechecks: ['error', 'error'],
      warnings: [{ code: 'pass_invalid', pass: 2 }],
      lines: FAIL_SLOW,
    },
  },
  {
    name: 'a pass 1 without a slow project leaves every recheck null even when a pass 2 is offered',
    pass1: passOf(1, [project('node-1', 'ok'), project('node-2', 'error')]),
    pass2: passOf(2, [project('node-2', 'ok')]),
    requested: [],
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'error', rechecks: [null, null], warnings: [], lines: FAIL_ERROR },
  },
  {
    name: 'an error project is never rechecked even when it is requested',
    pass1: passOf(1, [project('node-1', 'error'), project('node-2', 'slow')]),
    pass2: passOf(2, [project('node-1', 'ok'), project('node-2', 'ok')]),
    requested: ['demo--node-1', 'demo--node-2'],
    expect: { status: 'fail', result: 'FAIL', exit: 1, reason: 'error', rechecks: [null, 'ok'], warnings: [], lines: FAIL_ERROR },
  },
];

describe('the outcome table', () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const decision = decide({ pass1: row.pass1, pass2: row.pass2, requested: row.requested ?? [] });
      assert.equal(decision.status, row.expect.status);
      assert.equal(decision.result, row.expect.result);
      assert.equal(decision.exit_code, row.expect.exit);
      assert.equal(decision.reason, row.expect.reason);
      assert.deepEqual(
        decision.nodes.map((node) => node.recheck),
        row.expect.rechecks,
      );
      assert.deepEqual(decision.warnings, row.expect.warnings);
      assert.deepEqual(exitLines(toSummary(decision, META)), row.expect.lines);
    });
  }

  test('a broken pass 1 lists no node', () => {
    for (const pass1 of [MISSING, INVALID, passOf(1, [])]) {
      assert.deepEqual(decide({ pass1, requested: [] }).nodes, []);
    }
  });

  test('the gaps of pass 1 are copied into the decision', () => {
    const gaps = {
      not_measured: [{ scenario: 'demo', node: 'node-2', metric: 'history_ms' }],
      unused_baselines: [{ scenario: 'demo', node: 'node-1', metric: 'old_ms' }],
    };
    const decision = decide({ pass1: passOf(1, [project('node-1', 'ok'), project('node-2', 'error')], gaps), requested: [] });
    assert.deepEqual(decision.not_measured, gaps.not_measured);
    assert.deepEqual(decision.unused_baselines, gaps.unused_baselines);
  });

  test('nodes follow the order of pass 1', () => {
    const decision = decide({ pass1: passOf(1, [project('node-2', 'ok'), project('node-1', 'ok')]), requested: [] });
    assert.deepEqual(
      decision.nodes.map((node) => node.node),
      ['node-2', 'node-1'],
    );
  });
});

describe('slowProjects', () => {
  function firstPass(...entries: Array<[string, PassProject['class']]>): PassFile {
    const read = passOf(
      1,
      entries.map(([node, projectClass]) => project(node, projectClass)),
    );
    assert.equal(read.state, 'ok');
    return (read as Extract<PassRead, { state: 'ok' }>).file;
  }

  test('returns the slow projects in the order of the configuration', () => {
    const pass1 = firstPass(['node-2', 'slow'], ['node-1', 'slow']);
    assert.deepEqual(slowProjects(pass1, ['demo--node-1', 'demo--node-2']), ['demo--node-1', 'demo--node-2']);
  });

  test('drops a slow project that is not configured', () => {
    const pass1 = firstPass(['node-1', 'slow'], ['node-2', 'slow']);
    assert.deepEqual(slowProjects(pass1, ['demo--node-2']), ['demo--node-2']);
  });

  test('never returns an error project or an ok project', () => {
    const pass1 = firstPass(['node-1', 'error'], ['node-2', 'slow'], ['node-3', 'ok']);
    assert.deepEqual(slowProjects(pass1, ['demo--node-1', 'demo--node-2', 'demo--node-3']), ['demo--node-2']);
  });

  test('lists each project once', () => {
    const pass1 = firstPass(['node-1', 'slow']);
    assert.deepEqual(slowProjects(pass1, ['demo--node-1', 'demo--node-1']), ['demo--node-1']);
  });

  test('is empty when pass 1 has no slow project', () => {
    const pass1 = firstPass(['node-1', 'ok'], ['node-2', 'error']);
    assert.deepEqual(slowProjects(pass1, ['demo--node-1', 'demo--node-2']), []);
  });
});

describe('notReady', () => {
  for (const reason of ['usage', 'config', 'browser', 'playwright_copies'] as const) {
    test(`${reason} is exit 3 with no node and no gap`, () => {
      const decision = notReady(reason);
      assert.equal(decision.status, 'not_ready');
      assert.equal(decision.result, 'FAIL');
      assert.equal(decision.exit_code, 3);
      assert.equal(decision.reason, reason);
      assert.deepEqual(decision.nodes, []);
      assert.deepEqual(decision.not_measured, []);
      assert.deepEqual(decision.unused_baselines, []);
      assert.deepEqual(decision.warnings, []);
      assert.deepEqual(exitLines(toSummary(decision, META)), [`REASON=${reason}`, 'RESULT=FAIL']);
    });
  }
});

describe('toSummary', () => {
  test('has exactly the documented keys', () => {
    const summary = toSummary(decide({ pass1: passOf(1, [project('node-1', 'ok')]), requested: [] }), META);
    assert.deepEqual(Object.keys(summary), [
      'schema_version',
      'run_id',
      'core_version',
      'status',
      'result',
      'exit_code',
      'reason',
      'locale',
      'started_at',
      'finished_at',
      'nodes',
      'not_measured',
      'unused_baselines',
      'warnings',
    ]);
    assert.deepEqual(Object.keys(summary.nodes[0] ?? {}), ['scenario', 'node', 'class', 'metrics', 'recheck']);
  });

  test('carries the run identity and ISO timestamps', () => {
    const summary = toSummary(notReady('config'), { ...META, locale: 'ru' });
    assert.equal(summary.schema_version, 1);
    assert.equal(summary.run_id, RUN_ID);
    assert.equal(summary.core_version, '0.1.0');
    assert.equal(summary.locale, 'ru');
    assert.equal(summary.started_at, '2026-10-20T10:15:00.000Z');
    assert.equal(summary.finished_at, '2026-10-20T10:15:30.000Z');
  });
});

describe('isMachineLine', () => {
  test('is true for every line exitLines can print', () => {
    for (const reason of [...NOT_READY_REASONS, ...FAIL_REASONS]) {
      assert.equal(isMachineLine(`REASON=${reason}`), true, reason);
    }
    for (const token of RESULT_TOKENS) {
      assert.equal(isMachineLine(`RESULT=${token}`), true, token);
    }
    for (const line of exitLines({ result: 'FAIL', reason: 'locked' })) {
      assert.equal(isMachineLine(line), true, line);
    }
  });

  test('is false for a line that only looks like one', () => {
    for (const line of [
      'RESULT=PASS ',
      ' RESULT=PASS',
      'RESULT=pass',
      'RESULT=',
      'RESULT=PASSED',
      'RESULT=hunter2',
      'REASON=',
      'REASON=locked ',
      'REASON=lock',
      'REASON=secret-value',
      'XRESULT=PASS',
      'REASON=slow RESULT=FAIL',
      'result=PASS',
      'Result: PASS',
      '',
    ]) {
      assert.equal(isMachineLine(line), false, JSON.stringify(line));
    }
  });
});
