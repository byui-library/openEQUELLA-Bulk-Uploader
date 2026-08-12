import { describe, it, expect } from 'vitest';
import { UI_INSTANCES } from '../../../src/desktop/ui/instances.js';
import { INSTANCES } from '../../../src/desktop/ipc.js';

/**
 * The renderer cannot import ipc.ts's INSTANCES as a runtime value -- per the
 * Task 7 brief, ui/*.ts may only `import type` from ipc.ts, mirroring the
 * reason preload.cts hand-copies CHANNELS instead of importing it. So
 * ui/instances.ts keeps its own copy of the shipped list. The drift tripwire
 * below stays even though both lists are empty: the mechanism is what stops
 * a future entry from being added to one copy and not the other.
 */
describe('the shipped instance list', () => {
  /**
   * A tool handed to other institutions must not arrive knowing BYU-Idaho's
   * two addresses -- or anyone else's. The list an operator sees is the one
   * they built on Setup, stored per Windows account (secrets.ts).
   */
  it('ships empty', () => {
    expect(UI_INSTANCES).toEqual([]);
    expect(INSTANCES).toEqual([]);
  });

  it('matches ipc.ts INSTANCES exactly on id, label and baseUrl', () => {
    const expected = INSTANCES.map((i) => ({ id: i.id, label: i.label, baseUrl: i.baseUrl })).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const got = [...UI_INSTANCES].sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual(expected);
  });
});
