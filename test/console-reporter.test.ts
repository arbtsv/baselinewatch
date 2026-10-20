// Tests for src/reporters/console.ts and src/output.ts: the progress lines of a pass, their silence
// about error text and the printing flag of both reporters. Playwright is not started; the reporter
// is driven with plain objects shaped like its arguments.
// Run: node --test test/console-reporter.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { print, setPrintSink, type PrintSink } from '../src/output.ts';
import ConsoleReporter, { passLine } from '../src/reporters/console.ts';
import DataReporter from '../src/reporters/data.ts';

const SECRET_ERROR_TEXT = 'secret-value-for-test';

function configOf(...nodes: string[]): FullConfig {
  const projects = nodes.map((node) => ({ name: `demo--${node}`, metadata: { scenario: 'demo', node } }));
  return { projects } as unknown as FullConfig;
}

function testCase(id: string, projectName: string): TestCase {
  return { id, parent: { project: () => ({ name: projectName }) } } as unknown as TestCase;
}

function suiteOf(...tests: TestCase[]): Suite {
  return { allTests: () => tests } as unknown as Suite;
}

function passedResult(): TestResult {
  return { status: 'passed', errors: [], annotations: [], startTime: new Date('2026-10-20T12:34:57.000Z') } as unknown as TestResult;
}

function failedResult(message: string): TestResult {
  return {
    status: 'failed',
    errors: [{ message }],
    annotations: [],
    startTime: new Date('2026-10-20T12:34:58.000Z'),
  } as unknown as TestResult;
}

function finished(status: FullResult['status']): FullResult {
  return { status, startTime: new Date('2026-10-20T12:34:56.000Z'), duration: 1000 };
}

// Runs fn with a sink that collects every printed line, and always restores the previous sink.
function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const previous = setPrintSink((line) => {
    lines.push(line);
  });
  try {
    fn();
  } finally {
    setPrintSink(previous);
  }
  return lines;
}

function runPass(
  reporter: ConsoleReporter,
  ended: [TestCase, TestResult][],
  status: FullResult['status'],
  nodes: string[] = ['node-1', 'node-2'],
): void {
  reporter.onBegin(configOf(...nodes), suiteOf(...ended.map(([test]) => test)));
  for (const [test, result] of ended) reporter.onTestEnd(test, result);
  reporter.onEnd(finished(status));
}

describe('the console reporter', () => {
  test('prints one line per project in configuration order', () => {
    const lines = captured(() => {
      runPass(
        new ConsoleReporter({ pass: 1 }),
        [
          [testCase('t1', 'demo--node-1'), passedResult()],
          [testCase('t2', 'demo--node-2'), failedResult('page.goto: net::ERR_CONNECTION_REFUSED')],
        ],
        'failed',
      );
    });
    assert.deepEqual(lines, ['[pass 1] demo--node-1: ok', '[pass 1] demo--node-2: error']);
  });

  test('the pass number comes from the options', () => {
    const lines = captured(() => {
      runPass(new ConsoleReporter({ pass: 2 }), [[testCase('t1', 'demo--node-1'), passedResult()]], 'passed', ['node-1']);
    });
    assert.deepEqual(lines, ['[pass 2] demo--node-1: ok']);
  });

  test('passLine builds the exact line', () => {
    assert.equal(passLine(1, 'demo--node-1', 'ok'), '[pass 1] demo--node-1: ok');
    assert.equal(passLine(2, 'demo--node-2', 'slow'), '[pass 2] demo--node-2: slow');
    assert.equal(passLine(1, 'demo--node-3', 'error'), '[pass 1] demo--node-3: error');
  });

  test('error text never reaches the console lines', () => {
    const lines = captured(() => {
      runPass(
        new ConsoleReporter({ pass: 1 }),
        [
          [testCase('t1', 'demo--node-1'), failedResult(SECRET_ERROR_TEXT)],
          [testCase('t2', 'demo--node-2'), passedResult()],
        ],
        'failed',
      );
    });
    assert.deepEqual(lines, ['[pass 1] demo--node-1: error', '[pass 1] demo--node-2: ok']);
    assert.equal(lines.join('\n').includes(SECRET_ERROR_TEXT), false);
  });

  test('it implements no hook that could pass error or scenario text on', () => {
    const reporter = new ConsoleReporter({ pass: 1 }) as unknown as Record<string, unknown>;
    for (const hook of ['onError', 'onStdOut', 'onStdErr']) {
      assert.equal(reporter[hook], undefined, hook);
    }
  });

  test('the console reporter reports itself as printing and the data reporter as not printing', () => {
    assert.equal(new ConsoleReporter({ pass: 1 }).printsToStdio(), true);
    const data = new DataReporter({
      runId: 'manual',
      pass: 1,
      manual: true,
      passFile: 'unused-pass-1.json',
      metricsCsv: 'unused-metrics.csv',
      baselines: {},
    });
    assert.equal(data.printsToStdio(), false);
  });
});

describe('the print sink', () => {
  test('a capturing sink takes the lines and setPrintSink returns the previous sink', () => {
    const first: string[] = [];
    const second: string[] = [];
    const firstSink: PrintSink = (line) => {
      first.push(line);
    };
    const original = setPrintSink(firstSink);
    try {
      print('one');
      const previous = setPrintSink((line) => {
        second.push(line);
      });
      assert.equal(previous, firstSink);
      print('two');
      setPrintSink(previous);
      print('three');
    } finally {
      setPrintSink(original);
    }
    assert.deepEqual(first, ['one', 'three']);
    assert.deepEqual(second, ['two']);
  });

  test('with a capturing sink installed nothing is written to stdout', () => {
    const written: string[] = [];
    const realWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let lines: string[];
    try {
      lines = captured(() => {
        runPass(new ConsoleReporter({ pass: 1 }), [[testCase('t1', 'demo--node-1'), passedResult()]], 'passed', ['node-1']);
      });
    } finally {
      process.stdout.write = realWrite;
    }
    assert.deepEqual(lines, ['[pass 1] demo--node-1: ok']);
    assert.deepEqual(written, []);
  });

  test('the default sink writes the line and a line break to stdout', () => {
    const written: string[] = [];
    const realWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      print('hello');
    } finally {
      process.stdout.write = realWrite;
    }
    assert.deepEqual(written, ['hello\n']);
  });
});
