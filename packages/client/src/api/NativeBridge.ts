import type { SafeUser } from '@deploykit/shared';

/** A file picked from disk by the Electron main process. */
export interface NativeFile {
  name: string;
  size: number;
  type: string;
  /** POSIX-relative path within the picked directory, e.g. "assets/app.js". */
  webkitRelativePath: string;
  /** Absolute on-disk path; the main process reads bytes from here. */
  path: string;
}

export interface PickedDirectory {
  directoryName: string;
  /** Absolute on-disk path of the picked directory (empty in the web path). */
  directoryPath: string;
  files: NativeFile[];
}

export type ValidateServerResult = { ok: true } | { ok: false; reason: string };

/** Result shape of a version-creating upload. */
export type UploadResult = { version: { id: string; name: string } };

/**
 * Desktop-only capabilities (spec §4.5). Lives on `window.deploykit.native`,
 * NOT on `ApiClient`. Web provides `null` (features gated on `useNative()`).
 *
 * The upload methods read bytes from disk in the main process (so the
 * renderer never marshals file bytes over IPC) and report progress back via
 * `onProgress`. They live here — rather than on `ApiClient` — because they
 * take disk paths, not browser `File` objects.
 */
export interface NativeBridge {
  pickDirectory(): Promise<PickedDirectory | null>;
  /** Validates + persists a server origin. 401 from /api/me = reachable. */
  validateServer(url: string): Promise<ValidateServerResult>;
  configureServer(url: string): Promise<void>;
  /** Returns '' before onboarding completes. */
  getServerOrigin(): Promise<string>;
  /** Opens an embedded web-login window; resolves the user or null on close. */
  loginViaWeb(): Promise<SafeUser | null>;
  /** Fires when the main process sees a 401 mid-session. Returns unsubscribe. */
  onAuthExpired(cb: () => void): () => void;
  /** Upload a whole directory tree (read from disk) as a new version. */
  uploadFolder(
    projectId: string,
    directoryPath: string,
    description: string,
    onProgress?: (percent: number) => void
  ): Promise<UploadResult>;
  /** Upload a single zip file (read from disk) as a new version. */
  uploadZipPath(
    projectId: string,
    zipPath: string,
    description: string,
    onProgress?: (percent: number) => void
  ): Promise<UploadResult>;
  /** Show a system notification (OS notification center / tray balloon). */
  showNotification(title: string, body: string): void;
  /** Open a URL in the system default browser. */
  openExternal(url: string): Promise<void>;
}
