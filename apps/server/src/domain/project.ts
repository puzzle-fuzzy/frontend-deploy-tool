import { type Project, type Settings, settingsSchema } from '@deploykit/shared';

export const DEFAULT_PROJECT_SETTINGS: Settings = {
  spaMode: false,
  routingType: 'path',
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
