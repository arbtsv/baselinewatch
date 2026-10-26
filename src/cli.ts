#!/usr/bin/env node
// The bin entry of baselinewatch: wires the real dependencies into main and sets the exit code. It
// never calls process.exit, so everything written is flushed before the process ends. It imports
// neither the Playwright configuration nor the fixture: the command line must run its checks even
// when Playwright is missing or installed twice.
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runTar } from './archive.ts';
import { processIsAlive } from './lock.ts';
import { print, setPrintSink } from './output.ts';
import { runPrechecks } from './precheck.ts';
import { interruptSignals, runPlaywrightPass } from './process.ts';
import { main, type RunDeps } from './run.ts';

const deps: RunDeps = {
  cliFile: fileURLToPath(import.meta.url),
  now: () => new Date(),
  sleep: (ms) => sleep(ms),
  print,
  prechecks: runPrechecks,
  runPass: runPlaywrightPass,
  onInterrupt: (handler) => {
    const signals = interruptSignals(process.platform);
    for (const signal of signals) {
      process.on(signal, handler);
    }
    return () => {
      for (const signal of signals) {
        process.off(signal, handler);
      }
    };
  },
  onExit: (handler) => {
    process.once('exit', handler);
    return () => {
      process.off('exit', handler);
    };
  },
  pid: process.pid,
  isAlive: processIsAlive,
  platform: process.platform,
  zip: runTar,
  // npx keeps the directory the caller typed the command in, which is where init writes by default.
  cwd: () => process.cwd(),
  // The lines relayed from the Playwright child go through the same print() as the lines of this
  // command, so one sink in front of the console covers both.
  attachRedactor: (redact) => {
    const previous = setPrintSink((line) => {
      previous(redact(line));
    });
    return () => {
      setPrintSink(previous);
    };
  },
};

process.exitCode = await main(process.argv.slice(2), deps);
