/**
 * Maps server-side English error messages to i18n keys so the client
 * can display localized error text. The server always returns errors in
 * English; this lookup runs on the client before showing the toast.
 */

const MESSAGE_TO_I18N_KEY: Record<string, string> = {
  // Auth
  'Authentication required': 'error.unauthorized',
  'Invalid email or password': 'error.invalidCredentials',
  'Email is already registered': 'error.emailAlreadyExists',
  'Registration is disabled': 'error.registrationDisabled',
  // Permissions
  'Insufficient permissions': 'error.forbidden',
  'Owner access required': 'error.forbidden',
  'Not a project member': 'error.notAMember',
  'User is not a member': 'error.notAMember',
  'User is already a member': 'error.alreadyMember',
  'Cannot remove the last owner': 'error.cannotRemoveLastOwner',
  'User not found with that email': 'error.userNotFound',
  // Projects
  'Project not found': 'error.projectNotFound',
  'Project slug already exists': 'error.slugTaken',
  // Versions
  'Version not found': 'error.versionNotFound',
  // Upload
  'Too many files': 'error.tooManyFiles',
  'Path too long': 'error.pathTooLong',
  'Total size too large': 'error.extractedTooLarge',
  'Zip too large': 'error.zipTooLarge',
  // Generic
  'Internal Server Error': 'error.internalError',
};

/**
 * Returns a localized error message if a known server error string is detected,
 * otherwise falls back to the raw error message. For non-Error thrown values
 * the `fallback` is used (typically `t('common.failed')`).
 */
export function getLocalizedError(
  err: unknown,
  t: (key: string) => string,
  fallback?: string,
): string {
  const message = err instanceof Error ? err.message : null;
  if (message) {
    const key = MESSAGE_TO_I18N_KEY[message];
    if (key) return t(key);
    return message;
  }
  return fallback ?? 'Unknown error';
}
