import {
  type ArtifactAuditPolicy,
  type ArtifactAuditPolicyUpdate,
  artifactAuditPolicySchema,
  artifactAuditPolicyUpdateSchema,
  DEFAULT_ARTIFACT_AUDIT_POLICY,
  type Project,
  type Settings,
  settingsSchema,
} from '@deploykit/shared';

export const DEFAULT_PROJECT_SETTINGS: Settings = {
  spaMode: false,
  routingType: 'path',
};

export const DEFAULT_PROJECT_AUDIT_POLICY: ArtifactAuditPolicy = {
  ...DEFAULT_ARTIFACT_AUDIT_POLICY,
};

export function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug);
}

/**
 * Domain invariant: project slugs must be unique across all projects. Slugs are
 * the public key for `/deploy/:slug/`, so two projects sharing a slug would
 * make deployment ambiguous. Returns true when no existing project uses `slug`.
 */
export function isSlugUnique(projects: Project[], slug: string): boolean {
  return !projects.some((project) => project.slug === slug);
}

/** Parses and validates a settings payload, returning `null` when invalid. */
export function parseSettings(input: unknown): Settings | null {
  const result = settingsSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Parses a PATCH payload without hydrating omitted asset budgets. */
export function parseArtifactAuditPolicy(
  input: unknown
): ArtifactAuditPolicyUpdate | null {
  const result = artifactAuditPolicyUpdateSchema.safeParse(input);
  return result.success ? result.data : null;
}

/** Validates a normalized policy after PATCH fields are merged in mutation. */
export function normalizeArtifactAuditPolicy(
  input: ArtifactAuditPolicyUpdate,
  stored: ArtifactAuditPolicy
): ArtifactAuditPolicy | null {
  const result = artifactAuditPolicySchema.safeParse({
    enforcement: input.enforcement,
    maxTotalBytes: input.maxTotalBytes,
    maxFileBytes: input.maxFileBytes,
    maxFileCount: input.maxFileCount,
    maxJavaScriptBytes: input.maxJavaScriptBytes ?? stored.maxJavaScriptBytes,
    maxStylesheetBytes: input.maxStylesheetBytes ?? stored.maxStylesheetBytes,
    maxFontBytes: input.maxFontBytes ?? stored.maxFontBytes,
  });
  return result.success ? result.data : null;
}
