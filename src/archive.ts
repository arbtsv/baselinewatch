// Builds report_<run id>.zip with the Windows bsdtar, started by its full path: the tar that PATH finds
// first may be GNU tar, which cannot write a zip. The archive is written under a temporary name and
// renamed only when it starts with the zip signature. Node built-ins only; no Playwright module.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The longest command line this module hands to CreateProcess; the Windows limit is 32,767 characters. */
export const MAX_COMMAND_LINE = 30_000;

/** How long tar may run before it is stopped. */
export const TAR_TIMEOUT_MS = 60_000;

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const LIST_FILE = 'files.txt';
const LIST_DIR_PREFIX = 'blw-zip-';

/** System32\tar.exe by its full path, never through PATH or the working directory. */
export function tarPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = [env.SystemRoot, env.windir].find((value) => value !== undefined && value !== '') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'tar.exe');
}

/**
 * The arguments for `tar -a -c -f <zip> -C <runDir> -- <files...>`. The output name must end in .zip,
 * because -a picks the archive format from the extension and writes a plain tar for any other name.
 * The double dash makes a file name that starts with a dash a file.
 */
export function tarArgs(zipFile: string, runDir: string, files: readonly string[]): string[] {
  if (!zipFile.toLowerCase().endsWith('.zip')) {
    throw new Error('the archive name must end in .zip');
  }
  return ['-a', '-c', '-f', zipFile, '-C', runDir, '--', ...files];
}

/** The length of the command line of an argument list: every argument and a space, plus quotes when it has a space. */
export function commandLineLength(file: string, args: readonly string[]): number {
  return file.length + args.reduce((sum, arg) => sum + arg.length + 1 + (/[\s"]/.test(arg) ? 2 : 0), 0);
}

/** How a tar run ended: the exit status, whether the time limit stopped it, and the code of an error. */
export type TarResult = { status: number | null; timedOut: boolean; error?: string };

/** Runs the tar executable with the arguments; injected, so a test can answer without a real tar. */
export type TarRunner = (file: string, args: readonly string[]) => Promise<TarResult>;

/**
 * Runs the real tar without a shell. Standard input and output are ignored; standard error is drained
 * and dropped, because it is in the console code page and may name paths: it is never printed.
 */
export const runTar: TarRunner = (file, args) =>
  new Promise((resolve) => {
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ status: null, timedOut: false, error: (error as NodeJS.ErrnoException).code ?? 'spawn' });
      return;
    }
    child.stderr?.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TAR_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, timedOut, error: (error as NodeJS.ErrnoException).code ?? 'error' });
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut });
    });
  });

export type ZipOutcome = 'built' | 'failed';

// Printable ASCII only: a -T list file is read in the ANSI code page, which loses any other name.
const ASCII_NAME = /^[\u0020-\u007e]+$/;

// The arguments of the call: the file names as arguments, or in a list file when the line is too long.
// Undefined when the line is too long and a name is not ASCII.
function callArguments(
  options: { runDir: string; tempZip: string; files: readonly string[]; tar: string; listDir?: string },
  made: { listDir?: string },
): string[] | undefined {
  const args = tarArgs(options.tempZip, options.runDir, options.files);
  if (commandLineLength(options.tar, args) <= MAX_COMMAND_LINE) {
    return args;
  }
  if (!options.files.every((name) => ASCII_NAME.test(name))) {
    return undefined;
  }
  made.listDir = fs.mkdtempSync(path.join(options.listDir ?? os.tmpdir(), LIST_DIR_PREFIX));
  const listFile = path.join(made.listDir, LIST_FILE);
  fs.writeFileSync(listFile, options.files.join('\n'), 'utf8');
  return ['-a', '-c', '-f', options.tempZip, '-C', options.runDir, '-T', listFile];
}

function startsWithSignature(file: string): boolean {
  const head = Buffer.alloc(ZIP_SIGNATURE.length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.equals(ZIP_SIGNATURE);
}

/**
 * Archives the files (paths relative to runDir, written with '/') into finalZip through the temporary
 * name tempZip, which must end in .zip. Anything short of a finished zip, whether a tar that failed,
 * timed out or could not start, a missing file or an archive without the zip signature, removes the
 * temporary file and the list file and gives 'failed'. A command line too long for the name list is
 * 'failed' as well, unless every name is ASCII, when a list file outside runDir carries the names.
 */
export async function buildZip(options: {
  runDir: string;
  tempZip: string;
  finalZip: string;
  files: readonly string[];
  run: TarRunner;
  tar: string;
  /** Where the list file for a long command line is made; the system temporary directory by default. */
  listDir?: string;
}): Promise<ZipOutcome> {
  const made: { listDir?: string } = {};
  try {
    const args = callArguments(options, made);
    if (args === undefined) {
      return 'failed';
    }
    const result = await options.run(options.tar, args);
    if (result.status !== 0 || result.timedOut || result.error !== undefined) {
      return 'failed';
    }
    if (!startsWithSignature(options.tempZip)) {
      return 'failed';
    }
    fs.renameSync(options.tempZip, options.finalZip);
    return 'built';
  } catch {
    return 'failed';
  } finally {
    fs.rmSync(options.tempZip, { force: true });
    if (made.listDir !== undefined) {
      fs.rmSync(made.listDir, { recursive: true, force: true });
    }
  }
}

/**
 * True for a path (relative to the run directory, with '/') that belongs in the zip: the report, the
 * summary, a pass file, or a file under a pass's test-results. Never the html report, a stderr log,
 * the history error log or the cli error log.
 */
export function isZipCandidate(relative: string): boolean {
  return /^(?:report\.txt|summary\.json|pass-\d+\.json)$/.test(relative) || /^pass-\d+\/test-results\/./.test(relative);
}

const FIXED_ENTRIES = ['report.txt', 'summary.json', 'pass-1.json', 'pass-2.json'] as const;

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

// Every regular file under dir, as a path relative to base with '/'; links are not followed.
function filesUnder(dir: string, base: string, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      filesUnder(full, base, found);
    } else if (entry.isFile()) {
      found.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
}

/**
 * The files of the zip, as paths relative to runDir with '/': the report, the summary and the pass
 * files that exist, then every file under pass-1 and pass-2 test-results, sorted, without the paths in
 * tainted. It never throws; a directory that cannot be read contributes nothing.
 */
export function zipFileList(runDir: string, tainted: ReadonlySet<string>): string[] {
  const fixed = FIXED_ENTRIES.filter((name) => isRegularFile(path.join(runDir, name)));
  const results: string[] = [];
  for (const pass of [1, 2]) {
    filesUnder(path.join(runDir, `pass-${pass}`, 'test-results'), runDir, results);
  }
  results.sort();
  return [...fixed, ...results].filter((name) => !tainted.has(name));
}
