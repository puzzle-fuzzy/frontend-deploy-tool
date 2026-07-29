import { createHash } from 'node:crypto';
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
import { Unzip, type UnzipFile, UnzipInflate } from 'fflate';
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
 * Directory segments that never belong in a deployable build artifact. Rejecting
 * the whole upload (rather than silently stripping) surfaces accidental inclusions
 * of VCS history, dependencies, or other non-artifact trees.
 */
const DANGEROUS_DIR_SEGMENTS = new Set(['.git', 'node_modules', '.svn', '.hg']);

/**
 * File basenames that carry secrets or credentials. Matches `.env` and dotenv
 * variants, private keys (`*.pem`/`*.key`), and common SSH key files.
 */
const DANGEROUS_FILE_PATTERNS = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production, ...
  /\.(pem|key)$/i, // any *.pem / *.key
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, // SSH private keys (+ .pub)
];

export interface ArtifactLimits {
  maxExtractedSize?: number;
  maxFileCount?: number;
  maxPathLength?: number;
  maxCompressionRatio?: number;
}

export interface ArtifactStats {
  extractedBytes: number;
  fileCount: number;
}

interface ResolvedArtifactLimits {
  maxExtractedSize: number;
  maxFileCount: number;
  maxPathLength: number;
  maxCompressionRatio: number;
}

const DEFAULT_ARTIFACT_LIMITS: ResolvedArtifactLimits = {
  maxExtractedSize: 100 * 1024 * 1024,
  maxFileCount: 1000,
  maxPathLength: 1000,
  maxCompressionRatio: 200,
};

/** True for an entry whose path leaks secrets or drags in non-artifact trees. */
function isDangerousPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (DANGEROUS_DIR_SEGMENTS.has(segment)) return true;
  }
  const basename = segments[segments.length - 1] ?? '';
  return DANGEROUS_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Asserts the extracted/flattened layout has a root `index.html`. Without one,
 * the upload would "succeed" but `/deploy/:slug/` would 404. Throws `ApiError`
 * (400) so the caller cleans up the version directory.
 */
export function assertIndexHtml(dir: string): void {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new ApiError(
      ErrorCode.MISSING_INDEX_HTML,
      'Upload must contain an index.html at its root'
    );
  }
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
  destDir: string,
  limits: ArtifactLimits = {}
): Promise<ArtifactStats> {
  mkdirSync(destDir, { recursive: true });
  const resolvedLimits = resolveArtifactLimits(limits);
  const createdFiles: string[] = [];
  const seenPaths = new Set<string>();
  let entryCount = 0;
  let declaredBytes = 0;
  let processedBytes = 0;
  let extractedBytes = 0;
  let fileCount = 0;
  let failure: unknown = null;
  let reader:
    | ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
    | undefined;

  const fail = (error: unknown) => {
    if (!failure) failure = error;
  };
  const assertProcessedSize = (chunkSize: number) => {
    processedBytes += chunkSize;
    if (processedBytes > resolvedLimits.maxExtractedSize) {
      fail(
        new ApiError(
          ErrorCode.EXTRACTED_TOO_LARGE,
          `Extracted files exceed ${resolvedLimits.maxExtractedSize} bytes`
        )
      );
    }
  };
  const drainEntry = (entry: UnzipFile) => {
    entry.ondata = (error, chunk) => {
      if (error) {
        fail(new Error('Zip extraction failed'));
        return;
      }
      assertProcessedSize(chunk.length);
      if (failure) entry.terminate();
    };
    try {
      entry.start();
    } catch (error) {
      fail(error);
    }
  };

  const unzipper = new Unzip((entry) => {
    if (failure) return;
    const entryPath = entry.name.replaceAll('\\', '/');
    entryCount += 1;
    if (entryCount > resolvedLimits.maxFileCount) {
      fail(
        new ApiError(
          ErrorCode.TOO_MANY_FILES,
          `Archive contains more than ${resolvedLimits.maxFileCount} entries`
        )
      );
      return;
    }
    if (entryPath.length > resolvedLimits.maxPathLength) {
      fail(
        new ApiError(
          ErrorCode.PATH_TOO_LONG,
          `Path exceeds ${resolvedLimits.maxPathLength} characters: ${entryPath}`
        )
      );
      return;
    }
    if (entryPath.endsWith('/')) {
      drainEntry(entry);
      return;
    }
    if (isDangerousPath(entryPath)) {
      fail(
        new ApiError(
          ErrorCode.UNSAFE_ENTRY,
          `Upload contains a disallowed entry: ${entryPath}`
        )
      );
      return;
    }
    const target = safeJoin(destDir, entryPath);
    if (!target) {
      fail(
        new ApiError(ErrorCode.UNSAFE_ENTRY, `Unsafe zip entry: ${entryPath}`)
      );
      return;
    }
    if (seenPaths.has(entryPath) || existsSync(target)) {
      fail(
        new ApiError(
          ErrorCode.UNSAFE_ENTRY,
          `Archive contains a duplicate entry: ${entryPath}`
        )
      );
      return;
    }
    seenPaths.add(entryPath);

    if (entry.originalSize !== undefined) {
      declaredBytes += entry.originalSize;
      if (declaredBytes > resolvedLimits.maxExtractedSize) {
        fail(
          new ApiError(
            ErrorCode.EXTRACTED_TOO_LARGE,
            `Extracted files exceed ${resolvedLimits.maxExtractedSize} bytes`
          )
        );
        return;
      }
      if (
        entry.originalSize > 0 &&
        (entry.size === 0 ||
          (entry.size !== undefined &&
            entry.originalSize / entry.size >
              resolvedLimits.maxCompressionRatio))
      ) {
        fail(
          new ApiError(
            ErrorCode.ZIP_RATIO_EXCEEDED,
            `Archive entry exceeds compression ratio ${resolvedLimits.maxCompressionRatio}: ${entryPath}`
          )
        );
        return;
      }
    }

    if (isSystemMetadata(entryPath)) {
      drainEntry(entry);
      return;
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Uint8Array(), { flag: 'wx' });
      createdFiles.push(target);
      fileCount += 1;
    } catch (error) {
      fail(error);
      return;
    }

    entry.ondata = (error, chunk) => {
      if (error) {
        fail(new Error('Zip extraction failed'));
        return;
      }
      assertProcessedSize(chunk.length);
      if (failure) {
        entry.terminate();
        return;
      }
      try {
        writeFileSync(target, chunk, { flag: 'a' });
        extractedBytes += chunk.length;
      } catch (writeError) {
        fail(writeError);
        entry.terminate();
      }
    };
    try {
      entry.start();
    } catch (error) {
      fail(error);
    }
  });
  unzipper.register(UnzipInflate);

  try {
    reader = Bun.file(zipPath).stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      unzipper.push(value);
      if (failure) throw failure;
    }
    unzipper.push(new Uint8Array(), true);
    if (failure) throw failure;
    if (entryCount === 0) throw new Error('Zip extraction failed');
    return { extractedBytes, fileCount };
  } catch (error) {
    try {
      await reader?.cancel();
    } catch {
      // The original extraction failure remains authoritative.
    }
    for (const createdFile of createdFiles) {
      rmSync(createdFile, { force: true });
    }
    if (error instanceof ApiError) throw error;
    throw new Error('Zip extraction failed');
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

/** Computes a deterministic sha256 digest over every file in an artifact tree. */
export function checksumDirectory(dirPath: string): string {
  const hash = createHash('sha256');

  function walk(currentPath: string, relativePrefix: string) {
    const entries = readdirSync(currentPath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const relativePath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const absolutePath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(readFileSync(absolutePath));
        hash.update('\0');
      }
    }
  }

  walk(dirPath, '');
  return hash.digest('hex');
}

/**
 * Writes uploaded folder files into `destDir`, preserving each file's relative
 * directory structure. Returns the total bytes written. OS metadata entries are
 * skipped. Throws `ApiError` (400) when a path is unsafe or exceeds
 * `maxPathLength`.
 */
export async function writeFolderFiles(
  destDir: string,
  files: File[],
  limits: ArtifactLimits = {}
): Promise<ArtifactStats> {
  const resolvedLimits = resolveArtifactLimits(limits);
  if (files.length > resolvedLimits.maxFileCount) {
    throw new ApiError(
      ErrorCode.TOO_MANY_FILES,
      `Too many files. Maximum ${resolvedLimits.maxFileCount} files allowed.`
    );
  }
  const accepted: Array<{ file: File; target: string }> = [];
  let extractedBytes = 0;
  for (const f of files) {
    const rawPath = f.webkitRelativePath || f.name;
    // Normalize to POSIX separators (handle Windows backslashes) and drop any
    // leading separator so the path stays relative.
    const relativePath = rawPath.replaceAll('\\', '/').replace(/^\/+/, '');

    if (!relativePath || isSystemMetadata(relativePath)) continue;

    if (isDangerousPath(relativePath)) {
      throw new ApiError(
        ErrorCode.UNSAFE_ENTRY,
        `Upload contains a disallowed entry: ${relativePath}`
      );
    }

    if (relativePath.length > resolvedLimits.maxPathLength) {
      throw new ApiError(
        ErrorCode.PATH_TOO_LONG,
        `Path too long. Maximum path length is ${resolvedLimits.maxPathLength} characters.`
      );
    }

    const filePath = safeJoin(destDir, relativePath);
    if (!filePath) {
      throw new ApiError(
        ErrorCode.UNSAFE_ENTRY,
        `Upload contains an unsafe path: ${relativePath}`
      );
    }
    extractedBytes += f.size;
    if (extractedBytes > resolvedLimits.maxExtractedSize) {
      throw new ApiError(
        ErrorCode.FILES_TOO_LARGE,
        `Files exceed ${resolvedLimits.maxExtractedSize} bytes`
      );
    }
    accepted.push({ file: f, target: filePath });
  }

  for (const { file, target } of accepted) {
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, file);
  }

  return { extractedBytes, fileCount: accepted.length };
}

function resolveArtifactLimits(limits: ArtifactLimits): ResolvedArtifactLimits {
  return {
    maxExtractedSize:
      limits.maxExtractedSize ?? DEFAULT_ARTIFACT_LIMITS.maxExtractedSize,
    maxFileCount: limits.maxFileCount ?? DEFAULT_ARTIFACT_LIMITS.maxFileCount,
    maxPathLength:
      limits.maxPathLength ?? DEFAULT_ARTIFACT_LIMITS.maxPathLength,
    maxCompressionRatio:
      limits.maxCompressionRatio ?? DEFAULT_ARTIFACT_LIMITS.maxCompressionRatio,
  };
}

/**
 * Builds a static-file response with cache semantics based on URL identity:
 * mutable active aliases must revalidate, while an explicit version URL is
 * immutable. Returns `null` when the path is not a file.
 */
export function serveArtifactFile(
  absolutePath: string,
  options: {
    cacheScope: 'active' | 'version';
    ifNoneMatch?: string;
  }
): Response | null {
  if (!existsSync(absolutePath)) return null;
  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;

  const mimeType = getMimeType(absolutePath);
  const etag = createArtifactEtag(absolutePath, stats.size, stats.mtimeMs);
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    ETag: etag,
    'Cache-Control':
      options.cacheScope === 'version'
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
  };

  if (etagMatches(options.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(absolutePath), { headers });
}

function createArtifactEtag(
  absolutePath: string,
  size: number,
  mtimeMs: number
): string {
  const digest = createHash('sha256')
    .update(`${absolutePath}\0${size}\0${mtimeMs}`)
    .digest('base64url');
  return `W/"${digest}"`;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag);
}

/** Recursively removes a directory (no-op if it does not exist). */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
