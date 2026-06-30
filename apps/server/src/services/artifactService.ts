import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError, ErrorCode } from '../errors';
import { getMimeType } from '../utils/mime';
import { safeJoin } from '../utils/safePath';

/** Extracts a zip archive into `destDir` using the system `tar`. */
export async function extractZip(
  zipPath: string,
  destDir: string
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn({
    cmd: ['tar', '-xf', zipPath, '-C', destDir],
    cwd: import.meta.dir,
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error('Zip extraction failed');
}

/**
 * Normalizes an extracted layout: drops macOS `__MACOSX` metadata, and if no
 * `index.html` sits at the root but exactly one subdirectory has one, hoists
 * that subdirectory's contents up a level.
 */
export function flattenOutput(dir: string): void {
  const macosx = join(dir, '__MACOSX');
  if (existsSync(macosx)) rmSync(macosx, { recursive: true, force: true });
  if (existsSync(join(dir, 'index.html'))) return;

  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (statSync(sub).isDirectory() && existsSync(join(sub, 'index.html'))) {
      for (const child of readdirSync(sub)) {
        renameSync(join(sub, child), join(dir, child));
      }
      rmSync(sub, { recursive: true, force: true });
      return;
    }
  }
}

/** Recursively sums the byte size of every file under `dirPath`. */
export function getDirectorySize(dirPath: string): number {
  let totalSize = 0;

  function calculateSize(currentPath: string) {
    const stats = statSync(currentPath);
    if (stats.isDirectory()) {
      const files = readdirSync(currentPath);
      for (const file of files) {
        calculateSize(join(currentPath, file));
      }
    } else {
      totalSize += stats.size;
    }
  }

  calculateSize(dirPath);
  return totalSize;
}

/**
 * Writes uploaded folder files into `destDir`, preserving each file's relative
 * path. Returns the total bytes written. Throws `ApiError` (400) when a path
 * exceeds `maxPathLength`, and a plain `Error` for unsafe (traversal) paths so
 * the caller can map it to a 500 — matching the original behavior.
 */
export async function writeFolderFiles(
  destDir: string,
  files: File[],
  maxPathLength?: number
): Promise<number> {
  let totalSize = 0;

  for (const f of files) {
    const relativePath = (
      (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    ).replaceAll('/', '\\');

    if (maxPathLength && relativePath.length > maxPathLength) {
      throw new ApiError(
        ErrorCode.PATH_TOO_LONG,
        `Path too long. Maximum path length is ${maxPathLength} characters.`
      );
    }

    const filePath = safeJoin(destDir, relativePath);
    if (!filePath) throw new Error(`Unsafe upload path: ${relativePath}`);
    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, f);
    totalSize += f.size;
  }

  return totalSize;
}

/**
 * Builds a static-file `Response` for an artifact path with the correct
 * content-type and cache policy (HTML is never cached; hashed assets are
 * immutable). Returns `null` when the path is not a file.
 */
export function serveArtifactFile(absolutePath: string): Response | null {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile())
    return null;

  const mimeType = getMimeType(absolutePath);
  const headers: Record<string, string> = { 'Content-Type': mimeType };

  // Cache strategy: HTML files should not be cached, other assets can be cached
  if (absolutePath.endsWith('.html')) {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  } else {
    // For hashed assets and other static files, use long cache
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }

  return new Response(Bun.file(absolutePath), { headers });
}

/** Recursively removes a directory (no-op if it does not exist). */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
