// Tests for src/report.ts: the text of report.txt and the localized console lines, built from a
// summary and a language catalog.
// Run: node --test test/report.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.ts';
import { ru } from '../src/i18n/ru.ts';
import { consoleSummary, internalErrorLines, notReadyLines, renderReport } from '../src/report.ts';
import type { Summary, SummaryNode } from '../src/protocol.ts';

// A letter of the Cyrillic block; the Russian checks use the code point range U+0400 to U+04FF, not Russian literals.
const CYRILLIC = new RegExp(`[${String.fromCodePoint(0x0400)}-${String.fromCodePoint(0x04ff)}]`);

const NODE_1: SummaryNode = {
  scenario: 'demo',
  node: 'node-1',
  class: 'slow',
  metrics: [
    { name: 'login_ms', ms: 100, reference_ms: 300, maxRatio: 3, ratio: 100 / 300, verdict: 'ok' },
    { name: 'overview_ms', ms: 1523.4, reference_ms: 450, maxRatio: 3, ratio: 1523.4 / 450, verdict: 'slow' },
  ],
  recheck: 'ok',
};

const NODE_2: SummaryNode = {
  scenario: 'demo',
  node: 'node-2',
  class: 'ok',
  metrics: [{ name: 'login_ms', ms: 120.04, reference_ms: 300, maxRatio: 3, ratio: 120.04 / 300, verdict: 'ok' }],
  recheck: null,
};

function summaryOf(overrides: Partial<Summary> = {}): Summary {
  return {
    schema_version: 1,
    run_id: '20261020T101500Z',
    core_version: '0.1.0',
    status: 'fail',
    result: 'FAIL',
    exit_code: 1,
    reason: 'slow',
    locale: 'en',
    started_at: '2026-10-20T10:15:00.000Z',
    finished_at: '2026-10-20T10:15:30.000Z',
    nodes: [NODE_1, NODE_2],
    not_measured: [],
    unused_baselines: [{ scenario: 'demo', node: 'node-2', metric: 'history_ms' }],
    warnings: [],
    ...overrides,
  };
}

// The cells of the first table line that holds the given cell, split on runs of spaces. The test
// data has no spaces inside a cell.
function cellsOf(text: string, nodeName: string, metric: string): string[] {
  const line = text.split('\n').find((candidate) => candidate.includes(nodeName) && candidate.includes(metric));
  assert.ok(line !== undefined, `no table line for ${nodeName} ${metric}`);
  return line.trim().split(/\s+/);
}

describe('English report', () => {
  test('a failed run with a rechecked node renders an English report', () => {
    const text = renderReport(summaryOf(), en);
    const lines = text.split('\n');

    assert.equal(lines[0], 'baselinewatch report');
    assert.ok(text.includes('Run id: 20261020T101500Z'));
    assert.ok(text.includes('Started at: 2026-10-20T10:15:00.000Z'));
    assert.ok(text.includes('Finished at: 2026-10-20T10:15:30.000Z'));
    assert.ok(text.includes('Locale: en'));

    assert.deepEqual(cellsOf(text, 'node-1', 'overview_ms'), [
      'demo', 'node-1', 'slow', 'overview_ms', '1523.4', '450', '1350', '3.385', 'slow', 'ok',
    ]);
    assert.deepEqual(cellsOf(text, 'node-2', 'login_ms'), [
      'demo', 'node-2', 'ok', 'login_ms', '120.0', '300', '900', '0.400', 'ok', '-',
    ]);
    assert.ok(lines.some((line) => line.startsWith('Scenario') && line.includes('Recheck')));

    assert.ok(text.includes('Not measured\n  (none)'));
    assert.ok(text.includes('Unused baselines\n  demo / node-2 / history_ms'));
    assert.ok(text.includes('Warnings\n  (none)'));

    assert.equal(lines.at(-2), 'Result: FAIL (slow)');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
    assert.ok(!text.includes('RESULT='));
    assert.ok(!text.includes('REASON='));
  });

  test('the report has LF line ends and no byte order mark', () => {
    const text = renderReport(summaryOf(), en);
    assert.ok(!text.includes('\r'));
    assert.notEqual(text.charCodeAt(0), 0xfeff);
  });

  test('a node without metrics gets one row of dashes', () => {
    const empty: SummaryNode = { scenario: 'demo', node: 'node-3', class: 'error', metrics: [], recheck: null };
    const text = renderReport(summaryOf({ nodes: [empty], reason: 'error' }), en);
    assert.deepEqual(cellsOf(text, 'node-3', 'error'), ['demo', 'node-3', 'error', '-', '-', '-', '-', '-', '-', '-']);
  });

  test('the row of a node without metrics ends with its recheck in the last column', () => {
    const empty: SummaryNode = { scenario: 'demo', node: 'node-3', class: 'error', metrics: [], recheck: 'error' };
    const text = renderReport(summaryOf({ nodes: [empty], reason: 'error' }), en);
    assert.deepEqual(cellsOf(text, 'node-3', 'error'), [
      'demo',
      'node-3',
      'error',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      'error',
    ]);
  });

  test('a run without nodes says so instead of printing a table', () => {
    const text = renderReport(summaryOf({ nodes: [], reason: 'report_not_built' }), en);
    assert.ok(text.includes('No node was measured.'));
    assert.ok(!text.includes('Scenario'));
    assert.ok(text.includes('Result: FAIL (report_not_built)'));
  });

  test('a passing run has no reason in its result line', () => {
    const text = renderReport(
      summaryOf({ status: 'pass', result: 'PASS', exit_code: 0, reason: null, nodes: [{ ...NODE_2 }] }),
      en,
    );
    assert.equal(text.split('\n').at(-2), 'Result: PASS');
  });

  test('warnings are written from their structure', () => {
    const text = renderReport(
      summaryOf({
        warnings: [
          { code: 'pass_invalid', pass: 2 },
          { code: 'pass_2_not_built', scenario: 'demo', node: 'node-1' },
        ],
      }),
      en,
    );
    assert.ok(text.includes('Warnings\n  The file of pass 2 is missing or damaged; its results were not used.\n'));
    assert.ok(text.includes('  The second look at demo / node-1 left no result.\n'));
  });

  test('the new warnings are written in their order as catalog sentences', () => {
    const text = renderReport(
      summaryOf({
        warnings: [
          { code: 'lock_taken_over' },
          { code: 'secret_too_short', field: 'password' },
          { code: 'binary_left_out', count: 2 },
          { code: 'zip_skipped' },
        ],
      }),
      en,
    );
    assert.ok(
      text.includes(
        'Warnings\n' +
          '  A lock left by an earlier run that is no longer active was taken over.\n' +
          '  The account password is shorter than 3 characters and is not hidden in the run output.\n' +
          '  Binary files left out of the zip because they contain the account login or password: 2.\n' +
          '  The zip was not built: it is made on Windows only.\n',
      ),
      text,
    );
  });
});

describe('Russian report', () => {
  test('the Russian report keeps every machine token', () => {
    const text = renderReport(summaryOf({ locale: 'ru' }), ru);
    const lines = text.split('\n');

    assert.match(lines[0] ?? '', CYRILLIC);
    assert.deepEqual(cellsOf(text, 'node-1', 'overview_ms'), [
      'demo', 'node-1', 'slow', 'overview_ms', '1523.4', '450', '1350', '3.385', 'slow', 'ok',
    ]);
    assert.deepEqual(cellsOf(text, 'node-2', 'login_ms'), [
      'demo', 'node-2', 'ok', 'login_ms', '120.0', '300', '900', '0.400', 'ok', '-',
    ]);
    assert.ok(text.includes('FAIL (slow)'));
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.includes('RESULT='));
    assert.ok(!text.includes('REASON='));
  });

  test('the Russian console lines keep the tokens and the configuration message unchanged', () => {
    const summary = summaryOf({ locale: 'ru' });
    const summaryLines = consoleSummary(summary, ru, 'artifacts/report.txt');
    assert.ok((summaryLines[0] ?? '').includes('FAIL (slow)'));
    assert.ok((summaryLines[1] ?? '').includes('artifacts/report.txt'));

    const message = '[config] env.json: missing "locale". Add it as in env.example.json';
    const framed = notReadyLines('config', message, ru);
    assert.match(framed[0] ?? '', CYRILLIC);
    assert.ok((framed[0] ?? '').includes('(config)'));
    assert.equal(framed[1], message);
  });
});

describe('console lines', () => {
  test('the summary lines hold the result and the report path', () => {
    assert.deepEqual(consoleSummary(summaryOf(), en, 'artifacts/report.txt'), [
      'Result: FAIL (slow)',
      'Report: artifacts/report.txt',
    ]);
  });

  test('the framing line comes first and the configuration message stays unchanged', () => {
    const message = '[config] env.json: missing "locale". Add it as in env.example.json';
    assert.deepEqual(notReadyLines('config', message, en), ['The environment is not ready (config).', message]);
    assert.deepEqual(notReadyLines('browser', undefined, en), ['The environment is not ready (browser).']);
  });

  test('an internal error is one generic line with the log path', () => {
    assert.deepEqual(internalErrorLines('artifacts/runs/x/cli-error.log', en), [
      'baselinewatch stopped with an internal error; details: artifacts/runs/x/cli-error.log',
    ]);
  });

  test('no console line carries a machine prefix', () => {
    const lines = [
      ...consoleSummary(summaryOf(), en, 'artifacts/report.txt'),
      ...notReadyLines('usage', undefined, en),
      ...internalErrorLines('cli-error.log', en),
    ];
    for (const line of lines) {
      assert.ok(!line.includes('RESULT='), line);
      assert.ok(!line.includes('REASON='), line);
    }
  });
});
