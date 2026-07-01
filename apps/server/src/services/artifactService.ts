import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { unzip } from 'fflate';
import { matchBlockedPath } from '../domain/uploadSafety';
import { ApiError, ErrorCode } from '../errors';
import { getMimeType } from '../utils/mime';
import { safeJoin } from '../utils/safePath';

/**
 * OS-generated metadata that is never part of a real build artifact. Skipped
 * during extraction/upload so deployed sites stay clean.
 */
const SYSTEM_METADATA = new Set([
  '.DS_Store',
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
]);

/** True for entries that are OS metadata (e.g. `.DS_Store`, `__MACOSX/...`, `._cache`). */
function isSystemMetadata(relativePath: string): boolean {
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (SYSTEM_METADATA.has(segment)) return true;
    if (segment.startsWith('._')) return true; // macOS AppleDouble resource forks
  }
  return false;
}

/**
 * Extracts a zip archive into `destDir` using a pure-JS decoder (no shell-out
 * to `tar`, which can't read zips on GNU tar and would create symlinks). Each
 * entry is validated with `safeJoin` (rejecting absolute/`..` traversal) before
 * writing, and OS metadata entries are skipped. Symlinks cannot be created
 * because only file bytes are written.
 */
export async function extractZip(
  zipPath: string,
  destDir: string
): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  const entries = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(new Uint8Array(readFileSync(zipPath)), (err, data) => {
        if (err) reject(new Error('Zip extraction failed'));
        else resolve(data);
      });
    }
  );

  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (entryPath.endsWith('/') || isSystemMetadata(entryPath)) continue; // directory marker or junk
    const reason = matchBlockedPath(entryPath);
    if (reason) {
      throw new ApiError(
        ErrorCode.BLOCKED_FILE,
        `Upload rejected: "${entryPath}" is blocked (${reason}). Remove it and upload again.`,
        400
      );
    }
    const target = safeJoin(destDir, entryPath);
    if (!target) throw new Error(`Unsafe zip entry: ${entryPath}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
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

/** True when an `index.html` exists at the root of `dir`. */
export function hasRootIndexHtml(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
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

/** Recursively counts every file under `dirPath`. */
export function countFiles(dirPath: string): number {
  let count = 0;

  function walk(currentPath: string) {
    const stats = statSync(currentPath);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(currentPath)) {
        walk(join(currentPath, entry));
      }
    } else {
      count++;
    }
  }

  walk(dirPath);
  return count;
}

/**
 * Writes uploaded folder files into `destDir`, preserving each file's relative
 * directory structure. Returns the total bytes written. OS metadata entries are
 * skipped. Throws `ApiError` (400) when a path exceeds `maxPathLength`, and a
 * plain `Error` for unsafe (traversal) paths so the caller can map it to a 500.
 */
export async function writeFolderFiles(
  destDir: string,
  files: File[],
  maxPathLength?: number
): Promise<number> {
  let totalSize = 0;

  for (const f of files) {
    const rawPath = f.webkitRelativePath || f.name;
    // Normalize to POSIX separators (handle Windows backslashes) and drop any
    // leading separator so the path stays relative.
    const relativePath = rawPath.replaceAll('\\', '/').replace(/^\/+/, '');

    if (!relativePath || isSystemMetadata(relativePath)) continue;

    const reason = matchBlockedPath(relativePath);
    if (reason) {
      throw new ApiError(
        ErrorCode.BLOCKED_FILE,
        `Upload rejected: "${relativePath}" is blocked (${reason}). Remove it and upload again.`,
        400
      );
    }

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
