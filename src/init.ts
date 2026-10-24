// `blw init`: writes a monitoring project from the templates of the running core. The manifest decides
// which template becomes which file and who owns it afterwards; dotfiles are stored without the dot
// because npm pack drops them. Files are copied byte for byte, read and written as buffers, so the
// launcher keeps its CRLF line ends; the only text that changes is the version token in package.json.
// This module uses node:fs and node:path only: nothing from Playwright and nothing from the run module.
// Everything it needs from outside comes in through InitDeps.
import fs from 'node:fs';
import path from 'node:path';

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
  /** Writes one new file; the default creates it exclusively and fails when the path exists. */
  writeFile?: (file: string, bytes: Uint8Array) => void;
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

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

const absolute = (dir: string, relative: string): string => path.join(dir, ...relative.split('/'));

/** Writes the project into the directory; returns 0, or 1 with one or more lines that say why. */
export function runInit(args: { dir: string | undefined }, deps: InitDeps): 0 | 1 {
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
  } catch {
    // The directory does not exist yet; it is created below.
  }

  const conflicts = rendered.filter(({ file }) => exists(absolute(dir, file.target))).map(({ file }) => file.target);
  if (conflicts.length > 0) {
    deps.print(`blw init: ${dir} already holds files that init would create:`);
    for (const conflict of conflicts) {
      deps.print(`  ${conflict}`);
    }
    deps.print('Nothing was written. Move these files away or choose another directory.');
    return 1;
  }

  const write = deps.writeFile ?? ((file: string, bytes: Uint8Array): void => fs.writeFileSync(file, bytes, { flag: 'wx' }));
  fs.mkdirSync(dir, { recursive: true });
  for (const { file, bytes } of rendered) {
    const target = absolute(dir, file.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    write(target, bytes);
  }
  for (const projectDir of PROJECT_DIRS) {
    fs.mkdirSync(absolute(dir, projectDir), { recursive: true });
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
