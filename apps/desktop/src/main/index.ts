import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { getServerOrigin } from '../shared/config';
import { registerIpc } from './ipc';
import { createTray, destroyTray, isQuitting, markQuitting } from './tray';

function ignoreBrokenPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

if (squirrelStartup) app.quit();

// ---- Handle Ctrl+C / terminal death ----------------------------------------

// On macOS, Electron doesn't quit on SIGINT by default (GUI app convention).
// We override this so Ctrl+C in the terminal cleanly exits the app instead of
// leaving an orphaned Electron process in the dock.
for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
  process.on(sig, () => {
    markQuitting();
    app.quit();
  });
}

// Safety net: if the parent process (electron-forge) dies unexpectedly,
// check periodically and quit so the app doesn't linger as an orphan.
(function watchParent() {
  const ppid = process.ppid;
  if (ppid <= 1) return; // Already orphaned or non-standard.
  const timer = setInterval(() => {
    try {
      // Signal 0 tests whether the process exists (no-op on the target).
      process.kill(ppid, 0);
    } catch {
      clearInterval(timer);
      markQuitting();
      app.quit();
    }
  }, 3000);
})();

// ---- Single-instance lock ------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---- App state -----------------------------------------------------------
const PARTITION = 'persist:deploykit';
let mainWindow: BrowserWindow | null = null;
const authExpiredSubscribers: Array<() => void> = [];

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload needs contextBridge; sandbox stays off until the CJS preload is
      // sandbox-compatible.
      sandbox: false,
      partition: PARTITION,
    },
  });

  win.once('ready-to-show', () => win.show());

  // In dev mode, retry loading the Vite dev server URL if it's not ready yet.
  // This handles the case where Forge starts Electron before Vite is listening,
  // or where a previous Electron process is still alive with a dead renderer.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    let attempts = 0;
    const maxAttempts = 60; // ~30 seconds
    const retryLoad = () => {
      attempts++;
      win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch(() => {
        if (attempts < maxAttempts) {
          setTimeout(retryLoad, 500);
        } else {
          console.error(
            `Failed to load dev server after ${maxAttempts} attempts`
          );
        }
      });
    };
    retryLoad();
    win.webContents.openDevTools();
  }

  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`Failed to load ${url}: ${code} ${desc}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode);
  });

  // Open external links (deploy URLs clicked in-app) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close-to-tray: hide instead of quit unless the user chose "Quit".
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  return win;
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

app
  .whenReady()
  .then(() => {
    const ses = session.fromPartition(PARTITION);
    registerIpc({
      session: ses,
      getOrigin: () => getServerOrigin(),
      getMainWindow,
      onAuthExpired: (cb) => authExpiredSubscribers.push(cb),
    });

    mainWindow = createMainWindow();
    createTray(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start app:', err);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up tray when the app is about to quit so the icon disappears promptly.
app.on('before-quit', () => {
  destroyTray();
});
