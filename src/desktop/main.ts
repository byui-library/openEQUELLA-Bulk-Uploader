import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHandlers } from './handlers.js';
import { registerQuitLogout } from './quit.js';

const here = dirname(fileURLToPath(import.meta.url));

// Tracked so registerHandlers' getWindow() callback (and the run handler's
// progress events) can always reach the current window, including after
// window-all-closed on non-mac platforms tears one down and 'activate'
// creates a new one.
let mainWindow: BrowserWindow | null = null;

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
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // The Results screen's "open collection" link is a plain
  // <a target="_blank">. Without this handler Electron would honour that by
  // opening a second, chromeless BrowserWindow -- a dead end for a
  // non-technical user, since it has no address bar, back button, or way to
  // get back to the app. Hand off to the OS browser instead and always deny
  // the new Electron window.
  //
  // Restricted to http/https deliberately: `url` here is whatever the page
  // asked to open, and openEQUELLA content (collection names, item text) is
  // server-controlled. Handing an arbitrary scheme (file:, javascript:, a
  // custom protocol) straight to shell.openExternal / the OS shell can launch
  // other installed applications or touch the filesystem. http/https to
  // shell.openExternal only ever opens the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // setWindowOpenHandler above only covers a NEW window. Nothing stops the
  // main window's own frame being navigated away, and the CSP in index.html
  // does not govern top-level navigation. This app has no address bar and no
  // back button, so a same-window navigation away from ui/index.html would
  // strand a non-technical user with no way back. Today the only external
  // link uses target="_blank" and correctly routes through
  // setWindowOpenHandler, but that's a convention, not a rail: a future
  // same-window `<a href>` without target="_blank", or a stray
  // `window.location` assignment, would sail straight through without this.
  //
  // Blanket-deny is safe here (rather than allow-listing the app's own URL)
  // because this app's screen routing is entirely client-side DOM
  // manipulation in app.ts -- there is no legitimate reason for this
  // window's frame to navigate anywhere, ever, after its initial load.
  // That initial load is itself unaffected: `will-navigate` fires only for
  // navigation requested by the page or user (a clicked link,
  // `window.location`), never for the main process's own
  // `webContents.loadURL`/`loadFile` calls, so `win.loadFile` below does not
  // trigger this handler and is not blocked by it.
  //
  // The sign-in popup in signin.ts is a separate BrowserWindow with its own
  // `will-navigate` listener -- that one is a passive inspector used to
  // capture the OAuth `?code=`, not a guard, and must keep letting
  // navigation through. Do not touch it from here.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  void win.loadFile(join(here, 'ui', 'index.html'));
}

void app.whenReady().then(() => {
  // Registered once, globally -- ipcMain.handle throws on a second
  // registration for the same channel, and createWindow() can run again
  // later (see 'activate' below), so this must not live inside it.
  registerHandlers(ipcMain, () => mainWindow);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// A session established during a run would otherwise outlive the app, staying
// live on the server until openEQUELLA times it out. Registered at module
// scope, not inside whenReady(), so a quit that arrives before the app has
// finished starting is still covered. See quit.ts for why this cannot simply
// `await` in a listener, and why the wait is bounded.
registerQuitLogout(app);
