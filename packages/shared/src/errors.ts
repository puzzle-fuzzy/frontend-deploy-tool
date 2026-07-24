/**
 * Stable machine-readable failures shared by the server, web renderer, and
 * Electron main process. Human-readable messages may evolve; these values must
 * remain backward compatible.
 */
export const ErrorCode = {
  PROJECT_NAME_REQUIRED: 'PROJECT_NAME_REQUIRED',
  PROJECT_SLUG_REQUIRED: 'PROJECT_SLUG_REQUIRED',
  PROJECT_SLUG_INVALID: 'PROJECT_SLUG_INVALID',
  PROJECT_SLUG_TAKEN: 'PROJECT_SLUG_TAKEN',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  REGISTRATION_DISABLED: 'REGISTRATION_DISABLED',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  INVALID_HISTORY_CURSOR: 'INVALID_HISTORY_CURSOR',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  UNSAFE_ENTRY: 'UNSAFE_ENTRY',
  MISSING_INDEX_HTML: 'MISSING_INDEX_HTML',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  EXTRACTED_TOO_LARGE: 'EXTRACTED_TOO_LARGE',
  FILES_TOO_LARGE: 'FILES_TOO_LARGE',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  DESKTOP_AUTH_CODE_INVALID: 'DESKTOP_AUTH_CODE_INVALID',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  CANNOT_REMOVE_LAST_OWNER: 'CANNOT_REMOVE_LAST_OWNER',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export type ApiErrorCode = ErrorCode;

const errorCodeValues = new Set<string>(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && errorCodeValues.has(value);
}

export interface ApiErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Lightweight runtime decoder that does not pull Zod into browser bundles. */
export function parseApiErrorEnvelope(value: unknown): ApiErrorEnvelope | null {
  if (!value || typeof value !== 'object' || !('error' in value)) return null;
  const error = value.error;
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    !('message' in error) ||
    !isErrorCode(error.code) ||
    typeof error.message !== 'string'
  ) {
    return null;
  }
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
