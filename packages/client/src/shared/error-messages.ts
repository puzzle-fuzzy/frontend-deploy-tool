import type { ApiErrorCode } from '@deploykit/shared/errors';
import { ApiClientError } from '../api/errors';

const CODE_TO_I18N_KEY: Partial<Record<ApiErrorCode, string>> = {
  UNAUTHORIZED: 'error.unauthorized',
  INVALID_CREDENTIALS: 'error.invalidCredentials',
  EMAIL_ALREADY_EXISTS: 'error.emailAlreadyExists',
  REGISTRATION_DISABLED: 'error.registrationDisabled',
  FORBIDDEN: 'error.forbidden',
  NOT_A_MEMBER: 'error.notAMember',
  ALREADY_MEMBER: 'error.alreadyMember',
  CANNOT_REMOVE_LAST_OWNER: 'error.cannotRemoveLastOwner',
  USER_NOT_FOUND: 'error.userNotFound',
  PROJECT_NOT_FOUND: 'error.projectNotFound',
  PROJECT_SLUG_TAKEN: 'error.slugTaken',
  VERSION_NOT_FOUND: 'error.versionNotFound',
  INVALID_HISTORY_CURSOR: 'error.invalidHistoryCursor',
  TOO_MANY_FILES: 'error.tooManyFiles',
  PATH_TOO_LONG: 'error.pathTooLong',
  EXTRACTED_TOO_LARGE: 'error.extractedTooLarge',
  FILES_TOO_LARGE: 'error.extractedTooLarge',
  ZIP_TOO_LARGE: 'error.zipTooLarge',
  INTERNAL_ERROR: 'error.internalError',
};

/** Compatibility fallback for servers released before stable error codes. */
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
  fallback?: string
): string {
  if (err instanceof ApiClientError && err.code) {
    const key = CODE_TO_I18N_KEY[err.code];
    if (key) return t(key);
  }
  const message = err instanceof Error ? err.message : null;
  if (message) {
    const key = MESSAGE_TO_I18N_KEY[message];
    if (key) return t(key);
    return message;
  }
  return fallback ?? 'Unknown error';
}
