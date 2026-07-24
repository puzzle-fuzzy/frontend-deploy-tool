import type { ApiErrorCode } from '@deploykit/shared/errors';

export interface SerializedApiError {
  message: string;
  status: number;
  code?: ApiErrorCode;
  requestId?: string;
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedApiError };
