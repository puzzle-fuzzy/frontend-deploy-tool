import type {
  ArtifactAuditCategory,
  ArtifactAuditSeverity,
} from '@deploykit/shared';

export const ARTIFACT_AUDIT_RULESET_ID = 'deploykit-static';
export const ARTIFACT_AUDIT_ENGINE_VERSION = 2;

interface ArtifactAuditRule {
  version: number;
  category: ArtifactAuditCategory;
  failureSeverity: Exclude<ArtifactAuditSeverity, 'info'>;
}

export const ARTIFACT_AUDIT_RULES = {
  'structure.checksum': {
    version: 1,
    category: 'structure',
    failureSeverity: 'error',
  },
  'size.total': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'size.file_count': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'size.largest_file': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'structure.index_html': {
    version: 1,
    category: 'structure',
    failureSeverity: 'error',
  },
  'structure.index_html_size': {
    version: 1,
    category: 'structure',
    failureSeverity: 'error',
  },
  'seo.title': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.title_length': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.description': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.description_length': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.canonical': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.robots_indexing': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.viewport': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.language': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.h1': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.open_graph_title': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.open_graph_description': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.open_graph_image': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.json_ld': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.robots_txt': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'seo.sitemap_xml': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'assets.javascript_budget': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'assets.stylesheet_budget': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'assets.font_budget': {
    version: 1,
    category: 'size',
    failureSeverity: 'error',
  },
  'assets.script_target': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
  'assets.stylesheet_target': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
  'links.javascript_url': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
  'links.local_target': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
  'images.source': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
  'images.alt_attribute': {
    version: 1,
    category: 'seo',
    failureSeverity: 'warning',
  },
  'images.local_target': {
    version: 1,
    category: 'structure',
    failureSeverity: 'warning',
  },
} as const satisfies Record<string, ArtifactAuditRule>;

export type ArtifactAuditRuleId = keyof typeof ARTIFACT_AUDIT_RULES;

export function isArtifactAuditRuleId(
  value: string
): value is ArtifactAuditRuleId {
  return Object.hasOwn(ARTIFACT_AUDIT_RULES, value);
}
