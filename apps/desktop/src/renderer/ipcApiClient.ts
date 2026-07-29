import type {
  ApiClient,
  UploadableFile,
  UploadProgress,
} from '@deploykit/client';
import { ApiClientError } from '@deploykit/client/errors';
import type { IpcResult } from '../shared/ipcResult';

export async function unwrapIpcResult<T>(
  promise: Promise<IpcResult<T>>
): Promise<T> {
  const result = await promise;
  if (result.ok) return result.data;
  throw new ApiClientError(
    result.error.message,
    result.error.status,
    result.error.code,
    result.error.requestId
  );
}

export function createIpcApiClient(): ApiClient {
  const bridge = window.deploykit;
  return {
    getMe: () => unwrapIpcResult(bridge.api.getMe()),
    login: (email, password) =>
      unwrapIpcResult(bridge.api.login(email, password)),
    register: (input) => unwrapIpcResult(bridge.api.register(input)),
    logout: () => unwrapIpcResult(bridge.api.logout()),
    listProjects: () => unwrapIpcResult(bridge.api.listProjects()),
    createProject: (input) => unwrapIpcResult(bridge.api.createProject(input)),
    updateProject: (id, updates) =>
      unwrapIpcResult(bridge.api.updateProject(id, updates)),
    deleteProject: (id) => unwrapIpcResult(bridge.api.deleteProject(id)),
    updateSettings: (id, settings) =>
      unwrapIpcResult(bridge.api.updateSettings(id, settings)),
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
    publishVersion: (projectId, versionId, expectedActiveVersionId) =>
      unwrapIpcResult(
        bridge.api.publishVersion(projectId, versionId, expectedActiveVersionId)
      ),
    rollbackVersion: (projectId, versionId, expectedActiveVersionId) =>
      unwrapIpcResult(
        bridge.api.rollbackVersion(
          projectId,
          versionId,
          expectedActiveVersionId
        )
      ),
    deleteVersion: (projectId, versionId) =>
      unwrapIpcResult(bridge.api.deleteVersion(projectId, versionId)),
    listProjectHistory: (projectId, query) =>
      unwrapIpcResult(bridge.api.listProjectHistory(projectId, query)),
    searchUsers: (projectId, query) =>
      unwrapIpcResult(bridge.api.searchUsers(projectId, query)),
    addMember: (projectId, email, role) =>
      unwrapIpcResult(bridge.api.addMember(projectId, email, role)),
    removeMember: (projectId, userId) =>
      unwrapIpcResult(bridge.api.removeMember(projectId, userId)),
    transferOwnership: (projectId, targetUserId) =>
      unwrapIpcResult(bridge.api.transferOwnership(projectId, targetUserId)),
  };
}
