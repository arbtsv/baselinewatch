#!/usr/bin/env node
// The bin entry of baselinewatch: wires the real dependencies into main and sets the exit code. It
// never calls process.exit, so everything written is flushed before the process ends. It imports
// neither the Playwright configuration nor the fixture: the command line must run its checks even
// when Playwright is missing or installed twice.
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { print } from './output.ts';
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
};

process.exitCode = await main(process.argv.slice(2), deps);
