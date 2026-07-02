import { contextBridge, ipcRenderer } from 'electron';

const SUB_ID = (() => {
  let n = 0;
  return () => `native-upload-${++n}`;
})();

contextBridge.exposeInMainWorld('deploykit', {
  api: {
    getMe: () => ipcRenderer.invoke('api:getMe'),
    login: (email: string, password: string) =>
      ipcRenderer.invoke('api:login', email, password),
    register: (input: { name: string; email: string; password: string }) =>
      ipcRenderer.invoke('api:register', input),
    logout: () => ipcRenderer.invoke('api:logout'),
    listProjects: () => ipcRenderer.invoke('api:listProjects'),
    createProject: (input: {
      name: string;
      slug: string;
      description: string;
    }) => ipcRenderer.invoke('api:createProject', input),
    updateProject: (
      id: string,
      updates: { name?: string; slug?: string; description?: string }
    ) => ipcRenderer.invoke('api:updateProject', id, updates),
    deleteProject: (id: string) => ipcRenderer.invoke('api:deleteProject', id),
    updateSettings: (
      id: string,
      settings: import('@deploykit/shared').Settings
    ) => ipcRenderer.invoke('api:updateSettings', id, settings),
    uploadVersion: () => {
      // Real uploads go through nativeUpload.* — this should not be called.
      throw new Error(
        'Use window.deploykit.nativeUpload.* for desktop uploads'
      );
    },
    publishVersion: (projectId: string, versionId: string) =>
      ipcRenderer.invoke('api:publishVersion', projectId, versionId),
    rollbackVersion: (projectId: string, versionId: string) =>
      ipcRenderer.invoke('api:rollbackVersion', projectId, versionId),
    deleteVersion: (projectId: string, versionId: string) =>
      ipcRenderer.invoke('api:deleteVersion', projectId, versionId),
  },
  native: {
    pickDirectory: () => ipcRenderer.invoke('native:pickDirectory'),
    validateServer: (url: string) =>
      ipcRenderer.invoke('native:validateServer', url),
    configureServer: (url: string) =>
      ipcRenderer.invoke('native:configureServer', url),
    getServerOrigin: () => ipcRenderer.invoke('native:getServerOrigin'),
    loginViaWeb: () => ipcRenderer.invoke('native:loginViaWeb'),
    onAuthExpired: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('native:authExpired', handler);
      return () => ipcRenderer.removeListener('native:authExpired', handler);
    },
    showNotification: (title: string, body: string) =>
      ipcRenderer.invoke('native:showNotification', title, body),
    openExternal: (url: string) =>
      ipcRenderer.invoke('native:openExternal', url),
  },
  nativeUpload: {
    uploadFolder: (
      projectId: string,
      directoryPath: string,
      description: string,
      onProgress?: (percent: number) => void
    ) => {
      const channel = SUB_ID();
      const handler = (_e: unknown, p: number) => onProgress?.(p);
      if (onProgress) ipcRenderer.on(channel, handler);
      return ipcRenderer
        .invoke(
          'nativeUpload:uploadFolder',
          projectId,
          directoryPath,
          description,
          channel
        )
        .finally(() => {
          if (onProgress) ipcRenderer.removeListener(channel, handler);
        });
    },
    uploadZipPath: (
      projectId: string,
      zipPath: string,
      description: string,
      onProgress?: (percent: number) => void
    ) => {
      const channel = SUB_ID();
      const handler = (_e: unknown, p: number) => onProgress?.(p);
      if (onProgress) ipcRenderer.on(channel, handler);
      return ipcRenderer
        .invoke(
          'nativeUpload:uploadZipPath',
          projectId,
          zipPath,
          description,
          channel
        )
        .finally(() => {
          if (onProgress) ipcRenderer.removeListener(channel, handler);
        });
    },
  },
});
