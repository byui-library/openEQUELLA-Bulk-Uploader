import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      // Security posture: the renderer gets no Node access and cannot import
      // core. It may only call what preload explicitly exposes. This is also
      // what stops the UI reaching around a safety rail.
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed (the Chromium OS-level process sandbox, independent of
      // contextIsolation/nodeIntegration -- defence in depth if the renderer
      // is ever exploited via a V8/Chromium bug). A sandboxed preload still
      // gets a polyfilled require() covering 'electron' itself, which is all
      // preload.cjs needs (contextBridge, and later ipcRenderer). Everything
      // touching the filesystem or core lives in the main process, so no
      // preload script here should ever need raw Node APIs -- if one seems
      // to, that's a sign the logic belongs in main.ts/handlers.ts instead.
      sandbox: true,
      // preload.cjs (not .js): Electron's preload loader requires CommonJS.
      // See the comment atop preload.cts for why that file uses the .cts
      // extension while the rest of the main process stays ESM.
      preload: join(here, 'preload.cjs'),
    },
  });
  void win.loadFile(join(here, 'ui', 'index.html'));
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
