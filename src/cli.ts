#!/usr/bin/env node
// The bin entry of baselinewatch: wires the real dependencies into main and sets the exit code. It
// never calls process.exit, so everything written is flushed before the process ends. It imports
// neither the Playwright configuration nor the fixture: the command line must run its checks even
// when Playwright is missing or installed twice.
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { print } from './output.ts';
import { runPrechecks } from './precheck.ts';
import { runPlaywrightPass } from './process.ts';
import { main, type RunDeps } from './run.ts';

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

const deps: RunDeps = {
  cliFile: fileURLToPath(import.meta.url),
  now: () => new Date(),
  sleep: (ms) => sleep(ms),
  print,
  prechecks: runPrechecks,
  runPass: runPlaywrightPass,
  onInterrupt: (handler) => {
    for (const signal of INTERRUPT_SIGNALS) {
      process.on(signal, handler);
    }
    return () => {
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, handler);
      }
    };
  },
};

process.exitCode = await main(process.argv.slice(2), deps);
