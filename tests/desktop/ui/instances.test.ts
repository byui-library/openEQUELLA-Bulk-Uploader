import { describe, it, expect } from 'vitest';
import { UI_INSTANCES } from '../../../src/desktop/ui/instances.js';
import { INSTANCES } from '../../../src/desktop/ipc.js';

/**
 * The renderer cannot import ipc.ts's INSTANCES as a runtime value -- per the
 * Task 7 brief, ui/*.ts may only `import type` from ipc.ts, mirroring the
 * reason preload.cts hand-copies CHANNELS instead of importing it. So
 * ui/instances.ts keeps its own literal copy of what the dropdown and banner
 * need (id, label, baseUrl). This test is the automated tripwire that stops
 * the two from silently drifting apart, the same role
 * preload-channels.test.ts plays for CHANNELS.
 */
describe('UI_INSTANCES', () => {
  it('matches ipc.ts INSTANCES exactly on id, label and baseUrl', () => {
    const expected = INSTANCES.map((i) => ({ id: i.id, label: i.label, baseUrl: i.baseUrl })).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const got = [...UI_INSTANCES].sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual(expected);
  });

  it('declares production and test, with production visually flagged', () => {
    const production = UI_INSTANCES.find((i) => i.id === 'production');
    expect(production).toBeDefined();
    expect(UI_INSTANCES.map((i) => i.id).sort()).toEqual(['production', 'test']);
  });
});
