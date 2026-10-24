// The arguments of `blw`. The commands are `run` and `init`, and the options --help and --version
// exist; nothing is ever forwarded to Playwright, so a caller cannot reach a Playwright option such as
// --retries or --reporter through this command. As the first argument, --help, -h, --version and -v
// answer on their own and the words after them are ignored; every other problem is a usage problem.
// A problem with the arguments of init is a kind of its own: init is not a run, so it never leaves a
// run record and never ends with the exit code of a run that was not ready.
import { parseArgs } from 'node:util';

export type RunArgs =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage'; problem: string }
  | { kind: 'init'; dir: string | undefined; refresh: boolean }
  | { kind: 'init_usage'; problem: string };

/** The help text, one line each; English only, because it is printed before any env.json is read. */
export const USAGE_LINES: readonly string[] = [
  'Usage: blw run [--help] [--version]',
  '       blw init [dir] [--refresh]',
  '       blw --help | -h | --version | -v',
  '  --help     Show this help and exit',
  '  --version  Print the version of baselinewatch and exit',
  '  --refresh  With init: rewrite only monitor.bat and .gitignore of an existing project from this core',
  '  dir        With init: where the project is written (default: the current directory)',
];

const RUN_OPTIONS: readonly string[] = ['--help', '--version'];
const INIT_OPTIONS: readonly string[] = ['--help', '--refresh'];

// The name of the option that caused a problem, as typed but without a value, printable and short.
// The value of an option is never repeated, because it may be anything the caller typed.
function offendingOption(args: readonly string[], known: readonly string[]): string {
  const typed = args.find((arg) => arg.startsWith('-') && arg !== '--' && !known.includes(arg));
  const name = (typed ?? '--').split('=')[0] ?? '--';
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
}

function usage(problem: string): RunArgs {
  return { kind: 'usage', problem };
}

function initUsage(problem: string): RunArgs {
  return { kind: 'init_usage', problem };
}

// The arguments after `init`: at most one directory, --refresh and --help.
function parseInitArgs(rest: readonly string[]): RunArgs {
  try {
    const { values, positionals } = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: { help: { type: 'boolean' }, refresh: { type: 'boolean' } },
    });
    if (values.help === true) {
      return { kind: 'help' };
    }
    if (positionals.length > 1) {
      return initUsage('unexpected argument');
    }
    const dir = positionals[0];
    if (dir === '') {
      return initUsage('the directory argument is empty');
    }
    return { kind: 'init', dir, refresh: values.refresh === true };
  } catch (error) {
    switch ((error as { code?: unknown }).code) {
      case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
        return initUsage(`unknown option ${offendingOption(rest, INIT_OPTIONS)}`);
      case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
        return initUsage(`option ${offendingOption(rest, INIT_OPTIONS)} takes no value`);
      default:
        return initUsage('invalid arguments');
    }
  }
}

/**
 * Parses the whole command line after `blw`: the first word is `run` or `init`, or one of the four
 * top-level spellings of help and version.
 */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usage('no command given, expected "run" or "init"');
  }
  if (command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (command === '--version' || command === '-v') {
    return { kind: 'version' };
  }
  if (command === 'init') {
    return parseInitArgs(rest);
  }
  if (command !== 'run') {
    return usage('unknown command, expected "run" or "init"');
  }
  try {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: { help: { type: 'boolean' }, version: { type: 'boolean' } },
    });
    if (values.help === true) {
      return { kind: 'help' };
    }
    if (values.version === true) {
      return { kind: 'version' };
    }
    return { kind: 'run' };
  } catch (error) {
    switch ((error as { code?: unknown }).code) {
      case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
        return usage(`unknown option ${offendingOption(rest, RUN_OPTIONS)}`);
      case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
        return usage(`option ${offendingOption(rest, RUN_OPTIONS)} takes no value`);
      case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
        return usage('unexpected argument');
      default:
        return usage('invalid arguments');
    }
  }
}
