import type { Project, SafeUser } from '@deploykit/shared';

/** Minimal authenticated principal consumed by pure authorization rules. */
export type Actor = Pick<SafeUser, 'id' | 'role'>;

/** Admins can read every project; other users must be explicit members. */
export function canReadProject(actor: Actor, project: Project): boolean {
  return (
    actor.role === 'admin' ||
    project.members.some((member) => member.userId === actor.id)
  );
}

/** A global viewer is read-only even on a self-service installation. */
export function canCreateProject(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'developer';
}

/**
 * Project writes require both a global write-capable role and the requested
 * project membership. Administrators bypass project membership checks.
 */
export function hasProjectRole(
  actor: Actor,
  project: Project,
  minimum: 'member' | 'owner'
): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'developer') return false;

  const membership = project.members.find(
    (member) => member.userId === actor.id
  );
  if (!membership) return false;
  return minimum === 'member' || membership.role === 'owner';
}
