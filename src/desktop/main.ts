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
      sandbox: false, // preload needs require() for the typed bridge
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
