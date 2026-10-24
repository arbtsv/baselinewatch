// Exact-literal redaction of the account login and password: one redactor for text (the console and
// the text files of a run) and one walk over the run directory. Only the exact characters of a value
// are replaced; escaped forms (JSON, URL, HTML entities) and values shorter than MIN_REDACT_LENGTH
// are not handled. A file that is not UTF-8 text is only searched, for the UTF-8 and UTF-16 bytes of a
// value, and counted as tainted when one is found. node:fs and node:path only; no Playwright module is loaded here.
import fs from 'node:fs';
import path from 'node:path';
import type { Account } from './env.ts';
import { MIN_REDACT_LENGTH, type WarningField } from './protocol.ts';

export { MIN_REDACT_LENGTH };

/** What replaces a value. */
export const MASK = '***';

/** Above this size a file is scanned in chunks and never decoded whole: 64 MiB. */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const REWRITE_TRIES = 3;
const REWRITE_PAUSE_MS = 50;

export type Redactor = {
  /** The fields whose value is too short to be redacted, login first. */
  tooShort: WarningField[];
  /** The input with every value replaced by MASK, longest value first. */
  text(input: string): string;
  /** True when the buffer holds a value as UTF-8, UTF-16LE or UTF-16BE bytes. */
  containsValue(data: Buffer): boolean;
  /** The byte length of the longest needle (a value in any of the three encodings); 0 when no value is redacted. */
  longestValueBytes: number;
};

/**
 * Builds a redactor from the account. A value shorter than MIN_REDACT_LENGTH is left alone and named in
 * tooShort. The replacement uses split and join, never a regular expression, so a value with
 * metacharacters or with '$&' is replaced as the literal it is.
 */
export function createRedactor(account: Account): Redactor {
  const entries = (['login', 'password'] as const).map((field) => ({ field, value: account[field] }));
  const tooShort = entries.filter(({ value }) => value.length < MIN_REDACT_LENGTH).map(({ field }) => field);
  // Longest first, so a value that contains the other is not left half replaced.
  const values = [...new Set(entries.map(({ value }) => value).filter((value) => value.length >= MIN_REDACT_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  // A UTF-16 text file (a PowerShell redirect writes one) has NUL bytes, so it is searched as bytes.
  const needles = values.flatMap((value) => {
    const little = Buffer.from(value, 'utf16le');
    return [Buffer.from(value, 'utf8'), little, Buffer.from(little).swap16()];
  });
  return {
    tooShort,
    text: (input) => values.reduce((text, value) => text.split(value).join(MASK), input),
    containsValue: (data) => needles.some((needle) => data.includes(needle)),
    longestValueBytes: needles.reduce((longest, needle) => Math.max(longest, needle.length), 0),
  };
}

// fatal: any byte sequence that is not UTF-8 throws; ignoreBOM: a byte order mark stays in the text,
// so a rewrite keeps it.
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a buffer, or undefined when it has a NUL byte or is not strict UTF-8. A byte order mark is kept. */
export function strictText(data: Buffer): string | undefined {
  if (data.includes(0)) {
    return undefined;
  }
  try {
    return DECODER.decode(data);
  } catch {
    return undefined;
  }
}

/**
 * What a walk did, with relative paths written with '/': how many files it rewrote, the files that
 * still hold a value or could not be read (tainted), the directories that could not be listed
 * (unlisted: nothing under them is known), and every file that was read and is free of a value (clean).
 */
export type WalkResult = { rewritten: number; tainted: string[]; unlisted: string[]; clean: string[] };

export type WalkOptions = {
  /** Files above this size are scanned in chunks instead of decoded. */
  maxTextBytes?: number;
  /** The read size of a chunked scan. */
  chunkBytes?: number;
  /** Replaces the directory listing; for tests. */
  readdir?: (dir: string) => fs.Dirent[];
  /** Replaces the rename that puts a rewritten file in place; for tests. */
  rename?: (from: string, to: string) => void;
};

// What the command line parses or produces itself, or what stays outside the promise: the pass files,
// the html report of each pass, and the report and summary of the run. None of them is rewritten.
function skipped(relative: string): boolean {
  return /^pass-\d+\.json$/.test(relative) || /^pass-\d+\/html$/.test(relative) || relative === 'report.txt' || relative === 'summary.json';
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Temp file and rename, three tries: a virus scan can hold the target for a moment on Windows.
function rewrite(file: string, text: string, rename: (from: string, to: string) => void): boolean {
  const temp = `${file}.${process.pid}.redact`;
  for (let attempt = 0; attempt < REWRITE_TRIES; attempt += 1) {
    try {
      fs.writeFileSync(temp, text, 'utf8');
      rename(temp, file);
      return true;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // A temp file that is held too: the next attempt overwrites it.
      }
      if (attempt + 1 < REWRITE_TRIES) {
        pause(REWRITE_PAUSE_MS);
      }
    }
  }
  return false;
}

// A file too large to decode: read in chunks that overlap by one byte less than the longest value, so
// a value across a chunk boundary is still found.
function chunkedHit(file: string, redactor: Redactor, chunkBytes: number): boolean {
  const overlap = Math.max(0, redactor.longestValueBytes - 1);
  if (redactor.longestValueBytes === 0) {
    return false;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(chunkBytes);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunkBytes, null);
      if (read === 0) {
        return false;
      }
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (redactor.containsValue(window)) {
        return true;
      }
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
  } finally {
    fs.closeSync(fd);
  }
}

// One regular file: true when it is rewritten, false when nothing changed; undefined when it is tainted.
function redactFile(
  file: string,
  redactor: Redactor,
  maxTextBytes: number,
  chunkBytes: number,
  rename: (from: string, to: string) => void,
): boolean | undefined {
  try {
    if (fs.statSync(file).size > maxTextBytes) {
      return chunkedHit(file, redactor, chunkBytes) ? undefined : false;
    }
    const data = fs.readFileSync(file);
    const text = strictText(data);
    if (text === undefined) {
      return redactor.containsValue(data) ? undefined : false;
    }
    const redacted = redactor.text(text);
    if (redacted === text) {
      return false;
    }
    return rewrite(file, redacted, rename) ? true : undefined;
  } catch {
    // A file that cannot be read cannot be shown to be free of a value.
    return undefined;
  }
}

/**
 * Redacts the text files under runDir in place and reports what it saw: the files that still hold a
 * value or could not be read, the directories it could not list, and the files that are free of a value.
 * Whatever is in neither clean nor tainted was not verified, so a caller that packs files takes the
 * clean list as its only source. Only real directories and files are visited: a symbolic link or
 * junction is neither followed nor read. The walk never throws.
 */
export function redactRunDirectory(runDir: string, redactor: Redactor, options: WalkOptions = {}): WalkResult {
  const maxTextBytes = options.maxTextBytes ?? MAX_TEXT_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const readdir = options.readdir ?? ((dir: string) => fs.readdirSync(dir, { withFileTypes: true }));
  const rename = options.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
  const result: WalkResult = { rewritten: 0, tainted: [], unlisted: [], clean: [] };
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = readdir(dir);
    } catch {
      // A directory that cannot be listed cannot be shown to be free of a value either.
      result.unlisted.push(prefix === '' ? '.' : prefix);
      return;
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (skipped(relative)) {
        continue;
      }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file, relative);
      } else if (entry.isFile()) {
        const outcome = redactFile(file, redactor, maxTextBytes, chunkBytes, rename);
        if (outcome === undefined) {
          result.tainted.push(relative);
        } else {
          result.clean.push(relative);
          if (outcome) {
            result.rewritten += 1;
          }
        }
      }
    }
  };
  visit(runDir, '');
  return result;
}
