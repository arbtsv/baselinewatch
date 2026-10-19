// Tests for src/verdict.ts: the ratio, the ok/slow boundary and input validation.
// Run: node --test test/verdict.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/verdict.ts';

type Row = [name: string, ms: number, reference_ms: number, maxRatio: number, ratio: number, verdict: 'ok' | 'slow'];

describe('judge', () => {
  const rows: Row[] = [
    ['well below the limit', 100, 300, 3, 100 / 300, 'ok'],
    ['exactly at the limit is ok', 900, 300, 3, 3, 'ok'],
    ['one step above the limit is slow', 901, 300, 3, 901 / 300, 'slow'],
    ['zero milliseconds is ok with ratio 0', 0, 300, 3, 0, 'ok'],
    ['limit of 1: one above the reference is slow', 301, 300, 1, 301 / 300, 'slow'],
    ['limit of 1: equal to the reference is ok', 300, 300, 1, 1, 'ok'],
    ['fractional reference', 150, 0.5, 1000, 300, 'ok'],
    ['the ratio is not rounded', 1000, 3, 1, 1000 / 3, 'slow'],
  ];
  for (const [name, ms, reference_ms, maxRatio, ratio, verdict] of rows) {
    test(name, () => {
      const result = judge(ms, { reference_ms, maxRatio });
      assert.equal(result.ratio, ratio);
      assert.equal(result.verdict, verdict);
    });
  }

  const invalid: [string, number, number, number][] = [
    ['negative ms', -1, 300, 3],
    ['NaN ms', NaN, 300, 3],
    ['infinite ms', Infinity, 300, 3],
    ['zero reference_ms', 100, 0, 3],
    ['negative reference_ms', 100, -5, 3],
    ['NaN reference_ms', 100, NaN, 3],
    ['infinite reference_ms', 100, Infinity, 3],
    ['maxRatio just below 1', 100, 300, 0.99],
    ['zero maxRatio', 100, 300, 0],
    ['NaN maxRatio', 100, 300, NaN],
    ['infinite maxRatio', 100, 300, Infinity],
  ];
  for (const [name, ms, reference_ms, maxRatio] of invalid) {
    test(`throws RangeError for ${name}`, () => {
      assert.throws(() => judge(ms, { reference_ms, maxRatio }), RangeError);
    });
  }

  test('returns only ratio and verdict, even when the baseline has extra keys', () => {
    const baseline = { reference_ms: 300, maxRatio: 3, approved_by: 'someone', note: 'extra' };
    const result = judge(100, baseline);
    assert.deepStrictEqual(Object.keys(result).sort(), ['ratio', 'verdict']);
  });
});
