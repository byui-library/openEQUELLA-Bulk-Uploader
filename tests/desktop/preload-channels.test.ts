import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '../../src/desktop/ipc.js';

/**
 * preload.cts cannot import CHANNELS as a runtime value from ipc.ts -- with
 * `sandbox: true` (main.ts), Electron's sandboxed preload loader cannot
 * resolve a `require()` of a local project file (confirmed live: it throws
 * "module not found: ./ipc.js" and silently aborts the whole preload
 * script). So preload.cts keeps its own hand-written copy of the channel
 * name strings. This test is the "automated check tying the two together"
 * that preload.cts's comment says doesn't exist at the type level -- it
 * reads preload.cts as plain text and confirms every 'oeq:...' string
 * literal in it is exactly the set of values in ipc.ts's CHANNELS, so the
 * two can't silently drift apart.
 */
describe('preload.cts channel literals', () => {
  it('match ipc.ts CHANNELS exactly, with none missing or extra', async () => {
    const preloadPath = fileURLToPath(new URL('../../src/desktop/preload.cts', import.meta.url));
    const source = await readFile(preloadPath, 'utf8');
    const found = [...source.matchAll(/'oeq:[a-zA-Z]+'/g)].map((m) => m[0].slice(1, -1));
    const foundUnique = [...new Set(found)].sort();
    const expected = [...Object.values(CHANNELS)].sort();
    expect(foundUnique).toEqual(expected);
  });
});
