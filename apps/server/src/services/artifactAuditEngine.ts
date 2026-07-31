import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  ArtifactAuditCheck,
  ArtifactAuditContext,
  ArtifactAuditExtension,
  ArtifactAuditPolicy,
  ArtifactAuditStatus,
  ArtifactAuditSummary,
} from '@deploykit/shared';
import { decodeHTMLAttribute } from 'entities';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  ARTIFACT_AUDIT_RULES,
  type ArtifactAuditRuleId,
} from '../domain/artifactAuditRules';
import { safeJoin } from '../utils/safePath';
import {
  ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES,
  type ArtifactAuditProcessErrorCode,
} from './artifactAuditProtocol';
import { checksumDirectory } from './artifactService';

export { ARTIFACT_AUDIT_ENGINE_VERSION };
export const MAX_AUDIT_HTML_BYTES = 2 * 1024 * 1024;
const MAX_EXTENSION_SUMMARY_ENTRIES = 50;
const INERT_AUDIT_ORIGIN = 'https://deploykit.invalid';
const INERT_DOCUMENT_URL = `${INERT_AUDIT_ORIGIN}/`;

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const STYLESHEET_EXTENSIONS = new Set(['.css']);
const FONT_EXTENSIONS = new Set([
  '.eot',
  '.otf',
  '.ttc',
  '.ttf',
  '.woff',
  '.woff2',
]);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

export interface ArtifactAuditResult {
  artifactChecksum: string;
  status: ArtifactAuditStatus;
  score: number;
  summary: ArtifactAuditSummary;
  checks: ArtifactAuditCheck[];
}

interface HtmlSignals {
  title: string;
  titleCount: number;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  language: string | null;
  h1Count: number;
  openGraphTitle: string | null;
  openGraphDescription: string | null;
  openGraphImage: string | null;
  jsonLdDocuments: string[];
  baseHref: string | null;
  scriptSources: string[];
  stylesheetHrefs: string[];
  anchorHrefs: string[];
  images: Array<{ source: string | null; hasAlt: boolean }>;
}

interface FileInventory {
  summary: ArtifactAuditSummary;
  largestFileSize: number;
}

type ArtifactAuditInspectionErrorCode = Extract<
  ArtifactAuditProcessErrorCode,
  'AUDIT_REQUIRED' | 'AUDIT_ARTIFACT_UNSAFE' | 'AUDIT_ARTIFACT_UNREADABLE'
>;

export class ArtifactAuditInspectionError extends Error {
  readonly code: ArtifactAuditInspectionErrorCode;

  constructor(code: ArtifactAuditInspectionErrorCode) {
    super(ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES[code]);
    this.name = 'ArtifactAuditInspectionError';
    this.code = code;
  }
}

/**
 * Performs a deterministic, network-free audit of one extracted artifact tree.
 * The result describes the bytes that were actually inspected, so callers can
 * compare `artifactChecksum` with the immutable version metadata before release.
 */
export function auditArtifactDirectory(
  artifactDir: string,
  expectedChecksum: string,
  policy: ArtifactAuditPolicy,
  context: ArtifactAuditContext = { spaMode: false, routingType: 'path' }
): ArtifactAuditResult {
  try {
    assertArtifactRootSafe(artifactDir);
    const checksumBeforeInspection = checksumDirectory(artifactDir);
    const inventory = inspectArtifactTree(artifactDir);
    const actualChecksum = checksumDirectory(artifactDir);
    if (actualChecksum !== checksumBeforeInspection) {
      throw new ArtifactAuditInspectionError('AUDIT_REQUIRED');
    }
    const checks: ArtifactAuditCheck[] = [];

    checks.push(
      createCheck('structure.checksum', {
        passed:
          expectedChecksum.length > 0 && actualChecksum === expectedChecksum,
        passMessage: 'Artifact checksum matches the uploaded version',
        failMessage: 'Artifact checksum no longer matches the uploaded version',
        actual: actualChecksum,
        expected: expectedChecksum || 'recorded upload checksum',
      }),
      createCheck('size.total', {
        passed: inventory.summary.totalBytes <= policy.maxTotalBytes,
        passMessage: 'Total artifact size is within the project budget',
        failMessage: 'Total artifact size exceeds the project budget',
        actual: inventory.summary.totalBytes,
        expected: `at most ${policy.maxTotalBytes} bytes`,
      }),
      createCheck('size.file_count', {
        passed: inventory.summary.fileCount <= policy.maxFileCount,
        passMessage: 'Artifact file count is within the project budget',
        failMessage: 'Artifact file count exceeds the project budget',
        actual: inventory.summary.fileCount,
        expected: `at most ${policy.maxFileCount} files`,
      }),
      createCheck('size.largest_file', {
        passed: inventory.largestFileSize <= policy.maxFileBytes,
        passMessage: 'Every artifact file is within the project budget',
        failMessage: 'At least one artifact file exceeds the project budget',
        actual: inventory.largestFileSize,
        expected: `at most ${policy.maxFileBytes} bytes`,
      }),
      ...createAssetBudgetChecks(inventory.summary, policy)
    );

    const indexPath = join(artifactDir, 'index.html');
    const hasIndex = existsSync(indexPath) && lstatSync(indexPath).isFile();
    const indexSize = hasIndex ? lstatSync(indexPath).size : 0;
    checks.push(
      createCheck('structure.index_html', {
        passed: hasIndex,
        passMessage: 'Root index.html is present',
        failMessage: 'Root index.html is missing',
      }),
      createCheck('structure.index_html_size', {
        passed: hasIndex && indexSize <= MAX_AUDIT_HTML_BYTES,
        passMessage: 'Root index.html is within the static parser budget',
        failMessage: hasIndex
          ? 'Root index.html exceeds the static parser budget'
          : 'Root index.html cannot be inspected',
        actual: indexSize,
        expected: `at most ${MAX_AUDIT_HTML_BYTES} bytes`,
      })
    );

    if (hasIndex && indexSize <= MAX_AUDIT_HTML_BYTES) {
      const signals = parseHtmlSignals(readFileSync(indexPath, 'utf8'));
      checks.push(...createSeoChecks(signals, artifactDir));
      checks.push(...createReferenceChecks(signals, artifactDir, context));
    }

    return {
      artifactChecksum: actualChecksum,
      status: deriveStatus(checks),
      score: calculateScore(checks),
      summary: inventory.summary,
      checks,
    };
  } catch (error) {
    if (error instanceof ArtifactAuditInspectionError) throw error;
    if (isUnsafeFilesystemError(error)) {
      throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
    }
    if (isFilesystemReadError(error)) {
      throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNREADABLE');
    }
    throw error;
  }
}

function inspectArtifactTree(root: string): FileInventory {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
  }

  const files: Array<{ path: string; size: number }> = [];
  const extensions = new Map<string, { bytes: number; count: number }>();
  const assetBytes = {
    javascript: 0,
    stylesheet: 0,
    font: 0,
    image: 0,
  };
  const walk = (directory: string, relativePrefix: string) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const relativePath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
      }
      if (stats.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
      }

      files.push({ path: relativePath, size: stats.size });
      const extension = extname(entry.name).toLowerCase() || '(none)';
      const current = extensions.get(extension) ?? { bytes: 0, count: 0 };
      current.bytes += stats.size;
      current.count += 1;
      extensions.set(extension, current);
      const assetType = classifyAssetExtension(extension);
      if (assetType) assetBytes[assetType] += stats.size;
    }
  };
  walk(root, '');

  const largestFiles = [...files]
    .sort(
      (left, right) =>
        right.size - left.size || left.path.localeCompare(right.path)
    )
    .slice(0, 10);
  return {
    largestFileSize: largestFiles[0]?.size ?? 0,
    summary: {
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      fileCount: files.length,
      largestFiles,
      extensions: summarizeArtifactExtensions(
        [...extensions.entries()].map(([extension, values]) => ({
          extension,
          ...values,
        }))
      ),
      assetBytes,
    },
  };
}

function assertArtifactRootSafe(root: string): void {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
  }
}

function isUnsafeFilesystemError(error: unknown): boolean {
  return hasFilesystemErrorCode(error, new Set(['ELOOP', 'ENAMETOOLONG']));
}

function isFilesystemReadError(error: unknown): boolean {
  return hasFilesystemErrorCode(
    error,
    new Set([
      'EACCES',
      'EBADF',
      'EIO',
      'EISDIR',
      'EMFILE',
      'ENFILE',
      'ENOENT',
      'ENOTDIR',
      'EPERM',
      'ESTALE',
    ])
  );
}

function hasFilesystemErrorCode(error: unknown, codes: Set<string>): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.has(error.code)
  );
}

export function summarizeArtifactExtensions(
  entries: Iterable<ArtifactAuditExtension>
): ArtifactAuditExtension[] {
  const sorted = [...entries].sort(
    (left, right) =>
      right.bytes - left.bytes || left.extension.localeCompare(right.extension)
  );
  if (sorted.length <= MAX_EXTENSION_SUMMARY_ENTRIES) return sorted;

  const included = sorted.slice(0, MAX_EXTENSION_SUMMARY_ENTRIES);
  const omitted = sorted.slice(MAX_EXTENSION_SUMMARY_ENTRIES);
  included.push({
    extension: '(other)',
    bytes: omitted.reduce((total, entry) => total + entry.bytes, 0),
    count: omitted.reduce((total, entry) => total + entry.count, 0),
  });
  return included;
}

function classifyAssetExtension(
  extension: string
): keyof ArtifactAuditSummary['assetBytes'] | null {
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return 'javascript';
  if (STYLESHEET_EXTENSIONS.has(extension)) return 'stylesheet';
  if (FONT_EXTENSIONS.has(extension)) return 'font';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return null;
}

function createAssetBudgetChecks(
  summary: ArtifactAuditSummary,
  policy: ArtifactAuditPolicy
): ArtifactAuditCheck[] {
  return [
    createCheck('assets.javascript_budget', {
      passed: summary.assetBytes.javascript <= policy.maxJavaScriptBytes,
      passMessage: 'JavaScript assets are within the project budget',
      failMessage: 'JavaScript assets exceed the project budget',
      actual: summary.assetBytes.javascript,
      expected: `at most ${policy.maxJavaScriptBytes} bytes`,
    }),
    createCheck('assets.stylesheet_budget', {
      passed: summary.assetBytes.stylesheet <= policy.maxStylesheetBytes,
      passMessage: 'Stylesheet assets are within the project budget',
      failMessage: 'Stylesheet assets exceed the project budget',
      actual: summary.assetBytes.stylesheet,
      expected: `at most ${policy.maxStylesheetBytes} bytes`,
    }),
    createCheck('assets.font_budget', {
      passed: summary.assetBytes.font <= policy.maxFontBytes,
      passMessage: 'Font assets are within the project budget',
      failMessage: 'Font assets exceed the project budget',
      actual: summary.assetBytes.font,
      expected: `at most ${policy.maxFontBytes} bytes`,
    }),
  ];
}

function createReferenceChecks(
  signals: HtmlSignals,
  artifactDir: string,
  context: ArtifactAuditContext
): ArtifactAuditCheck[] {
  const documentBase = createDocumentBase(signals.baseHref);
  const missingScripts = countMissingFileTargets(
    signals.scriptSources,
    documentBase,
    artifactDir
  );
  const missingStylesheets = countMissingFileTargets(
    signals.stylesheetHrefs,
    documentBase,
    artifactDir
  );
  const missingImageSources = signals.images.filter(
    (image) => !image.source?.trim()
  ).length;
  const missingImageAltAttributes = signals.images.filter(
    (image) => !image.hasAlt
  ).length;
  const missingImageTargets = countMissingFileTargets(
    signals.images.flatMap((image) =>
      image.source?.trim() ? [image.source] : []
    ),
    documentBase,
    artifactDir
  );

  let javascriptUrls = 0;
  let missingLinkTargets = 0;
  for (const href of signals.anchorHrefs) {
    const resolved = resolveLocalReference(href, documentBase, artifactDir);
    if (resolved.kind === 'javascript') {
      javascriptUrls += 1;
      continue;
    }
    if (context.spaMode || resolved.kind === 'skip') continue;
    if (resolved.kind === 'invalid') {
      missingLinkTargets += 1;
      continue;
    }

    const targetPath = getStaticLinkTargetPath(resolved.relativePath);
    if (targetPath === null) continue;
    const target = safeJoin(artifactDir, targetPath);
    if (!target || !isRegularFile(target)) missingLinkTargets += 1;
  }

  return [
    createAggregateCheck(
      'assets.script_target',
      missingScripts,
      'All locally verifiable script targets are regular files',
      'One or more locally verifiable script targets are missing or invalid'
    ),
    createAggregateCheck(
      'assets.stylesheet_target',
      missingStylesheets,
      'All locally verifiable stylesheet targets are regular files',
      'One or more locally verifiable stylesheet targets are missing or invalid'
    ),
    createAggregateCheck(
      'links.javascript_url',
      javascriptUrls,
      'No anchor uses a javascript URL',
      'One or more anchors use a javascript URL'
    ),
    createAggregateCheck(
      'links.local_target',
      missingLinkTargets,
      context.spaMode
        ? 'Static link target checks are disabled for SPA routing'
        : 'All high-confidence local link targets are regular files',
      'One or more high-confidence local link targets are missing or invalid'
    ),
    createAggregateCheck(
      'images.source',
      missingImageSources,
      'Every image declares a non-empty source',
      'One or more images do not declare a non-empty source'
    ),
    createAggregateCheck(
      'images.alt_attribute',
      missingImageAltAttributes,
      'Every image declares an alt attribute',
      'One or more images are missing an alt attribute'
    ),
    createAggregateCheck(
      'images.local_target',
      missingImageTargets,
      'All locally verifiable image targets are regular files',
      'One or more locally verifiable image targets are missing or invalid'
    ),
  ];
}

function createAggregateCheck(
  id: ArtifactAuditRuleId,
  failureCount: number,
  passMessage: string,
  failMessage: string
): ArtifactAuditCheck {
  return createCheck(id, {
    passed: failureCount === 0,
    passMessage,
    failMessage,
    actual: failureCount,
    expected: '0 findings',
  });
}

function countMissingFileTargets(
  references: string[],
  documentBase: URL | null,
  artifactDir: string
): number {
  let missing = 0;
  for (const reference of references) {
    const resolved = resolveLocalReference(
      reference,
      documentBase,
      artifactDir
    );
    if (resolved.kind === 'skip' || resolved.kind === 'javascript') {
      continue;
    }
    if (resolved.kind === 'invalid' || resolved.relativePath === '') {
      missing += 1;
      continue;
    }
    const target = safeJoin(artifactDir, resolved.relativePath);
    if (!target || !isRegularFile(target)) missing += 1;
  }
  return missing;
}

type LocalReferenceResolution =
  | { kind: 'skip' }
  | { kind: 'javascript' }
  | { kind: 'invalid' }
  | { kind: 'local'; relativePath: string };

function resolveLocalReference(
  rawReference: string,
  documentBase: URL | null,
  artifactDir: string
): LocalReferenceResolution {
  const reference = rawReference.trim();
  if (
    reference.startsWith('#') ||
    /^data:/i.test(reference) ||
    /^blob:/i.test(reference) ||
    reference.startsWith('//')
  ) {
    return { kind: 'skip' };
  }
  if (isAbsoluteHttpUrl(reference)) return { kind: 'skip' };

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(reference)?.[1]?.toLowerCase();
  if (scheme === 'javascript') return { kind: 'javascript' };
  if (scheme === 'http' || scheme === 'https') return { kind: 'invalid' };
  if (scheme) return { kind: 'skip' };
  if (!documentBase) return { kind: 'invalid' };

  let resolved: URL;
  try {
    resolved = new URL(reference, documentBase);
  } catch {
    return { kind: 'invalid' };
  }
  if (resolved.protocol === 'javascript:') {
    return { kind: 'javascript' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { kind: 'skip' };
  }
  if (resolved.origin !== INERT_AUDIT_ORIGIN) return { kind: 'skip' };

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(resolved.pathname);
  } catch {
    return { kind: 'invalid' };
  }
  const relativePath = decodedPathname.replace(/^\/+/, '');
  if (relativePath === '') return { kind: 'local', relativePath };
  if (!safeJoin(artifactDir, relativePath)) return { kind: 'invalid' };
  return { kind: 'local', relativePath };
}

function createDocumentBase(baseHref: string | null): URL | null {
  try {
    return new URL(baseHref ?? INERT_DOCUMENT_URL, INERT_DOCUMENT_URL);
  } catch {
    return null;
  }
}

function getStaticLinkTargetPath(relativePath: string): string | null {
  if (relativePath === '') return 'index.html';
  if (relativePath.endsWith('/')) return `${relativePath}index.html`;
  if (extname(relativePath) !== '') return relativePath;
  return null;
}

function parseHtmlSignals(html: string): HtmlSignals {
  let title = '';
  let titleCount = 0;
  let h1Count = 0;
  let language: string | null = null;
  const metadata = new Map<string, string>();
  let canonical: string | null = null;
  const jsonLdDocuments: string[] = [];
  let currentJsonLd: string | null = null;
  let baseHref: string | null = null;
  let baseHrefCollected = false;
  const scriptSources: string[] = [];
  const stylesheetHrefs: string[] = [];
  const anchorHrefs: string[] = [];
  const images: HtmlSignals['images'] = [];

  new HTMLRewriter()
    .on('html', {
      element(element) {
        language ??= normalizeText(element.getAttribute('lang'));
      },
    })
    .on('title', {
      element() {
        titleCount += 1;
      },
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('h1', {
      element() {
        h1Count += 1;
      },
    })
    .on('meta', {
      element(element) {
        const key = normalizeText(
          element.getAttribute('name') ?? element.getAttribute('property')
        )?.toLowerCase();
        const content = normalizeText(element.getAttribute('content'));
        if (key && content && !metadata.has(key)) metadata.set(key, content);
      },
    })
    .on('link', {
      element(element) {
        const rel = normalizeText(element.getAttribute('rel'))?.toLowerCase();
        const href = decodeCollectedUrlAttribute(
          element.getAttribute('href'),
          element.hasAttribute('href')
        );
        if (rel?.split(/\s+/).includes('canonical')) {
          canonical ??= normalizeText(href);
        }
        if (rel?.split(/\s+/).includes('stylesheet') && href !== null) {
          stylesheetHrefs.push(href);
        }
      },
    })
    .on('base', {
      element(element) {
        const href = decodeCollectedUrlAttribute(
          element.getAttribute('href'),
          element.hasAttribute('href')
        );
        if (!baseHrefCollected && href !== null) {
          baseHref = href;
          baseHrefCollected = true;
        }
      },
    })
    .on('script', {
      element(element) {
        const source = decodeCollectedUrlAttribute(
          element.getAttribute('src'),
          element.hasAttribute('src')
        );
        if (source !== null) scriptSources.push(source);
        if (
          normalizeText(element.getAttribute('type'))?.toLowerCase() ===
          'application/ld+json'
        ) {
          currentJsonLd = '';
          element.onEndTag(() => {
            if (currentJsonLd !== null) {
              jsonLdDocuments.push(currentJsonLd.trim());
              currentJsonLd = null;
            }
          });
        }
      },
      text(chunk) {
        if (currentJsonLd !== null) currentJsonLd += chunk.text;
      },
    })
    .on('a', {
      element(element) {
        const href = decodeCollectedUrlAttribute(
          element.getAttribute('href'),
          element.hasAttribute('href')
        );
        if (href !== null) anchorHrefs.push(href);
      },
    })
    .on('img', {
      element(element) {
        images.push({
          source: decodeCollectedUrlAttribute(
            element.getAttribute('src'),
            element.hasAttribute('src')
          ),
          hasAlt: element.hasAttribute('alt'),
        });
      },
    })
    .transform(html);

  return {
    title: normalizeText(title) ?? '',
    titleCount,
    description: metadata.get('description') ?? null,
    canonical,
    robots: metadata.get('robots') ?? null,
    viewport: metadata.get('viewport') ?? null,
    language,
    h1Count,
    openGraphTitle: metadata.get('og:title') ?? null,
    openGraphDescription: metadata.get('og:description') ?? null,
    openGraphImage: metadata.get('og:image') ?? null,
    jsonLdDocuments,
    baseHref,
    scriptSources,
    stylesheetHrefs,
    anchorHrefs,
    images,
  };
}

function createSeoChecks(
  signals: HtmlSignals,
  artifactDir: string
): ArtifactAuditCheck[] {
  const titlePresent = signals.titleCount === 1 && signals.title.length > 0;
  const descriptionLength = signals.description?.length ?? 0;
  const jsonLdValid =
    signals.jsonLdDocuments.length > 0 &&
    signals.jsonLdDocuments.every(isValidJson);
  const robotsAllowsIndexing =
    !signals.robots ||
    !/(^|[,\s])(noindex|none)([,\s]|$)/i.test(signals.robots);

  return [
    createCheck('seo.title', {
      passed: titlePresent,
      passMessage: 'Document has one non-empty title',
      failMessage: 'Document should have exactly one non-empty title',
      actual: signals.titleCount,
      expected: 'exactly one title',
    }),
    createCheck('seo.title_length', {
      passed:
        titlePresent &&
        signals.title.length >= 10 &&
        signals.title.length <= 60,
      passMessage: 'Title length is within the recommended range',
      failMessage: 'Title length should be between 10 and 60 characters',
      actual: signals.title.length,
      expected: '10 to 60 characters',
    }),
    createCheck('seo.description', {
      passed: Boolean(signals.description),
      passMessage: 'Meta description is present',
      failMessage: 'Meta description is missing',
    }),
    createCheck('seo.description_length', {
      passed: descriptionLength >= 50 && descriptionLength <= 160,
      passMessage: 'Meta description length is within the recommended range',
      failMessage:
        'Meta description length should be between 50 and 160 characters',
      actual: descriptionLength,
      expected: '50 to 160 characters',
    }),
    createCheck('seo.canonical', {
      passed: isAbsoluteHttpUrl(signals.canonical),
      passMessage: 'Canonical URL is an absolute HTTP(S) URL',
      failMessage: 'Canonical URL is missing or is not an absolute HTTP(S) URL',
      actual: signals.canonical ?? 'missing',
    }),
    createCheck('seo.robots_indexing', {
      passed: robotsAllowsIndexing,
      passMessage: 'Page metadata permits search indexing',
      failMessage: 'Page metadata contains a noindex directive',
      actual: signals.robots ?? 'unspecified',
    }),
    createCheck('seo.viewport', {
      passed: Boolean(signals.viewport),
      passMessage: 'Viewport metadata is present',
      failMessage: 'Viewport metadata is missing',
    }),
    createCheck('seo.language', {
      passed: Boolean(signals.language),
      passMessage: 'Document language is declared',
      failMessage: 'The html element should declare a language',
    }),
    createCheck('seo.h1', {
      passed: signals.h1Count === 1,
      passMessage: 'Document has exactly one H1 heading',
      failMessage: 'Document should have exactly one H1 heading',
      actual: signals.h1Count,
      expected: 'exactly one H1',
    }),
    createCheck('seo.open_graph_title', {
      passed: Boolean(signals.openGraphTitle),
      passMessage: 'Open Graph title is present',
      failMessage: 'Open Graph title is missing',
    }),
    createCheck('seo.open_graph_description', {
      passed: Boolean(signals.openGraphDescription),
      passMessage: 'Open Graph description is present',
      failMessage: 'Open Graph description is missing',
    }),
    createCheck('seo.open_graph_image', {
      passed: isAbsoluteHttpUrl(signals.openGraphImage),
      passMessage: 'Open Graph image is an absolute HTTP(S) URL',
      failMessage:
        'Open Graph image is missing or is not an absolute HTTP(S) URL',
      actual: signals.openGraphImage ?? 'missing',
    }),
    createCheck('seo.json_ld', {
      passed: jsonLdValid,
      passMessage: 'JSON-LD metadata is present and parseable',
      failMessage:
        signals.jsonLdDocuments.length === 0
          ? 'JSON-LD metadata is missing'
          : 'At least one JSON-LD document is invalid JSON',
      actual: signals.jsonLdDocuments.length,
    }),
    createCheck('seo.robots_txt', {
      passed: isRegularFile(join(artifactDir, 'robots.txt')),
      passMessage: 'robots.txt is present',
      failMessage: 'robots.txt is missing',
    }),
    createCheck('seo.sitemap_xml', {
      passed: isRegularFile(join(artifactDir, 'sitemap.xml')),
      passMessage: 'sitemap.xml is present',
      failMessage: 'sitemap.xml is missing',
    }),
  ];
}

function createCheck(
  id: ArtifactAuditRuleId,
  input: {
    passed: boolean;
    passMessage: string;
    failMessage: string;
    actual?: string | number | boolean;
    expected?: string;
  }
): ArtifactAuditCheck {
  const rule = ARTIFACT_AUDIT_RULES[id];
  return {
    id,
    ruleVersion: rule.version,
    category: rule.category,
    severity: input.passed ? 'info' : rule.failureSeverity,
    passed: input.passed,
    message: input.passed ? input.passMessage : input.failMessage,
    ...(input.actual === undefined ? {} : { actual: input.actual }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
  };
}

function deriveStatus(checks: ArtifactAuditCheck[]): ArtifactAuditStatus {
  if (checks.some((check) => !check.passed && check.severity === 'error')) {
    return 'failed';
  }
  if (checks.some((check) => !check.passed && check.severity === 'warning')) {
    return 'warning';
  }
  return 'passed';
}

function calculateScore(checks: ArtifactAuditCheck[]): number {
  const penalty = checks.reduce((total, check) => {
    if (check.passed) return total;
    return total + (check.severity === 'error' ? 20 : 5);
  }, 0);
  return Math.max(0, 100 - penalty);
}

function isAbsoluteHttpUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile();
}

function isValidJson(value: string): boolean {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function decodeCollectedUrlAttribute(
  value: string | null,
  present: boolean
): string | null {
  return present ? decodeHTMLAttribute(value ?? '') : null;
}
