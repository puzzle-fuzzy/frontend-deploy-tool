/**
 * Stable, machine-readable error codes plus the `ApiError` type. `app.onError`
 * converts an `ApiError` into `{ error: { code, message } }` with the given
 * status, so clients can switch on `code` and surface `message` to users.
 *
 * Implemented without TypeScript parameter properties or enums so the type is
 * safe to reference from contexts that enable `erasableSyntaxOnly`.
 */
export const ErrorCode = {
  PROJECT_NAME_REQUIRED: 'PROJECT_NAME_REQUIRED',
  PROJECT_SLUG_REQUIRED: 'PROJECT_SLUG_REQUIRED',
  PROJECT_SLUG_INVALID: 'PROJECT_SLUG_INVALID',
  PROJECT_SLUG_TAKEN: 'PROJECT_SLUG_TAKEN',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  EXTRACTED_TOO_LARGE: 'EXTRACTED_TOO_LARGE',
  FILES_TOO_LARGE: 'FILES_TOO_LARGE',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ApiError extends Error {
  readonly status: 400 | 404 | 500;
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, status: 400 | 404 | 500 = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
