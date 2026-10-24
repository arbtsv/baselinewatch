// Runs a .bat file through cmd.exe for tests, because Node refuses to spawn a .bat directly.
// Node built-ins only (no Playwright import), so node --test and the e2e specs can share it.
import { spawnSync } from 'node:child_process';
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

export function runLauncherSync(
  batFile: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): LauncherResult {
  const shell = process.env.ComSpec ?? path.win32.join(systemDirectory(), 'cmd.exe');
  const result = spawnSync(shell, ['/d', '/s', '/c', launcherCommandLine(batFile, args)], {
    env: opts.env,
    cwd: opts.cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: opts.timeoutMs ?? 60_000,
  });
  const stdout = result.stdout ?? '';
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
  return { status: result.status, stdout, stderr: result.stderr ?? '', lines };
}
