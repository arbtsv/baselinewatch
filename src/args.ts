// The arguments of `blw`. Only the command `run` and the options --help and --version exist;
// nothing is ever forwarded to Playwright, so a caller cannot reach a Playwright option such as
// --retries or --reporter through this command. As the first argument, --help, -h, --version and -v
// answer on their own and the words after them are ignored; every other problem is a usage problem.
import { parseArgs } from 'node:util';

export type RunArgs = { kind: 'run' } | { kind: 'help' } | { kind: 'version' } | { kind: 'usage'; problem: string };

/** The help text, one line each; English only, because it is printed before any env.json is read. */
export const USAGE_LINES: readonly string[] = [
  'Usage: blw run [--help] [--version]',
  '       blw --help | -h | --version | -v',
  '  --help     Show this help and exit',
  '  --version  Print the version of baselinewatch and exit',
];

const KNOWN_OPTIONS: readonly string[] = ['--help', '--version'];

// The name of the option that caused a problem, as typed but without a value, printable and short.
// The value of an option is never repeated, because it may be anything the caller typed.
function offendingOption(args: readonly string[]): string {
  const typed = args.find((arg) => arg.startsWith('-') && arg !== '--' && !KNOWN_OPTIONS.includes(arg));
  const name = (typed ?? '--').split('=')[0] ?? '--';
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
}

function usage(problem: string): RunArgs {
  return { kind: 'usage', problem };
}

/**
 * Parses the whole command line after `blw`: the first word is `run`, or one of the four top-level
 * spellings of help and version.
 */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usage('no command given, expected "run"');
  }
  if (command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (command === '--version' || command === '-v') {
    return { kind: 'version' };
  }
  if (command !== 'run') {
    return usage('unknown command, expected "run"');
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
        return usage(`unknown option ${offendingOption(rest)}`);
      case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
        return usage(`option ${offendingOption(rest)} takes no value`);
      case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
        return usage('unexpected argument');
      default:
        return usage('invalid arguments');
    }
  }
}
