import {
  type ApiErrorCode,
  ErrorCode as SharedErrorCode,
} from '@deploykit/shared/errors';

export const ErrorCode = SharedErrorCode;
export type ErrorCode = ApiErrorCode;

export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  readonly code: ErrorCode;

  constructor(
    code: ErrorCode,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 = 400
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
