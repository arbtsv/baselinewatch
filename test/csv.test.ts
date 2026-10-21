// Tests for src/csv.ts: the column lists, the rendering of a metric row and a run row, the quoting
// rule and the append that writes the header once.
// Run: node --test test/csv.test.ts
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  METRICS_CSV_HEADER,
  RUNS_CSV_HEADER,
  appendCsv,
  csvField,
  metricsCsvLines,
  runsCsvLine,
} from '../src/csv.ts';
import type { MetricRow } from '../src/reporters/collect.ts';

function row(overrides: Partial<MetricRow['metric']> = {}): MetricRow {
  return {
    scenario: 'demo',
    node: 'node-1',
    ts: '2026-10-20T12:34:57.000Z',
    metric: {
      name: 'overview_ms',
      ms: 1234.5678,
      reference_ms: 450,
      maxRatio: 3,
      ratio: 2.743484,
      verdict: 'ok',
      ...overrides,
    },
  };
}

const created: string[] = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blw-csv-'));
  created.push(dir);
  return path.join(dir, 'history.csv');
}

describe('column lists', () => {
  test('metrics.csv has twelve columns in the documented order', () => {
    assert.equal(
      METRICS_CSV_HEADER.join(','),
      'run_id,pass,ts,scenario,node,metric,ms,reference_ms,max_ratio,ratio,verdict,schema_version',
    );
  });

  test('runs.csv has eight columns in the documented order', () => {
    assert.equal(
      RUNS_CSV_HEADER.join(','),
      'run_id,ts_start,ts_end,result,exit_code,reason,core_version,schema_version',
    );
  });
});

describe('csvField', () => {
  test('a plain value is written as is', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField(12), '12');
  });

  test('a comma puts the value in quotes', () => {
    assert.equal(csvField('a,b'), '"a,b"');
  });

  test('a quote is doubled inside quotes', () => {
    assert.equal(csvField('say "x"'), '"say ""x"""');
  });

  test('a line break puts the value in quotes', () => {
    assert.equal(csvField('a\nb'), '"a\nb"');
    assert.equal(csvField('a\rb'), '"a\rb"');
  });
});

describe('metricsCsvLines', () => {
  test('one row renders with one decimal for ms and three for the ratio', () => {
    assert.deepEqual(metricsCsvLines('20261020T123456Z', 1, [row()]), [
      '20261020T123456Z,1,2026-10-20T12:34:57.000Z,demo,node-1,overview_ms,1234.6,450,3,2.743,ok,1',
    ]);
  });

  test('the reference and the limit are written as recorded', () => {
    const [line] = metricsCsvLines('20261020T123456Z', 2, [row({ reference_ms: 450.25, maxRatio: 2.5 })]);
    assert.equal(line, '20261020T123456Z,2,2026-10-20T12:34:57.000Z,demo,node-1,overview_ms,1234.6,450.25,2.5,2.743,ok,1');
  });

  test('the decimal separator is a dot and a whole number keeps its decimals', () => {
    const [line] = metricsCsvLines('20261020T123456Z', 1, [row({ ms: 800, ratio: 2, verdict: 'slow' })]);
    assert.match(line ?? '', /,800\.0,450,3,2\.000,slow,1$/);
  });

  test('rows keep the given order and no row is dropped', () => {
    const lines = metricsCsvLines('20261020T123456Z', 1, [
      row({ name: 'login_ms' }),
      row({ name: 'overview_ms' }),
      row({ name: 'history_ms' }),
    ]);
    assert.deepEqual(
      lines.map((line) => line.split(',')[5]),
      ['login_ms', 'overview_ms', 'history_ms'],
    );
  });

  test('no rows give no lines', () => {
    assert.deepEqual(metricsCsvLines('20261020T123456Z', 1, []), []);
  });
});

describe('runsCsvLine', () => {
  const base = {
    run_id: '20261020T123456Z',
    ts_start: '2026-10-20T12:34:56.000Z',
    ts_end: '2026-10-20T12:36:00.000Z',
    core_version: '0.1.0',
  } as const;

  test('a passing run has an empty reason', () => {
    assert.equal(
      runsCsvLine({ ...base, result: 'PASS', exit_code: 0, reason: null }),
      '20261020T123456Z,2026-10-20T12:34:56.000Z,2026-10-20T12:36:00.000Z,PASS,0,,0.1.0,1',
    );
  });

  test('a failing run names its reason', () => {
    assert.equal(
      runsCsvLine({ ...base, result: 'FAIL', exit_code: 1, reason: 'slow' }),
      '20261020T123456Z,2026-10-20T12:34:56.000Z,2026-10-20T12:36:00.000Z,FAIL,1,slow,0.1.0,1',
    );
  });
});

describe('appendCsv', () => {
  test('a missing file gets the header, then the lines', () => {
    const file = tempFile();
    appendCsv(file, ['a', 'b'], ['1,2', '3,4']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n1,2\n3,4\n');
  });

  test('a missing directory is created', () => {
    const file = path.join(path.dirname(tempFile()), 'artifacts', 'history.csv');
    appendCsv(file, ['a'], ['1']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\n1\n');
  });

  test('an existing file gets the lines only', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'a,b\n1,2\n');
    appendCsv(file, ['a', 'b'], ['3,4']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n1,2\n3,4\n');
  });

  test('an empty file gets the header first', () => {
    const file = tempFile();
    fs.writeFileSync(file, '');
    appendCsv(file, ['a', 'b'], ['1,2']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n1,2\n');
  });

  test('no lines leave the file alone, even a missing one', () => {
    const file = tempFile();
    appendCsv(file, ['a', 'b'], []);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'a,b\n1,2\n');
    appendCsv(file, ['a', 'b'], []);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n1,2\n');
  });

  test('line ends are LF only', () => {
    const file = tempFile();
    appendCsv(file, ['a'], ['1', '2']);
    assert.equal(fs.readFileSync(file, 'utf8').includes('\r'), false);
  });

  test('a file whose last row has no line feed gets one before the new rows', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'a,b\n1,2');
    appendCsv(file, ['a', 'b'], ['3,4']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n1,2\n3,4\n');
  });

  test('a header without a line feed gets one and no second header', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'a,b');
    appendCsv(file, ['a', 'b'], ['3,4']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\n3,4\n');
  });

  test('a file that ends with CRLF gets no extra line feed', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'a,b\r\n1,2\r\n');
    appendCsv(file, ['a', 'b'], ['3,4']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a,b\r\n1,2\r\n3,4\n');
  });

  test('a path that is a directory makes the append throw', () => {
    const dir = path.dirname(tempFile());
    assert.throws(() => appendCsv(dir, ['a', 'b'], ['1,2']));
  });
});
