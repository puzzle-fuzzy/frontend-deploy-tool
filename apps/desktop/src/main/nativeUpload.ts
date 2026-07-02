import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import type { NativeFile, PickedDirectory } from '@deploykit/client';
import { type BrowserWindow, dialog, type Session } from 'electron';
import { serverRequest } from './serverRequest';

/**
 * Mirror of the server's upload defaults (`apps/server/src/config.ts`: 100MB
 * extracted/zip, 1000 files, 1000 path chars). The server may be configured
 * tighter via its MAX_* env; preflight is a best-effort client check so we
 * fail fast before sending bytes. If the server runs tighter limits it still
 * rejects with a clear FILES_TOO_LARGE / TOO_MANY_FILES / PATH_TOO_LONG
 * message after the upload.
 */
export const LIMITS = {
  maxExtractedSize: 100 * 1024 * 1024, // 100 MB
  maxFileCount: 1000,
  maxPathLength: 1000,
  maxZipSize: 100 * 1024 * 1024, // 100 MB
};

// Matches the Content-Type the transport sets for multipart bodies. Kept in
// sync with `serverRequest.ts`; not parsed here.
const MULTI_PART_BOUNDARY = '----deploykit';

export interface PreflightError {
  reason: string;
}

function guessType(name: string): string {
  if (name.endsWith('.html')) return 'text/html';
  if (name.endsWith('.js')) return 'text/javascript';
  if (name.endsWith('.css')) return 'text/css';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Recursively reads a directory, returning NativeFile entries with POSIX
 * relative paths rooted at the picked directory (e.g. "assets/app.js"). The
 * server's `writeFolderFiles` uses `webkitRelativePath || name`, normalizes
 * `\`→`/` and strips a leading `/`, so we must emit forward-slash paths with
 * no leading slash.
 */
export async function collectDirectory(
  directoryPath: string
): Promise<NativeFile[]> {
  const result: NativeFile[] = [];

  async function walk(absDir: string) {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const st = await stat(abs);
        const rel = relative(directoryPath, abs).split(sep).join(posix.sep);
        result.push({
          name: entry.name,
          size: st.size,
          type: guessType(entry.name),
          webkitRelativePath: rel,
          path: abs,
        });
      }
    }
  }

  await walk(directoryPath);
  return result;
}

/**
 * Client-side validation against `LIMITS`. Returns null when the upload is
 * acceptable, otherwise a human-readable reason. Used to fail fast before
 * reading bytes from disk / sending them over the wire.
 */
export function preflight(
  files: NativeFile[],
  limits: typeof LIMITS = LIMITS
): PreflightError | null {
  if (files.length > limits.maxFileCount) {
    return {
      reason: `Too many files: ${files.length} (max ${limits.maxFileCount}).`,
    };
  }
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (f.webkitRelativePath.length > limits.maxPathLength) {
      return {
        reason: `Path too long: ${f.webkitRelativePath} (max ${limits.maxPathLength} chars).`,
      };
    }
  }
  if (total > limits.maxExtractedSize) {
    return {
      reason: `Total size too large: ${total} bytes (max ${limits.maxExtractedSize}).`,
    };
  }
  return null;
}

/**
 * Streams a folder upload: collects + preflights the directory, then composes
 * the full multipart body in order (reading file bytes from disk as it goes)
 * and posts it with progress reporting.
 */
export async function uploadFolder(
  ses: Session,
  origin: string,
  projectId: string,
  directoryPath: string,
  description: string,
  onProgress?: (percent: number) => void
): Promise<{ version: { id: string; name: string } }> {
  const files = await collectDirectory(directoryPath);
  const err = preflight(files);
  if (err) throw new Error(err.reason);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const f of files) {
    const header = Buffer.from(
      `--${MULTI_PART_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="folderFiles"; filename="${f.webkitRelativePath}"\r\n` +
        `Content-Type: ${f.type}\r\n\r\n`,
      'utf8'
    );
    const data = await readFile(f.path);
    const tail = Buffer.from('\r\n', 'utf8');
    chunks.push(header, data, tail);
    totalBytes += header.length + data.length + tail.length;
  }
  const desc = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="versionDesc"\r\n\r\n` +
      `${description}\r\n` +
      `--${MULTI_PART_BOUNDARY}--\r\n`,
    'utf8'
  );
  chunks.push(desc);
  totalBytes += desc.length;

  const r = await serverRequest<{ version: { id: string; name: string } }>(
    ses,
    origin,
    {
      method: 'POST',
      path: `/api/projects/${projectId}/versions`,
      multipart: { chunks, totalBytes },
      onProgress,
    }
  );
  return r.data;
}

/**
 * Uploads a single zip file from disk as a new version.
 */
export async function uploadZipPath(
  ses: Session,
  origin: string,
  projectId: string,
  zipPath: string,
  description: string,
  onProgress?: (percent: number) => void
): Promise<{ version: { id: string; name: string } }> {
  const data = await readFile(zipPath);
  if (data.byteLength > LIMITS.maxZipSize) {
    throw new Error(
      `Zip too large: ${data.byteLength} bytes (max ${LIMITS.maxZipSize}).`
    );
  }
  const header = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${zipPath.split(/[\\/]/).pop()}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from('\r\n', 'utf8');
  const desc = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="versionDesc"\r\n\r\n` +
      `${description}\r\n` +
      `--${MULTI_PART_BOUNDARY}--\r\n`,
    'utf8'
  );
  const totalBytes = header.length + data.length + tail.length + desc.length;

  const r = await serverRequest<{ version: { id: string; name: string } }>(
    ses,
    origin,
    {
      method: 'POST',
      path: `/api/projects/${projectId}/versions`,
      multipart: { chunks: [header, data, tail, desc], totalBytes },
      onProgress,
    }
  );
  return r.data;
}

/**
 * Shows the native directory picker and, on confirm, collects the directory
 * into NativeFile entries. Returns null when the user cancels.
 */
export async function pickDirectory(
  parent: BrowserWindow
): Promise<PickedDirectory | null> {
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const directoryPath = result.filePaths[0];
  const files = await collectDirectory(directoryPath);
  const directoryName = directoryPath.split(/[\\/]/).pop() || directoryPath;
  return { directoryName, directoryPath, files };
}
