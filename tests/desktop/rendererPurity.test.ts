// tests/desktop/rendererPurity.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

/**
 * The renderer is sandboxed with no Node integration, so it cannot import
 * `node:*` or `electron`. When it tries, the failure is brutal and silent:
 * the whole module graph fails to load, the window opens, renders nothing,
 * and prints nothing to the terminal. A blank white rectangle.
 *
 * This actually happened. `ui/extract/controller.ts` imported `starterProfile`
 * from `core/extract/suggest.ts`, which reaches `node:path` and -- through
 * `readers/index.ts` -- `node:fs/promises` and pdf.js. Every one of 590 tests
 * passed, because vitest runs in Node where those imports resolve perfectly
 * well. Only launching the app revealed it.
 *
 * So this test walks the renderer's real import graph from its entry point and
 * fails if anything reachable touches Node or Electron. It reads the TypeScript
 * sources rather than the build output, so it works without a build step and
 * points at the file a developer would actually edit.
 */

const ENTRY = 'src/desktop/ui/app.ts';

/**
 * Every module specifier a file loads AT RUNTIME, however it asks for it.
 *
 * THE OLD PATTERN WAS `from '(node:...|electron)'` AND SAW ONLY TWO SHAPES.
 * It missed a side-effect import (`import 'node:fs'`), a dynamic one
 * (`await import('node:fs')`), a `require()`, and -- the one that matters now
 * -- EVERY BARE PACKAGE SPECIFIER. The renderer's graph reaches into
 * `src/core/ai/`, which is exactly where an `openai`, `undici` or `zod` import
 * would land, and any of them blanks the window just as thoroughly as
 * `node:fs` while this guard stayed green.
 *
 * So the rule is inverted: collect every specifier and flag anything that is
 * not relative. The renderer has no bundler and no module resolution beyond
 * what the browser does with a relative path, so "not relative" IS the fault --
 * there is nothing to argue about per-package.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*'([^']+)'/g;

/**
 * A line whose imports are erased at compile time and never reach the browser.
 * `import type ...` and `export type ... from ...`; an inline `{ type Foo }`
 * inside a value import is NOT erased as a whole and is deliberately not
 * matched here.
 */
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s/;

/**
 * A comment line, which cannot import anything.
 *
 * Needed because prose says things like *"Distinct from 'editSettings'"*, and
 * a scan for `from '...'` reads that as a module specifier -- which it did, on
 * the first run of the widened rule. Excluding whole comment lines cannot hide
 * a real import: a statement that actually executes starts with `import`,
 * `export` or an expression, never with `//` or `*`, so a trailing comment on a
 * live import line is still scanned.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** `import type` is erased at compile time and never reaches the browser. */
const IMPORT_LINE = /^\s*import\s+(?!type\s)(?:[\s\S]*?)\s*from\s+'(\.[^']+)'/gm;

/** Every runtime specifier in a source file that is not a relative path. */
function bareSpecifiers(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !TYPE_ONLY.test(line) && !COMMENT_LINE.test(line))
    .flatMap((line) => [...line.matchAll(SPECIFIER)].map((m) => m[1]!))
    .filter((spec) => !spec.startsWith('.') && !spec.startsWith('/'));
}

async function readSource(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Resolve a `./x.js` specifier back to the `.ts` file it was compiled from. */
function toSourcePath(fromFile: string, specifier: string): string {
  return resolve(dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
}

interface Offence {
  file: string;
  imports: string[];
}

async function walk(entry: string): Promise<Offence[]> {
  const seen = new Set<string>();
  const offences: Offence[] = [];
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = await readSource(file);
    if (source === null) continue;

    const forbidden = bareSpecifiers(source);
    if (forbidden.length > 0) {
      offences.push({ file: relative(process.cwd(), file).replace(/\\/g, '/'), imports: [...new Set(forbidden)] });
    }

    for (const match of source.matchAll(IMPORT_LINE)) {
      queue.push(toSourcePath(file, match[1]!));
    }
  }

  return offences;
}

describe('renderer purity', () => {
  it('reaches no node: or electron import from the UI entry point', async () => {
    const offences = await walk(ENTRY);
    const detail = offences.map((o) => `  ${o.file} imports ${o.imports.join(', ')}`).join('\n');
    expect(offences, `The renderer has no Node access. These would blank the window:\n${detail}`).toEqual([]);
  });

  it('actually inspects a real graph rather than silently finding nothing', async () => {
    // Guards the guard. A typo in the entry path, or a regex that matches
    // nothing, would make the test above pass vacuously forever.
    const source = await readSource(resolve(ENTRY));
    expect(source).not.toBeNull();
    expect([...source!.matchAll(IMPORT_LINE)].length).toBeGreaterThan(5);
  });

  it('catches a forbidden import when one exists', async () => {
    // Proves the detection works, using a file known to import node: on purpose.
    const offences = await walk('src/desktop/extractHandlers.ts');
    expect(offences.length).toBeGreaterThan(0);
  });
});

/**
 * The detector itself, against the shapes the old pattern could not see.
 *
 * `from '(node:...|electron)'` matched exactly two spellings. Every case below
 * blanks the window just as completely, and four of them were invisible -- most
 * importantly ANY BARE PACKAGE, now that the renderer's graph reaches
 * `src/core/ai/`, which is precisely where an `openai` or `undici` dependency
 * would be added.
 */
describe('what counts as a forbidden import', () => {
  it.each([
    ['a plain node import', "import { readFile } from 'node:fs/promises';"],
    ['a side-effect import', "import 'node:fs';"],
    ['a dynamic import', "const fs = await import('node:fs');"],
    ['a require', "const fs = require('node:fs');"],
    ['electron', "import { app } from 'electron';"],
    ['a bare package', "import OpenAI from 'openai';"],
    ['a scoped package', "import { x } from '@anthropic-ai/sdk';"],
    ['a re-export', "export { x } from 'undici';"],
  ])('flags %s', (_label, source) => {
    expect(bareSpecifiers(source)).not.toEqual([]);
  });

  it.each([
    ['a relative import', "import { x } from './dom.js';"],
    ['a parent import', "import { x } from '../../core/ai/endpoint.js';"],
    ['a type-only import, erased at compile time', "import type { Settings } from '../secrets.js';"],
    ['a type-only import of electron itself', "import type { IpcMain } from 'electron';"],
    ['a type-only re-export', "export type { Foo } from 'electron';"],
    ['prose that happens to say from', "  // Distinct from 'editSettings': this is something else"],
    ['a docblock line', "   * Distinct from 'editSettings', which app.ts owns"],
  ])('does not flag %s', (_label, source) => {
    expect(bareSpecifiers(source)).toEqual([]);
  });

  /** A comment cannot hide a live import: the statement still starts the line. */
  it('still flags an import that carries a trailing comment', () => {
    expect(bareSpecifiers("import OpenAI from 'openai'; // the gateway")).toEqual(['openai']);
  });
});
