// The static import graph of the command line must not reach any module that loads Playwright: the
// checks for a missing or doubled Playwright run inside the CLI, so it has to start without it.
// Run: node --test test/cli-imports.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

// Modules that import Playwright, or whose job is to run inside the Playwright process.
const FORBIDDEN_FILES = ['config.ts', 'fixture.ts', 'index.ts'].map((name) => path.join(SRC, name));
const FORBIDDEN_PACKAGES = ['@playwright/test', '@playwright/test/reporter'];

/**
 * The module specifiers a source file imports or re-exports at run time. A statement that starts with
 * `import type` or `export type` is erased by the compiler and does not count.
 */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  const statement = /^(import|export)\s+(type\s+)?([^'";]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    if (match[2] === undefined) {
      found.push(match[4] as string);
    }
  }
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
    found.push(match[1] as string);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(match[1] as string);
  }
  return found;
}

/** Follows the relative specifiers from an entry file; returns the files reached and the packages named. */
function graphFrom(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        assert.ok(specifier.endsWith('.ts'), `${path.basename(file)} imports ${specifier} without a .ts extension`);
        queue.push(path.resolve(path.dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

describe('importsOf', () => {
  test('finds plain, multi-line, re-export, bare and dynamic imports', () => {
    const source = [
      "import fs from 'node:fs';",
      'import {',
      '  a,',
      '  type B,',
      "} from './multi.ts';",
      "export { c } from './again.ts';",
      "export * from './star.ts';",
      "import './bare.ts';",
      "const lazy = await import('./lazy.ts');",
    ].join('\n');
    assert.deepEqual(importsOf(source).sort(), ['./again.ts', './bare.ts', './lazy.ts', './multi.ts', './star.ts', 'node:fs']);
  });

  test('ignores type-only imports and exports', () => {
    const source = ["import type { A } from './types.ts';", "export type { B } from './more-types.ts';"].join('\n');
    assert.deepEqual(importsOf(source), []);
  });
});

describe('the import graph of src/cli.ts', () => {
  const graph = graphFrom(path.join(SRC, 'cli.ts'));

  test('reaches the modules the command is made of', () => {
    for (const name of ['run.ts', 'process.ts', 'precheck.ts', 'outcome.ts', 'report.ts', 'csv.ts']) {
      assert.ok(graph.files.has(path.join(SRC, name)), `${name} is not reached`);
    }
  });

  test('reaches neither config.ts, fixture.ts nor index.ts', () => {
    for (const file of FORBIDDEN_FILES) {
      assert.ok(!graph.files.has(file), `${path.basename(file)} is reached from the command line`);
    }
  });

  test('names no Playwright package', () => {
    for (const name of FORBIDDEN_PACKAGES) {
      assert.ok(!graph.packages.has(name), `${name} is imported at run time`);
    }
    for (const name of graph.packages) {
      assert.ok(!name.startsWith('@playwright/') && !name.startsWith('playwright'), `${name} is imported at run time`);
    }
  });

  test('the check can fail: the package entry does reach Playwright', () => {
    const entry = graphFrom(path.join(SRC, 'index.ts'));
    assert.ok(entry.packages.has('@playwright/test'));
  });
});
