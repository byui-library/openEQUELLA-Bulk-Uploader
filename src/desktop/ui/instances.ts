import type { InstanceChoice } from '../ipc.js';

/**
 * Hand-copied from ipc.ts's INSTANCES, not imported as a value.
 *
 * Renderer modules under ui/ may only `import type` from ipc.ts -- see the
 * Task 7 brief and the identical reasoning in preload.cts for CHANNELS: the
 * point of the boundary is that the renderer's only path to real data is
 * window.oeq, never a directly-imported main-process module, so nothing here
 * can quietly reach around the bridge.
 *
 * Ships EMPTY. BYU-Idaho's two addresses used to be hardcoded here; a tool
 * handed to other institutions must not arrive knowing them. Instances are
 * added by the operator on Setup and remembered per Windows account
 * (secrets.ts); the app reads them at startup through
 * `window.oeq.listInstances()` and keeps them in its own state, so this
 * literal is the SHIPPED list and not the whole list.
 *
 * Kept rather than deleted because it is the mechanism, not the data: it is
 * how anything ever shipped would reach the sandboxed renderer.
 * tests/desktop/ui/instances.test.ts imports the real INSTANCES (a test runs
 * under plain Node, not the sandboxed renderer, so that import is fine there)
 * and asserts this literal matches it exactly, so the two copies cannot
 * silently drift apart.
 */
export const UI_INSTANCES: InstanceChoice[] = [];
