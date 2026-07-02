import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { getServerOrigin } from '../shared/config';
import { registerIpc } from './ipc';

if (squirrelStartup) {
  app.quit();
}

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

  // Open external links (deploy URLs clicked in-app) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
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

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  registerIpc({
    session: ses,
    partition: PARTITION,
    getOrigin: () => getServerOrigin(),
    getMainWindow,
    onAuthExpired: (cb) => authExpiredSubscribers.push(cb),
  });

  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
