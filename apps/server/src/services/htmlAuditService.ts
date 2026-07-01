import { existsSync } from 'node:fs';
import type { AuditCheck, AuditProfile } from '@deploykit/shared';
import { type CheerioAPI, load } from 'cheerio';
import { safeJoin } from '../utils/safePath';

export interface HtmlAuditInput {
  html: string;
  artifactRoot: string;
  profile: AuditProfile;
}

type CheckDraft = Pick<
  AuditCheck,
  'id' | 'category' | 'severity' | 'title' | 'message'
> &
  Pick<Partial<AuditCheck>, 'location'>;

const REMOTE_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
]);

export function auditHtml(input: HtmlAuditInput): AuditCheck[] {
  const $ = load(input.html);
  const checks: AuditCheck[] = [];

  auditMetadata($, input.profile, checks);
  auditHeadings($, checks);
  auditRobots($, input.profile, checks);
  auditAnchors($, checks);
  auditImages($, checks);
  auditSocialTags($, input.profile, checks);
  auditLocalAssets($, input.artifactRoot, checks);

  return checks;
}

function auditMetadata(
  $: CheerioAPI,
  profile: AuditProfile,
  checks: AuditCheck[]
): void {
  if (!$('title').first().text().trim()) {
    checks.push(
      check({
        id: 'metadata.title.missing',
        category: 'metadata',
        severity: 'error',
        title: 'Missing page title',
        message: 'Add a non-empty <title> element to the document head.',
      })
    );
  }

  if (!metaContent($, 'name', 'description')) {
    checks.push(
      check({
        id: 'metadata.description.missing',
        category: 'metadata',
        severity: profile === 'admin-app' ? 'info' : 'warning',
        title: 'Missing meta description',
        message:
          'Add a concise meta description for previews and search results.',
      })
    );
  }

  if (!$('html').first().attr('lang')?.trim()) {
    checks.push(
      check({
        id: 'metadata.lang.missing',
        category: 'metadata',
        severity: 'warning',
        title: 'Missing document language',
        message: 'Set the lang attribute on the root <html> element.',
      })
    );
  }

  if (!metaContent($, 'name', 'viewport')) {
    checks.push(
      check({
        id: 'metadata.viewport.missing',
        category: 'metadata',
        severity: 'warning',
        title: 'Missing viewport metadata',
        message: 'Add a viewport meta tag for responsive rendering.',
      })
    );
  }

  if (
    requiresCanonical(profile) &&
    !$('link[rel~="canonical"]').first().attr('href')?.trim()
  ) {
    checks.push(
      check({
        id: 'metadata.canonical.missing',
        category: 'metadata',
        severity: 'warning',
        title: 'Missing canonical URL',
        message: 'Add a canonical link to identify the preferred public URL.',
      })
    );
  }
}

function auditHeadings($: CheerioAPI, checks: AuditCheck[]): void {
  const h1Count = $('h1').length;
  if (h1Count === 0) {
    checks.push(
      check({
        id: 'seo.h1.missing',
        category: 'seo',
        severity: 'warning',
        title: 'Missing H1',
        message: 'Add exactly one H1 that describes the page.',
      })
    );
  } else if (h1Count > 1) {
    checks.push(
      check({
        id: 'seo.h1.multiple',
        category: 'seo',
        severity: 'warning',
        title: 'Multiple H1 elements',
        message: 'Use a single H1 and demote additional top-level headings.',
      })
    );
  }

  let previousLevel = 0;
  $('h1,h2,h3,h4,h5,h6').each((_, element) => {
    const level = Number(element.tagName.slice(1));
    if (previousLevel > 0 && level > previousLevel + 1) {
      checks.push(
        check({
          id: 'seo.heading.order.skip',
          category: 'seo',
          severity: 'warning',
          title: 'Skipped heading level',
          message: `Heading order jumps from H${previousLevel} to H${level}.`,
          location: $(element).text().trim() || element.tagName,
        })
      );
    }
    previousLevel = level;
  });
}

function auditRobots(
  $: CheerioAPI,
  profile: AuditProfile,
  checks: AuditCheck[]
): void {
  if (profile !== 'admin-app') return;

  const robots = metaContent($, 'name', 'robots')?.toLowerCase();
  if (
    !robots
      ?.split(',')
      .map((value) => value.trim())
      .includes('noindex')
  ) {
    checks.push(
      check({
        id: 'seo.robots.noindex.missing',
        category: 'seo',
        severity: 'warning',
        title: 'Missing noindex robots directive',
        message:
          'Admin app artifacts should include a robots noindex directive.',
      })
    );
  }
}

function auditAnchors($: CheerioAPI, checks: AuditCheck[]): void {
  $('a').each((_, element) => {
    const href = $(element).attr('href')?.trim() ?? '';
    if (!href) {
      checks.push(
        check({
          id: 'links.href.missing',
          category: 'links',
          severity: 'warning',
          title: 'Missing link target',
          message: 'Add a non-empty href attribute for the link target.',
          location: $(element).text().trim() || undefined,
        })
      );
    }

    if (href.toLowerCase().startsWith('javascript:')) {
      checks.push(
        check({
          id: 'links.href.javascript',
          category: 'links',
          severity: 'error',
          title: 'Unsafe JavaScript link',
          message:
            'Replace javascript: links with safe URLs or button behavior.',
          location: href,
        })
      );
    }

    const accessibleText =
      $(element).text().trim() ||
      $(element).attr('aria-label')?.trim() ||
      $(element).attr('title')?.trim();
    if (!accessibleText) {
      checks.push(
        check({
          id: 'links.text.empty',
          category: 'links',
          severity: 'warning',
          title: 'Empty anchor text',
          message: 'Add visible text or an accessible label for the link.',
          location: href || undefined,
        })
      );
    }
  });
}

function auditImages($: CheerioAPI, checks: AuditCheck[]): void {
  $('img').each((_, element) => {
    const src = $(element).attr('src')?.trim() ?? '';
    if (!src) {
      checks.push(
        check({
          id: 'images.src.missing',
          category: 'images',
          severity: 'error',
          title: 'Missing image source',
          message: 'Add a non-empty src attribute for the image source.',
          location: $(element).attr('alt')?.trim(),
        })
      );
    }

    const alt = $(element).attr('alt');
    if (alt === undefined) {
      checks.push(
        check({
          id: 'images.alt.missing',
          category: 'images',
          severity: 'warning',
          title: 'Missing image alt text',
          message:
            'Add alt text, or use alt="" when the image is decorative.',
          location: src || undefined,
        })
      );
    }
  });
}

function auditSocialTags(
  $: CheerioAPI,
  profile: AuditProfile,
  checks: AuditCheck[]
): void {
  if (profile === 'admin-app' || profile === 'demo') return;

  const requiredTags = [
    {
      id: 'social.og.title.missing',
      attr: 'property',
      name: 'og:title',
      label: 'Open Graph title',
    },
    {
      id: 'social.og.description.missing',
      attr: 'property',
      name: 'og:description',
      label: 'Open Graph description',
    },
    {
      id: 'social.og.image.missing',
      attr: 'property',
      name: 'og:image',
      label: 'Open Graph image',
    },
    {
      id: 'social.twitter.card.missing',
      attr: 'name',
      name: 'twitter:card',
      label: 'Twitter card',
    },
  ];

  for (const tag of requiredTags) {
    if (metaContent($, tag.attr, tag.name)) continue;
    checks.push(
      check({
        id: tag.id,
        category: 'social',
        severity: profile === 'production-web' ? 'warning' : 'info',
        title: `Missing ${tag.label}`,
        message: `Add ${tag.label} metadata for richer shared previews.`,
      })
    );
  }
}

function auditLocalAssets(
  $: CheerioAPI,
  artifactRoot: string,
  checks: AuditCheck[]
): void {
  const seen = new Set<string>();
  const references = [
    ...attributeValues($, 'script[src]', 'src'),
    ...attributeValues($, 'link[href]', 'href'),
    ...attributeValues($, 'img[src]', 'src'),
    ...attributeValues($, 'source[src]', 'src'),
    ...attributeValues($, 'video[src]', 'src'),
    ...attributeValues($, 'audio[src]', 'src'),
    ...srcsetValues($),
  ];

  for (const reference of references) {
    const localPath = toLocalAssetPath(reference);
    if (!localPath || seen.has(reference)) continue;
    seen.add(reference);

    const absolutePath = safeJoin(artifactRoot, localPath);
    if (!absolutePath || existsSync(absolutePath)) continue;

    checks.push(
      check({
        id: 'assets.reference.missing',
        category: 'assets',
        severity: 'error',
        title: 'Missing referenced asset',
        message:
          'The HTML references a local asset that is not present in the artifact.',
        location: reference,
      })
    );
  }
}

function attributeValues(
  $: CheerioAPI,
  selector: string,
  attr: string
): string[] {
  const values: string[] = [];
  $(selector).each((_, element) => {
    const value = $(element).attr(attr)?.trim();
    if (value) values.push(value);
  });
  return values;
}

function srcsetValues($: CheerioAPI): string[] {
  const values: string[] = [];
  $('[srcset]').each((_, element) => {
    for (const candidate of ($(element).attr('srcset') ?? '').split(',')) {
      const [url] = candidate.trim().split(/\s+/);
      if (url) values.push(url);
    }
  });
  return values;
}

function toLocalAssetPath(reference: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  try {
    const url = new URL(trimmed, 'http://deploykit.local/');
    if (
      REMOTE_PROTOCOLS.has(url.protocol) &&
      url.origin !== 'http://deploykit.local'
    )
      return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin !== 'http://deploykit.local') return null;

    const localPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    return localPath || null;
  } catch {
    return null;
  }
}

function metaContent(
  $: CheerioAPI,
  attrName: string,
  attrValue: string
): string | null {
  let content: string | null = null;
  $('meta').each((_, element) => {
    const value = $(element).attr(attrName);
    if (value?.toLowerCase() !== attrValue.toLowerCase()) return;
    const metaValue = $(element).attr('content')?.trim();
    if (metaValue) content = metaValue;
  });
  return content;
}

function requiresCanonical(profile: AuditProfile): boolean {
  return profile === 'production-web' || profile === 'docs';
}

function check(draft: CheckDraft): AuditCheck {
  return draft.location ? { ...draft, location: draft.location } : draft;
}
