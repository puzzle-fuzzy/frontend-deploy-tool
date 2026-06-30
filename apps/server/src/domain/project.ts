import type { Settings } from '@deploykit/shared';

export const DEFAULT_PROJECT_SETTINGS: Settings = {
  spaMode: false,
  routingType: 'path',
};

export function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug);
}

/** Parses and validates a settings payload, returning `null` when invalid. */
export function parseSettings(input: unknown): Settings | null {
  if (!input || typeof input !== 'object') return null;
  const body = input as Partial<Settings>;
  if (typeof body.spaMode !== 'boolean') return null;
  if (body.routingType !== 'hash' && body.routingType !== 'path') return null;
  return { spaMode: body.spaMode, routingType: body.routingType };
}
