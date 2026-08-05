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
const FORBIDDEN = /from\s+'(node:[a-z/]+|electron)'/g;
/** `import type` is erased at compile time and never reaches the browser. */
const IMPORT_LINE = /^\s*import\s+(?!type\s)(?:[\s\S]*?)\s*from\s+'(\.[^']+)'/gm;

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

    const forbidden = [...source.matchAll(FORBIDDEN)].map((m) => m[1]!);
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
