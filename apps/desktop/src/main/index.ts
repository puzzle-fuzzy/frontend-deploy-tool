import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { getServerOrigin } from '../shared/config';
import { registerIpc } from './ipc';
import { createTray, destroyTray, isQuitting } from './tray';

function ignoreBrokenPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

if (squirrelStartup) app.quit();

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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
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
