import type {
  ApiClient,
  UploadableFile,
  UploadProgress,
} from '@deploykit/client';

export function createIpcApiClient(): ApiClient {
  const bridge = window.deploykit;
  return {
    getMe: () => bridge.api.getMe(),
    login: (email, password) => bridge.api.login(email, password),
    logout: () => bridge.api.logout(),
    listProjects: () => bridge.api.listProjects(),
    createProject: (input) => bridge.api.createProject(input),
    updateProject: (id, updates) => bridge.api.updateProject(id, updates),
    deleteProject: (id) => bridge.api.deleteProject(id),
    updateSettings: (id, settings) => bridge.api.updateSettings(id, settings),
    uploadVersion: (
      _projectId: string,
      _file: UploadableFile | null,
      _folderFiles: UploadableFile[] | null,
      _description: string,
      _onProgress?: UploadProgress
    ) => {
      // Desktop overrides the upload path at the call site (Task 8 wires
      // UploadVersionDialog to detect a native bridge and call nativeUpload).
      throw new Error(
        'Desktop uploads must go through window.deploykit.nativeUpload.*'
      );
    },
    publishVersion: (projectId, versionId) =>
      bridge.api.publishVersion(projectId, versionId),
    rollbackVersion: (projectId, versionId) =>
      bridge.api.rollbackVersion(projectId, versionId),
    deleteVersion: (projectId, versionId) =>
      bridge.api.deleteVersion(projectId, versionId),
  };
}
