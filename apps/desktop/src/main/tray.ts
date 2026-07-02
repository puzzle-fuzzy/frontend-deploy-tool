import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron';

const TRAY_ICON_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="7" fill="#22c55e"/>
      <path d="M4.5 8l2.5 2.5 4.5-4.5" stroke="white" stroke-width="1.5"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
)}`;

let tray: Tray | null = null;
let _isQuitting = false;

/** Whether the app is intentionally quitting (vs closing-to-tray). */
export function isQuitting(): boolean {
  return _isQuitting;
}

/** Mark the app as intentionally quitting (triggers real exit on window close). */
export function markQuitting(): void {
  _isQuitting = true;
}

/** Create the system tray icon and context menu. */
export function createTray(mainWindow: BrowserWindow): Tray {
  destroyTray();

  const icon = nativeImage.createFromDataURL(TRAY_ICON_SVG);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show DeployKit',
      click: () => {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        markQuitting();
        app.quit();
      },
    },
  ]);

  tray.setToolTip('DeployKit');
  tray.setContextMenu(contextMenu);

  // Double-click shows the window (Windows convention).
  tray.on('double-click', () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

/** Destroy the tray (e.g. on logout / server switch). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
