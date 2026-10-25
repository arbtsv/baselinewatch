// `blw init`: writes a monitoring project from the templates of the running core. The manifest decides
// which template becomes which file and who owns it afterwards; dotfiles are stored without the dot
// because npm pack drops them. Files are copied byte for byte, read and written as buffers, so the
// launcher keeps its CRLF line ends; the only text that changes is the version token in package.json.
// This module uses node:fs, node:path and the atomic writer of the pass-file module: nothing from
// Playwright and nothing from the run module. Everything else it needs comes in through InitDeps.
//
// Init never overwrites or deletes what it did not create. Every target is checked first and a single
// conflict stops the command before the first write; every file is then created exclusively, so a
// file that appeared after the check is never overwritten either. A failed write removes exactly the
// files and the empty directories this run created. A process that is killed in the middle can still
// leave part of a project; the next init reports those files as conflicts and writes nothing.
//
// `blw init --refresh` is the other half: in an existing project it rewrites only the files that the
// template owns (the launcher and .gitignore) from the templates of the running core. It prints what it
// will replace, create or leave before it writes anything, asks nothing and never touches any other file.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './pass-file.ts';

export type TemplateFile = {
  /** Path under templates/, with forward slashes. */
  source: string;
  /** Path in the project, with forward slashes. */
  target: string;
  /** Who owns the file after init: the template (a later refresh may replace it) or the project. */
  owner: 'template' | 'project';
  /** True only for package.json: the version token is replaced. */
  substitute?: boolean;
};

/** Which template becomes which project file, in the order the files are written and listed. */
export const TEMPLATE_FILES: readonly TemplateFile[] = [
  { source: 'package.json', target: 'package.json', owner: 'project', substitute: true },
  { source: 'playwright.config.ts', target: 'playwright.config.ts', owner: 'project' },
  { source: 'env.example.json', target: 'env.example.json', owner: 'project' },
  { source: 'baselines.json', target: 'baselines.json', owner: 'project' },
  { source: 'scenarios/demo.spec.ts', target: 'scenarios/demo.spec.ts', owner: 'project' },
  { source: 'monitor.bat', target: 'monitor.bat', owner: 'template' },
  { source: 'gitignore', target: '.gitignore', owner: 'template' },
];

/** Directories that init creates empty. */
export const PROJECT_DIRS: readonly string[] = ['vendor'];

/** The text in package.json that becomes the version of the core. */
export const VERSION_TOKEN = '{{CORE_VERSION}}';

/** A version that can name a packed file: x.y.z with an optional pre-release or build suffix. */
export const CORE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export type InitDeps = {
  /** The directory of the running package; it holds templates/ and package.json. */
  packageDir: string;
  /** The version of the running package. */
  version: string;
  /** The directory a relative project directory is resolved against. */
  cwd: string;
  print: (line: string) => void;
  /**
   * Creates one new file. It either creates the file with all its bytes or throws and leaves nothing of
   * its own behind; it must fail when the path exists. The default creates the file exclusively.
   */
  writeFile?: (file: string, bytes: Uint8Array) => void;
  /**
   * Replaces or creates one template-owned file during a refresh. It must leave the file either with its
   * old bytes or with all the new ones. The default writes a temporary file in the same directory and
   * renames it over the target.
   */
  replaceFile?: (file: string, bytes: Uint8Array) => void;
};

/** The folder of the templates inside the package. */
export function templatesDir(packageDir: string): string {
  return path.join(packageDir, 'templates');
}

/** The bytes of a project file: the template bytes, with the version token replaced where it applies. */
export function renderTemplate(file: TemplateFile, bytes: Buffer, version: string): Buffer {
  if (file.substitute !== true) {
    return bytes;
  }
  const text = bytes.toString('utf8').replaceAll(VERSION_TOKEN, () => version);
  if (text.includes('{{')) {
    throw new Error(`${file.source} still holds a placeholder after the version was filled in`);
  }
  JSON.parse(text);
  return Buffer.from(text, 'utf8');
}

// The code of a file system error, else its message; never a value from the caller.
function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown error';
}

// What a path is, without following a link: a link counts as something else than a real directory.
type Kind = 'missing' | 'directory' | 'other';

function kindOf(target: string): Kind {
  try {
    return fs.lstatSync(target).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

const absolute = (dir: string, relative: string): string => path.join(dir, ...relative.split('/'));

// The exclusive create: it fails with EEXIST when the path exists, also when the path is a planted link.
const EXCLUSIVE_CREATE = { flag: 'wx' } as const;

function createFile(file: string, bytes: Uint8Array): void {
  const handle = fs.openSync(file, EXCLUSIVE_CREATE.flag);
  try {
    fs.writeFileSync(handle, bytes);
    fs.closeSync(handle);
  } catch (error) {
    // The path was created by the open above, so the partial file is ours to remove.
    try {
      fs.closeSync(handle);
    } catch {
      // Already closed.
    }
    fs.rmSync(file, { force: true });
    throw error;
  }
}

/**
 * Creates a missing directory and the missing ones above it, and appends each one it made to made. It stops
 * at the root of the path: a root that does not exist (a drive letter that is not there) ends in an error
 * with a plain message, not in an endless climb. The operations are a seam for the tests.
 */
export function makeMissingDirectories(
  target: string,
  made: string[],
  ops: { kindOf: (target: string) => Kind; mkdir: (target: string) => void } = { kindOf, mkdir: (dir) => void fs.mkdirSync(dir) },
): void {
  if (ops.kindOf(target) !== 'missing') {
    return;
  }
  const parent = path.dirname(target);
  if (parent === target) {
    throw new Error('the root of the path does not exist');
  }
  makeMissingDirectories(parent, made, ops);
  ops.mkdir(target);
  made.push(target);
}

// Every path that init would create and that is already taken, relative, once each, in manifest order.
function findConflicts(dir: string, targets: readonly string[]): string[] {
  const conflicts = new Set<string>();
  for (const target of targets) {
    const parts = target.split('/');
    let reachable = true;
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/');
      const kind = kindOf(absolute(dir, parent));
      if (kind === 'other') {
        conflicts.add(parent);
      }
      if (kind !== 'directory') {
        reachable = false;
        break;
      }
    }
    if (reachable && kindOf(absolute(dir, target)) !== 'missing') {
      conflicts.add(target);
    }
  }
  for (const projectDir of PROJECT_DIRS) {
    if (kindOf(absolute(dir, projectDir)) === 'other') {
      conflicts.add(projectDir);
    }
  }
  return [...conflicts];
}

// What a refresh does with one template-owned file.
type RefreshAction = 'create' | 'replace' | 'up to date';

// The files that make a directory a monitoring project, in the order they are reported.
const PROJECT_MARKERS: readonly string[] = ['package.json', 'playwright.config.ts'];

// A refresh writes the template-owned files of an existing project and nothing else. No prompt: it may
// run without a terminal, and a hand-edited .gitignore is replaced whole; the printed list is the warning.
function refreshProject(args: { dir: string | undefined }, deps: InitDeps): 0 | 1 {
  const dir = path.resolve(deps.cwd, args.dir ?? '.');

  const missing = PROJECT_MARKERS.filter((name) => {
    try {
      return !fs.lstatSync(absolute(dir, name)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    deps.print(`blw init --refresh: ${dir} is not a monitoring project: ${missing.join(' and ')} missing. Nothing was written.`);
    return 1;
  }

  // Classify every template-owned file before anything is printed or written.
  const planned: { target: string; bytes: Buffer; action: RefreshAction }[] = [];
  for (const file of TEMPLATE_FILES.filter((entry) => entry.owner === 'template')) {
    let bytes: Buffer;
    try {
      bytes = renderTemplate(file, fs.readFileSync(path.join(templatesDir(deps.packageDir), ...file.source.split('/'))), deps.version);
    } catch (error) {
      deps.print(`blw init --refresh: the templates of this core cannot be read (${reason(error)}). Nothing was written.`);
      return 1;
    }
    const target = absolute(dir, file.target);
    let action: RefreshAction;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) {
        deps.print(`blw init --refresh: ${file.target} in ${dir} is not a regular file (a directory or a link). Nothing was written.`);
        return 1;
      }
      action = fs.readFileSync(target).equals(bytes) ? 'up to date' : 'replace';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.print(`blw init --refresh: ${file.target} in ${dir} cannot be inspected (${reason(error)}). Nothing was written.`);
        return 1;
      }
      action = 'create';
    }
    planned.push({ target: file.target, bytes, action });
  }

  deps.print(`Refreshing the template files in ${dir}:`);
  for (const { target, action } of planned) {
    deps.print(`  ${action.padEnd(10)}  ${target}`);
  }

  const replace = deps.replaceFile ?? writeFileAtomic;
  let written = 0;
  for (const { target, bytes, action } of planned) {
    if (action === 'up to date') {
      continue;
    }
    try {
      replace(absolute(dir, target), bytes);
    } catch (error) {
      // Each replace is whole, so a file that was already replaced stays replaced.
      deps.print(`blw init --refresh: writing ${target} failed (${reason(error)}).`);
      return 1;
    }
    written += 1;
  }
  deps.print(`Done: ${written} written, ${planned.length - written} up to date.`);
  return 0;
}

/** Writes the project into the directory; returns 0, or 1 with one or more lines that say why. */
export function runInit(args: { dir: string | undefined; refresh: boolean }, deps: InitDeps): 0 | 1 {
  if (args.refresh) {
    return refreshProject(args, deps);
  }
  // The version names the vendored package in package.json; nothing is created for a version that cannot.
  if (!CORE_VERSION_PATTERN.test(deps.version)) {
    deps.print(
      'blw init: the version of this baselinewatch package cannot be read, so the vendored package cannot be named. Nothing was written.',
    );
    return 1;
  }
  const dir = path.resolve(deps.cwd, args.dir ?? '.');

  const rendered: { file: TemplateFile; bytes: Buffer }[] = [];
  try {
    for (const file of TEMPLATE_FILES) {
      const source = path.join(templatesDir(deps.packageDir), ...file.source.split('/'));
      rendered.push({ file, bytes: renderTemplate(file, fs.readFileSync(source), deps.version) });
    }
  } catch (error) {
    deps.print(`blw init: the templates of this core cannot be read (${reason(error)}). Nothing was written.`);
    return 1;
  }

  try {
    if (!fs.statSync(dir).isDirectory()) {
      deps.print(`blw init: ${dir} exists and is not a directory. Nothing was written.`);
      return 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.print(`blw init: ${dir} cannot be used (${reason(error)}). Nothing was written.`);
      return 1;
    }
    // The directory does not exist yet; it is created below.
  }

  const conflicts = findConflicts(
    dir,
    rendered.map(({ file }) => file.target),
  );
  if (conflicts.length > 0) {
    deps.print(`blw init: ${dir} already holds files that init would create:`);
    for (const conflict of conflicts) {
      deps.print(`  ${conflict}`);
    }
    deps.print('Nothing was written. Move these files away or choose another directory.');
    return 1;
  }

  const write = deps.writeFile ?? createFile;
  const madeFiles: string[] = [];
  const madeDirs: string[] = [];
  let writing = 'the target directory';
  const makeDirectory = (target: string): void => {
    makeMissingDirectories(target, madeDirs);
  };
  try {
    makeDirectory(dir);
    for (const { file, bytes } of rendered) {
      writing = file.target;
      const target = absolute(dir, file.target);
      makeDirectory(path.dirname(target));
      write(target, bytes);
      madeFiles.push(target);
    }
    for (const projectDir of PROJECT_DIRS) {
      writing = `${projectDir}/`;
      makeDirectory(absolute(dir, projectDir));
    }
  } catch (error) {
    // Only what this run made goes: the files first, then its directories from the deepest up, and a
    // directory that somebody else has filled meanwhile stays.
    for (const file of madeFiles.reverse()) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A file that cannot be removed stays; the line below still reports the failure.
      }
    }
    for (const made of madeDirs.reverse()) {
      try {
        fs.rmdirSync(made);
      } catch {
        // Not empty, or already gone.
      }
    }
    deps.print(`blw init: writing ${writing} failed (${reason(error)}). The files this run created were removed.`);
    return 1;
  }

  deps.print(`Created a monitoring project in ${dir}:`);
  for (const { file } of rendered) {
    deps.print(`  ${file.target}`);
  }
  for (const projectDir of PROJECT_DIRS) {
    deps.print(`  ${projectDir}/`);
  }
  deps.print('Next steps:');
  deps.print(`  1. Put baselinewatch-${deps.version}.tgz into vendor/.`);
  deps.print('  2. Copy env.example.json to env.json and fill in the account and the nodes.');
  deps.print('  3. Run npm install and commit package-lock.json.');
  return 0;
}
