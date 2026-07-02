import {
  type BrowserWindow,
  ipcMain,
  Notification,
  type Session,
  shell,
} from 'electron';
import {
  clearServerOrigin,
  getServerOrigin,
  normalizeOrigin,
  setServerOrigin,
} from '../shared/config';
import { getMe, login, loginViaWeb, logout, validateServer } from './auth';
import { pickDirectory, uploadFolder, uploadZipPath } from './nativeUpload';
import { serverRequest } from './serverRequest';

/**
 * Registers all `window.deploykit.*` handlers. `getMainWindow` is a thunk
 * because the window may be recreated (e.g. after a server switch).
 */
export function registerIpc(deps: {
  session: Session;
  partition: string;
  getOrigin: () => string;
  getMainWindow: () => BrowserWindow | null;
  onAuthExpired: (cb: () => void) => void;
}) {
  const { session, partition, getOrigin, getMainWindow, onAuthExpired } = deps;

  // ---- API methods (mirror ApiClient over IPC) -------------------------------
  ipcMain.handle('api:getMe', async () => getMe(session, getOrigin()));
  ipcMain.handle('api:login', async (_e, email: string, password: string) =>
    login(session, getOrigin(), email, password)
  );
  ipcMain.handle('api:logout', async () => logout(session, getOrigin()));
  ipcMain.handle('api:listProjects', async () => {
    const r = await serverRequest<unknown[]>(session, getOrigin(), {
      method: 'GET',
      path: '/api/projects',
    });
    return r.data;
  });
  ipcMain.handle('api:createProject', async (_e, input) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'POST',
      path: '/api/projects',
      body: input,
    });
    return r.data;
  });
  ipcMain.handle('api:updateProject', async (_e, id: string, updates) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'PATCH',
      path: `/api/projects/${id}`,
      body: updates,
    });
    return r.data;
  });
  ipcMain.handle('api:deleteProject', async (_e, id: string) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'DELETE',
      path: `/api/projects/${id}`,
    });
    return r.data;
  });
  ipcMain.handle('api:updateSettings', async (_e, id: string, settings) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'PATCH',
      path: `/api/projects/${id}/settings`,
      body: settings,
    });
    return r.data;
  });
  ipcMain.handle(
    'api:publishVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'POST',
        path: `/api/projects/${projectId}/versions/${versionId}/publish`,
      });
      return r.data;
    }
  );
  ipcMain.handle(
    'api:rollbackVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'POST',
        path: `/api/projects/${projectId}/versions/${versionId}/rollback`,
      });
      return r.data;
    }
  );
  ipcMain.handle(
    'api:deleteVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'DELETE',
        path: `/api/projects/${projectId}/versions/${versionId}`,
      });
      return r.data;
    }
  );
  // api:uploadVersion is NOT registered here — uploads go through nativeUpload
  // (nativeUpload.uploadFolder / uploadZipPath) since they read bytes from disk.

  // ---- Native methods --------------------------------------------------------
  ipcMain.handle('native:pickDirectory', async () => {
    const parent = getMainWindow();
    return parent ? pickDirectory(parent) : null;
  });
  ipcMain.handle('native:validateServer', async (_e, url: string) =>
    validateServer(session, normalizeOrigin(url))
  );
  ipcMain.handle('native:configureServer', async (_e, url: string) => {
    clearServerOrigin();
    setServerOrigin(url);
  });
  ipcMain.handle('native:getServerOrigin', async () => getServerOrigin());
  ipcMain.handle('native:loginViaWeb', async () => {
    const parent = getMainWindow();
    return parent ? loginViaWeb(session, partition, getOrigin(), parent) : null;
  });
  ipcMain.on('native:onAuthExpiredSubscribe', (e) => {
    onAuthExpired(() => e.sender.send('native:authExpired'));
  });
  ipcMain.handle(
    'native:showNotification',
    async (_e, title: string, body: string) => {
      const n = new Notification({ title, body });
      n.show();
    }
  );
  ipcMain.handle('native:openExternal', async (_e, url: string) => {
    await shell.openExternal(url);
  });

  // ---- Native upload (disk-backed) ------------------------------------------
  ipcMain.handle(
    'nativeUpload:uploadFolder',
    async (
      _e,
      projectId: string,
      directoryPath: string,
      description: string,
      // progress is delivered via webContents.send below; this is the channel
      progressChannel: string
    ) => {
      const win = getMainWindow();
      return uploadFolder(
        session,
        getOrigin(),
        projectId,
        directoryPath,
        description,
        win ? (p) => win.webContents.send(progressChannel, p) : undefined
      );
    }
  );
  ipcMain.handle(
    'nativeUpload:uploadZipPath',
    async (
      _e,
      projectId: string,
      zipPath: string,
      description: string,
      progressChannel: string
    ) => {
      const win = getMainWindow();
      return uploadZipPath(
        session,
        getOrigin(),
        projectId,
        zipPath,
        description,
        win ? (p) => win.webContents.send(progressChannel, p) : undefined
      );
    }
  );
}
