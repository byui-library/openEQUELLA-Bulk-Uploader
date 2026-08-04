// This file is `.cts` (not `.ts`) so that, under `moduleResolution:
// "nodenext"` in a `"type": "module"` package, tsc emits it as CommonJS
// (`preload.cjs`) rather than ESM. Electron's preload loader does not support
// loading an ES module via `webPreferences.preload` -- only CommonJS. The
// main process itself stays ESM; only this one bridge file needs the
// CommonJS extension. See main.ts, which points `preload` at `preload.cjs`.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('oeq', {
  ping: () => 'pong',
});
