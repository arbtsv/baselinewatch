// Runs a .bat file through cmd.exe for tests, because Node refuses to spawn a .bat directly.
// Node built-ins only (no Playwright import), so node --test and the e2e specs can share it.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export type LauncherResult = { status: number | null; stdout: string; stderr: string; lines: string[] };

/** The System32 directory of this machine: what a scheduler has on its Path when Node is not installed. */
export function systemDirectory(): string {
  const root = [process.env.SystemRoot, process.env.windir].find((value) => value !== undefined && value !== '');
  return path.win32.join(root ?? 'C:\\Windows', 'System32');
}

/** A copy of the environment whose Path is exactly pathValue (Windows keys are case-insensitive, so every spelling is removed first). */
export function envWithPath(pathValue: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.Path = pathValue;
  return env;
}

/**
 * The one verbatim command line for cmd.exe /d /s /c. With /s cmd strips exactly the outer quotes, so the quotes
 * around the file name and around every argument survive. Callers pass absolute paths: a bare name is not found
 * when the current directory is off the search path.
 */
export function launcherCommandLine(batFile: string, args: readonly string[]): string {
  return args.length === 0 ? `""${batFile}""` : `""${batFile}" ${args.join(' ')}"`;
}

// The non-empty lines of the output, without the carriage return that the launcher's own lines end in.
function linesOf(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
}

function commandShell(): string {
  return process.env.ComSpec ?? path.win32.join(systemDirectory(), 'cmd.exe');
}

export function runLauncherSync(
  batFile: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): LauncherResult {
  const result = spawnSync(commandShell(), ['/d', '/s', '/c', launcherCommandLine(batFile, args)], {
    env: opts.env,
    cwd: opts.cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: opts.timeoutMs ?? 60_000,
  });
  const stdout = result.stdout ?? '';
  return { status: result.status, stdout, stderr: result.stderr ?? '', lines: linesOf(stdout) };
}

/** A launcher run that also tells how long it took and whether the timeout ended it; structurally a RunResult of the demo helpers. */
export type LauncherRun = LauncherResult & { durationMs: number; timedOut: boolean };

/**
 * Runs the launcher without blocking and kills the whole process tree on timeout: cmd.exe, the node it
 * started and the browsers below it. taskkill.exe is started by its System32 path, never through the
 * search path or the working directory.
 */
export function runLauncher(
  batFile: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<LauncherRun> {
  const timeoutMs = opts.timeoutMs ?? 170_000;
  const started = performance.now();
  const child = spawn(commandShell(), ['/d', '/s', '/c', launcherCommandLine(batFile, args)], {
    env: opts.env,
    cwd: opts.cwd,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<LauncherRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        spawnSync(path.win32.join(systemDirectory(), 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, lines: linesOf(stdout), durationMs: performance.now() - started, timedOut });
    });
  });
}
