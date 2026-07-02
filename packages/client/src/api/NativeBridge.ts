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
  files: NativeFile[];
}

export type ValidateServerResult = { ok: true } | { ok: false; reason: string };

/**
 * Desktop-only capabilities (spec §4.5). Lives on `window.deploykit.native`,
 * NOT on `ApiClient`. Web provides `null` (features gated on `useNative()`).
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
}
