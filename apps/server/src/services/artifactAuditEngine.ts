import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  ArtifactAuditCategory,
  ArtifactAuditCheck,
  ArtifactAuditPolicy,
  ArtifactAuditSeverity,
  ArtifactAuditStatus,
  ArtifactAuditSummary,
} from '@deploykit/shared';
import { ApiError, ErrorCode } from '../errors';
import { checksumDirectory } from './artifactService';

export const ARTIFACT_AUDIT_ENGINE_VERSION = 1;
export const MAX_AUDIT_HTML_BYTES = 2 * 1024 * 1024;

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
}

interface FileInventory {
  summary: ArtifactAuditSummary;
  largestFileSize: number;
}

/**
 * Performs a deterministic, network-free audit of one extracted artifact tree.
 * The result describes the bytes that were actually inspected, so callers can
 * compare `artifactChecksum` with the immutable version metadata before release.
 */
export function auditArtifactDirectory(
  artifactDir: string,
  expectedChecksum: string,
  policy: ArtifactAuditPolicy
): ArtifactAuditResult {
  try {
    const checksumBeforeInspection = checksumDirectory(artifactDir);
    const inventory = inspectArtifactTree(artifactDir);
    const actualChecksum = checksumDirectory(artifactDir);
    if (actualChecksum !== checksumBeforeInspection) {
      throw new ApiError(
        ErrorCode.AUDIT_FAILED,
        'Artifact changed while the audit was running; retry the audit',
        409
      );
    }
    const checks: ArtifactAuditCheck[] = [];

    checks.push(
      createCheck({
        id: 'structure.checksum',
        category: 'structure',
        passed:
          expectedChecksum.length > 0 && actualChecksum === expectedChecksum,
        failureSeverity: 'error',
        passMessage: 'Artifact checksum matches the uploaded version',
        failMessage: 'Artifact checksum no longer matches the uploaded version',
        actual: actualChecksum,
        expected: expectedChecksum || 'recorded upload checksum',
      }),
      createCheck({
        id: 'size.total',
        category: 'size',
        passed: inventory.summary.totalBytes <= policy.maxTotalBytes,
        failureSeverity: 'error',
        passMessage: 'Total artifact size is within the project budget',
        failMessage: 'Total artifact size exceeds the project budget',
        actual: inventory.summary.totalBytes,
        expected: `at most ${policy.maxTotalBytes} bytes`,
      }),
      createCheck({
        id: 'size.file_count',
        category: 'size',
        passed: inventory.summary.fileCount <= policy.maxFileCount,
        failureSeverity: 'error',
        passMessage: 'Artifact file count is within the project budget',
        failMessage: 'Artifact file count exceeds the project budget',
        actual: inventory.summary.fileCount,
        expected: `at most ${policy.maxFileCount} files`,
      }),
      createCheck({
        id: 'size.largest_file',
        category: 'size',
        passed: inventory.largestFileSize <= policy.maxFileBytes,
        failureSeverity: 'error',
        passMessage: 'Every artifact file is within the project budget',
        failMessage: 'At least one artifact file exceeds the project budget',
        actual: inventory.largestFileSize,
        expected: `at most ${policy.maxFileBytes} bytes`,
      })
    );

    const indexPath = join(artifactDir, 'index.html');
    const hasIndex = existsSync(indexPath) && lstatSync(indexPath).isFile();
    const indexSize = hasIndex ? lstatSync(indexPath).size : 0;
    checks.push(
      createCheck({
        id: 'structure.index_html',
        category: 'structure',
        passed: hasIndex,
        failureSeverity: 'error',
        passMessage: 'Root index.html is present',
        failMessage: 'Root index.html is missing',
      }),
      createCheck({
        id: 'structure.index_html_size',
        category: 'structure',
        passed: hasIndex && indexSize <= MAX_AUDIT_HTML_BYTES,
        failureSeverity: 'error',
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
    }

    return {
      artifactChecksum: actualChecksum,
      status: deriveStatus(checks),
      score: calculateScore(checks),
      summary: inventory.summary,
      checks,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      ErrorCode.AUDIT_FAILED,
      `Artifact audit could not inspect the stored files: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500
    );
  }
}

function inspectArtifactTree(root: string): FileInventory {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ApiError(
      ErrorCode.AUDIT_FAILED,
      'Artifact root must be a regular directory',
      500
    );
  }

  const files: Array<{ path: string; size: number }> = [];
  const extensions = new Map<string, { bytes: number; count: number }>();
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
        throw new ApiError(
          ErrorCode.AUDIT_FAILED,
          `Artifact contains an unsupported symbolic link: ${relativePath}`,
          500
        );
      }
      if (stats.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new ApiError(
          ErrorCode.AUDIT_FAILED,
          `Artifact contains an unsupported filesystem entry: ${relativePath}`,
          500
        );
      }

      files.push({ path: relativePath, size: stats.size });
      const extension = extname(entry.name).toLowerCase() || '(none)';
      const current = extensions.get(extension) ?? { bytes: 0, count: 0 };
      current.bytes += stats.size;
      current.count += 1;
      extensions.set(extension, current);
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
      extensions: [...extensions.entries()]
        .map(([extension, values]) => ({ extension, ...values }))
        .sort(
          (left, right) =>
            right.bytes - left.bytes ||
            left.extension.localeCompare(right.extension)
        ),
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
  };
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
        if (rel?.split(/\s+/).includes('canonical')) {
          canonical ??= normalizeText(element.getAttribute('href'));
        }
      },
    })
    .on('script', {
      element(element) {
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
    createCheck({
      id: 'seo.title',
      category: 'seo',
      passed: titlePresent,
      failureSeverity: 'warning',
      passMessage: 'Document has one non-empty title',
      failMessage: 'Document should have exactly one non-empty title',
      actual: signals.titleCount,
      expected: 'exactly one title',
    }),
    createCheck({
      id: 'seo.title_length',
      category: 'seo',
      passed:
        titlePresent &&
        signals.title.length >= 10 &&
        signals.title.length <= 60,
      failureSeverity: 'warning',
      passMessage: 'Title length is within the recommended range',
      failMessage: 'Title length should be between 10 and 60 characters',
      actual: signals.title.length,
      expected: '10 to 60 characters',
    }),
    createCheck({
      id: 'seo.description',
      category: 'seo',
      passed: Boolean(signals.description),
      failureSeverity: 'warning',
      passMessage: 'Meta description is present',
      failMessage: 'Meta description is missing',
    }),
    createCheck({
      id: 'seo.description_length',
      category: 'seo',
      passed: descriptionLength >= 50 && descriptionLength <= 160,
      failureSeverity: 'warning',
      passMessage: 'Meta description length is within the recommended range',
      failMessage:
        'Meta description length should be between 50 and 160 characters',
      actual: descriptionLength,
      expected: '50 to 160 characters',
    }),
    createCheck({
      id: 'seo.canonical',
      category: 'seo',
      passed: isAbsoluteHttpUrl(signals.canonical),
      failureSeverity: 'warning',
      passMessage: 'Canonical URL is an absolute HTTP(S) URL',
      failMessage: 'Canonical URL is missing or is not an absolute HTTP(S) URL',
      actual: signals.canonical ?? 'missing',
    }),
    createCheck({
      id: 'seo.robots_indexing',
      category: 'seo',
      passed: robotsAllowsIndexing,
      failureSeverity: 'warning',
      passMessage: 'Page metadata permits search indexing',
      failMessage: 'Page metadata contains a noindex directive',
      actual: signals.robots ?? 'unspecified',
    }),
    createCheck({
      id: 'seo.viewport',
      category: 'seo',
      passed: Boolean(signals.viewport),
      failureSeverity: 'warning',
      passMessage: 'Viewport metadata is present',
      failMessage: 'Viewport metadata is missing',
    }),
    createCheck({
      id: 'seo.language',
      category: 'seo',
      passed: Boolean(signals.language),
      failureSeverity: 'warning',
      passMessage: 'Document language is declared',
      failMessage: 'The html element should declare a language',
    }),
    createCheck({
      id: 'seo.h1',
      category: 'seo',
      passed: signals.h1Count === 1,
      failureSeverity: 'warning',
      passMessage: 'Document has exactly one H1 heading',
      failMessage: 'Document should have exactly one H1 heading',
      actual: signals.h1Count,
      expected: 'exactly one H1',
    }),
    createCheck({
      id: 'seo.open_graph_title',
      category: 'seo',
      passed: Boolean(signals.openGraphTitle),
      failureSeverity: 'warning',
      passMessage: 'Open Graph title is present',
      failMessage: 'Open Graph title is missing',
    }),
    createCheck({
      id: 'seo.open_graph_description',
      category: 'seo',
      passed: Boolean(signals.openGraphDescription),
      failureSeverity: 'warning',
      passMessage: 'Open Graph description is present',
      failMessage: 'Open Graph description is missing',
    }),
    createCheck({
      id: 'seo.open_graph_image',
      category: 'seo',
      passed: isAbsoluteHttpUrl(signals.openGraphImage),
      failureSeverity: 'warning',
      passMessage: 'Open Graph image is an absolute HTTP(S) URL',
      failMessage:
        'Open Graph image is missing or is not an absolute HTTP(S) URL',
      actual: signals.openGraphImage ?? 'missing',
    }),
    createCheck({
      id: 'seo.json_ld',
      category: 'seo',
      passed: jsonLdValid,
      failureSeverity: 'warning',
      passMessage: 'JSON-LD metadata is present and parseable',
      failMessage:
        signals.jsonLdDocuments.length === 0
          ? 'JSON-LD metadata is missing'
          : 'At least one JSON-LD document is invalid JSON',
      actual: signals.jsonLdDocuments.length,
    }),
    createCheck({
      id: 'seo.robots_txt',
      category: 'seo',
      passed: isRegularFile(join(artifactDir, 'robots.txt')),
      failureSeverity: 'warning',
      passMessage: 'robots.txt is present',
      failMessage: 'robots.txt is missing',
    }),
    createCheck({
      id: 'seo.sitemap_xml',
      category: 'seo',
      passed: isRegularFile(join(artifactDir, 'sitemap.xml')),
      failureSeverity: 'warning',
      passMessage: 'sitemap.xml is present',
      failMessage: 'sitemap.xml is missing',
    }),
  ];
}

function createCheck(input: {
  id: string;
  category: ArtifactAuditCategory;
  passed: boolean;
  failureSeverity: Exclude<ArtifactAuditSeverity, 'info'>;
  passMessage: string;
  failMessage: string;
  actual?: string | number | boolean;
  expected?: string;
}): ArtifactAuditCheck {
  return {
    id: input.id,
    ruleVersion: 1,
    category: input.category,
    severity: input.passed ? 'info' : input.failureSeverity,
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
