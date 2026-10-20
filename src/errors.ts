// The typed configuration error and the shared reader for the two JSON config files.
import fs from 'node:fs';
import path from 'node:path';

function shownPath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolute;
  }
  return relative;
}

export class ConfigError extends Error {
  readonly reason = 'config' as const;
  readonly file: string;

  constructor(file: string, problem: string, fix: string) {
    const absolute = path.resolve(file);
    super(`[config] ${shownPath(absolute)}: ${problem}. ${fix}.`);
    this.name = 'ConfigError';
    this.file = absolute;
    // One readable line instead of a long stack when Playwright prints the error.
    this.stack = 'ConfigError: ' + this.message;
  }
}

export function isConfigError(error: unknown): error is ConfigError {
  return typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'config';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Line and column of a zero-based character offset, both counted from 1.
function lineAndColumn(text: string, position: number): [number, number] {
  let line = 1;
  let column = 1;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return [line, column];
}

// Reads and parses a JSON config file. Every failure is a ConfigError that names the file and says
// what to do; no message carries the parser text, a snippet of the file or any value from it.
export function readJsonConfig(file: string, missingFix: string): unknown {
  const absolute = path.resolve(file);
  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(absolute, `file not found (looked for ${absolute})`, missingFix);
    }
    const shown = typeof code === 'string' ? code : 'unknown error';
    throw new ConfigError(absolute, `file cannot be read (${shown})`, 'Check the path and the file permissions');
  }
  // Windows editors may write a UTF-8 byte order mark.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.trim() === '') {
    throw new ConfigError(absolute, 'file is empty', missingFix);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    let where = '';
    const lineColumn = /line (\d+) column (\d+)/.exec(message);
    const offset = /at position (\d+)/.exec(message);
    if (lineColumn) {
      where = ` (line ${lineColumn[1]}, column ${lineColumn[2]})`;
    } else if (offset) {
      const [line, column] = lineAndColumn(text, Number(offset[1]));
      where = ` (line ${line}, column ${column})`;
    }
    throw new ConfigError(
      absolute,
      `not valid JSON${where}`,
      'Fix the JSON syntax, for example a missing comma or quote',
    );
  }
}
