// Every console line of the core goes through print(), so one place decides where text output
// lands. A later step attaches secret redaction here by swapping the sink. This module imports
// nothing but node:process, so any other module can load it without side effects.
import process from 'node:process';

export type PrintSink = (line: string) => void;

const stdoutSink: PrintSink = (line) => {
  process.stdout.write(`${line}\n`);
};

let sink: PrintSink = stdoutSink;

/** Prints one line through the current sink. The line carries no line break of its own. */
export function print(line: string): void {
  sink(line);
}

/** Installs a sink for every later print() and returns the previous one, so the caller can restore it. */
export function setPrintSink(next: PrintSink): PrintSink {
  const previous = sink;
  sink = next;
  return previous;
}
