import type { InstanceChoice } from '../ipc.js';

/**
 * Hand-copied from ipc.ts's INSTANCES, not imported as a value.
 *
 * Renderer modules under ui/ may only `import type` from ipc.ts -- see the
 * Task 7 brief and the identical reasoning in preload.cts for CHANNELS: the
 * point of the boundary is that the renderer's only path to real data is
 * window.oeq, never a directly-imported main-process module, so nothing here
 * can quietly reach around the bridge. Only the fields the UI actually
 * displays for the instance PICKER are copied here. `redirectUri` is not
 * one of them -- it no longer lives on `InstanceChoice` at all (see ipc.ts):
 * it is per-instance STORED CONFIGURATION now (secrets.ts), collected and
 * shown on the Setup screen itself, not the instance dropdown.
 *
 * Guarded by tests/desktop/ui/instances.test.ts, which imports the real
 * INSTANCES (a test runs under plain Node, not the sandboxed renderer, so
 * that import is fine there) and asserts this literal matches it exactly, so
 * the two copies cannot silently drift apart.
 */
export const UI_INSTANCES: Pick<InstanceChoice, 'id' | 'label' | 'baseUrl'>[] = [
  { id: 'production', label: 'Production', baseUrl: 'https://content.byui.edu' },
  { id: 'test', label: 'Test', baseUrl: 'https://content-test.byui.edu' },
];
