// The Playwright child process of one pass: the argument list, the launch, the line relay of its
// standard output, the log of its standard error and the watchdog. The child is node itself running
// the project's own Playwright CLI; there is no shell, no npx and no PATH lookup, and on Windows the
// taskkill tool is named by its full path in the system directory. This module loads no Playwright
// module: the CLI file is only resolved to a path.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stripAnsi } from './classify.ts';
import { GLOBAL_TIMEOUT_MS, WATCHDOG_GRACE_MS } from './protocol.ts';

/** How a pass ended, as far as the process goes; the verdict comes from the pass file alone. */
export type PassRun = { status: number | null; timedOut: boolean; interrupted: boolean };

export type PassRunOptions = {
  root: string;
  runId: string;
  pass: 1 | 2;
  /** Project ids for --project; empty for a pass over every project. */
  projects: readonly string[];
  stderrLog: string;
  print: (line: string) => void;
  /** Time after which the process tree is killed; defaults to the global timeout plus the grace. */
  watchdogMs?: number;
  signal?: AbortSignal;
};

/** The arguments after node: the CLI file, `test`, the config and one --project per project. */
export function playwrightArgs(cli: string, root: string, projects: readonly string[]): string[] {
  return [cli, 'test', `--config=${path.join(root, 'playwright.config.ts')}`, ...projects.map((project) => `--project=${project}`)];
}

/** The Playwright CLI of the project at root, as an absolute path. */
export function resolvePlaywrightCli(root: string): string {
  return createRequire(path.join(root, 'package.json')).resolve('@playwright/test/cli');
}

/**
 * The signals that end a run early. SIGHUP (a closed terminal or SSH session) exists only off Windows;
 * SIGBREAK only means something on Windows and is harmless elsewhere.
 */
export function interruptSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  if (platform !== 'win32') {
    signals.push('SIGHUP');
  }
  return signals;
}

/** The taskkill tool by its full path under the system directory, never through PATH or the working directory. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = [env.SystemRoot, env.windir].find((value) => value !== undefined && value !== '') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'taskkill.exe');
}

// Every control character except the tab: C0 without U+0009, delete and the C1 block.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/**
 * A line of child output as the console may show it: escape sequences removed whole (so no fragment of
 * one is printed), then every remaining control character except the tab. Multi-byte characters stay.
 */
export function printableLine(line: string): string {
  return stripAnsi(line).replace(CONTROL_CHARACTERS, '');
}

/**
 * Splits text that arrives in chunks into lines. A line leaves without its line end and without a
 * carriage return in front of it; what is left over when the stream ends leaves as a last line. A print
 * that throws loses that one line; the relay goes on, so a failing sink can never become an uncaught
 * exception in a stream handler.
 */
export function createLineRelay(print: (line: string) => void): { push(chunk: string): void; end(): void } {
  let pending = '';
  const emit = (line: string): void => {
    try {
      print(printableLine(line));
    } catch {
      // The line is lost; the pass and the lines after it go on.
    }
  };
  return {
    push(chunk: string): void {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        emit(line.endsWith('\r') ? line.slice(0, -1) : line);
        newline = pending.indexOf('\n');
      }
    },
    end(): void {
      const rest = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      pending = '';
      if (rest !== '') {
        emit(rest);
      }
    },
  };
}

/** Kills a process and everything it started: taskkill on Windows, the process group elsewhere. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

export type ChildOptions = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderrLog: string;
  print: (line: string) => void;
  watchdogMs: number;
  signal?: AbortSignal;
};

/**
 * Runs one child to the end. Standard output goes line by line through print; standard error goes to
 * the log file and never to the console. The watchdog and the abort signal kill the whole tree.
 */
export function runChild(options: ChildOptions): Promise<PassRun> {
  return new Promise<PassRun>((resolve, reject) => {
    const { signal } = options;
    fs.mkdirSync(path.dirname(options.stderrLog), { recursive: true });
    fs.appendFileSync(options.stderrLog, '');
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    // An abnormal end of blw (an uncaught error, process.exit) must not leave Playwright running and
    // signing in to the portal: the exit event runs synchronously, so the tree is killed right there.
    const onExit = (): void => {
      killTree(child.pid);
    };
    process.once('exit', onExit);
    const relay = createLineRelay(options.print);
    let timedOut = false;
    let interrupted = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      relay.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        fs.appendFileSync(options.stderrLog, chunk);
      } catch {
        // The log only helps a human; a write that fails must not stop the pass.
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.watchdogMs);
    const onAbort = (): void => {
      interrupted = true;
      killTree(child.pid);
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const cleanup = (): void => {
      process.removeListener('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (status) => {
      cleanup();
      relay.end();
      resolve({ status, timedOut, interrupted });
    });
  });
}

/** Runs Playwright for one pass in the project at options.root. */
export async function runPlaywrightPass(options: PassRunOptions): Promise<PassRun> {
  const { root, runId, pass, projects } = options;
  const cli = resolvePlaywrightCli(root);
  return runChild({
    file: process.execPath,
    args: playwrightArgs(cli, root, projects),
    cwd: root,
    env: { ...process.env, BLW_RUN_ID: runId, BLW_PASS: String(pass), BLW_ROOT: root },
    stderrLog: options.stderrLog,
    print: options.print,
    watchdogMs: options.watchdogMs ?? GLOBAL_TIMEOUT_MS + WATCHDOG_GRACE_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
