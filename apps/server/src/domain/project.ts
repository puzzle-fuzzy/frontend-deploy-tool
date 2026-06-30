import type { Settings } from '@deploykit/shared';

export const DEFAULT_PROJECT_SETTINGS: Settings = {
  spaMode: false,
  routingType: 'path',
};

export function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug);
}
