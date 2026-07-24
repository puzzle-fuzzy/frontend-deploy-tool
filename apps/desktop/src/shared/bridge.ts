import type {
  ApiClient,
  NativeFile,
  PickedDirectory,
  ValidateServerResult,
} from '@deploykit/client';
import type { SafeUser } from '@deploykit/shared';
import type { IpcResult } from './ipcResult';

type IpcMethod<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<IpcResult<Awaited<Result>>>
  : never;

type DesktopApiBridge = {
  [Key in keyof ApiClient]: IpcMethod<ApiClient[Key]>;
};

/**
 * The shape exposed on `window.deploykit` by the preload script. `api` mirrors
 * `ApiClient` over IPC; `native` carries desktop-only capabilities (spec §4.5).
 */
export interface DesktopBridge {
  api: DesktopApiBridge;
  native: {
    pickDirectory(): Promise<PickedDirectory | null>;
    validateServer(url: string): Promise<ValidateServerResult>;
    configureServer(url: string): Promise<void>;
    getServerOrigin(): Promise<string>;
    loginViaWeb(): Promise<SafeUser | null>;
    onAuthExpired(cb: () => void): () => void;
    showNotification(title: string, body: string): void;
    openExternal(url: string): Promise<void>;
  };
  /** Internal: upload by absolute disk path, reporting progress over IPC. */
  nativeUpload: {
    uploadFolder(
      projectId: string,
      directoryPath: string,
      description: string,
      onProgress?: (percent: number) => void
    ): Promise<IpcResult<{ version: { id: string; name: string } }>>;
    uploadZipPath(
      projectId: string,
      zipPath: string,
      description: string,
      onProgress?: (percent: number) => void
    ): Promise<IpcResult<{ version: { id: string; name: string } }>>;
  };
}

/** Native files are also surfaced to the renderer through `nativeUpload`. */
export type { NativeFile, PickedDirectory, ValidateServerResult };

declare global {
  interface Window {
    deploykit: DesktopBridge;
  }
}
