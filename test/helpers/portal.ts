// Helpers for tests that need the offline demo portal: a spawner that waits for
// the readiness line, a typed loader for the portal module and a CLI runner.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SERVER_PATH: string = path.join(repoRoot, 'examples', 'demo-portal', 'server.mjs');

export type PortalMode = 'ok' | 'slowOnce' | 'slowAlways' | 'loginError' | 'broken';

export type PortalModule = {
  DEMO_ACCOUNT: { login: string; password: string };
  MODES: readonly PortalMode[];
  SLOW_DELAY_MS: number;
  parseCli(argv: string[]): { port: number; mode: PortalMode };
};

/**
 * Loads the portal module at run time. The portal is plain JavaScript, so a
 * dynamic import keeps it out of the TypeScript program.
 */
export async function loadPortalModule(): Promise<PortalModule> {
  return (await import(pathToFileURL(SERVER_PATH).href)) as PortalModule;
}

export type RunningPortal = { url: string; port: number; mode: PortalMode; stop(): Promise<void> };

const READY_LINE = /^listening on http:\/\/127\.0\.0\.1:(\d+) \((\w+)\)$/;

/**
 * Starts the portal as a child process and resolves once it prints its
 * readiness line. Port 0 (the default) lets the OS pick a free port.
 */
export function startPortal(
  mode: PortalMode,
  opts: { port?: number; readyTimeoutMs?: number } = {},
): Promise<RunningPortal> {
  const port = opts.port ?? 0;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const child = spawn(process.execPath, [SERVER_PATH, '--port', String(port), '--mode', mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  return new Promise<RunningPortal>((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrText = '';
    let ready = false;
    let failed = false;

    const stop = async (): Promise<void> => {
      if (!exited) child.kill();
      await exitPromise;
    };
    const fail = (message: string): void => {
      if (ready || failed) return;
      failed = true;
      clearTimeout(timer);
      if (!exited) child.kill();
      reject(new Error(`${message}\nstderr: ${stderrText.trim() || '(empty)'}`));
    };

    const timer = setTimeout(() => {
      fail(`portal (${mode}) printed no listening line within ${readyTimeoutMs} ms`);
    }, readyTimeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (ready || failed) return;
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const match = READY_LINE.exec(line);
        if (match) {
          ready = true;
          clearTimeout(timer);
          const actualPort = Number(match[1]);
          resolve({
            url: `http://127.0.0.1:${actualPort}/`,
            port: actualPort,
            mode: match[2] as PortalMode,
            stop,
          });
          return;
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.once('error', (error) => {
      fail(`could not start the portal: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      fail(`portal (${mode}) exited before it was ready (code ${code}, signal ${signal})`);
    });
  });
}

/** Runs the portal script once and waits for it to end (for launch-argument checks). */
export function runPortalCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [SERVER_PATH, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
