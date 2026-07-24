import {
  type ApiErrorCode,
  parseApiErrorEnvelope,
} from '@deploykit/shared/errors';

export interface ParsedApiError {
  code?: ApiErrorCode;
  message: string;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: ApiErrorCode;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code?: ApiErrorCode,
    requestId?: string
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function extractApiError(text: string): ParsedApiError {
  try {
    const raw = JSON.parse(text) as unknown;
    const parsed = parseApiErrorEnvelope(raw);
    if (parsed) return parsed.error;
    if (
      raw &&
      typeof raw === 'object' &&
      'error' in raw &&
      raw.error &&
      typeof raw.error === 'object' &&
      'message' in raw.error &&
      typeof raw.error.message === 'string'
    ) {
      return { message: raw.error.message };
    }
    return { message: text };
  } catch {
    return { message: text };
  }
}

export function extractMessage(text: string): string {
  return extractApiError(text).message;
}

export function createApiClientError(
  status: number,
  text: string,
  statusText: string,
  requestId?: string | null
): ApiClientError {
  const parsed = extractApiError(text);
  return new ApiClientError(
    parsed.message || statusText || `HTTP ${status}`,
    status,
    parsed.code,
    requestId || undefined
  );
}

export async function checkOk(res: {
  ok: boolean;
  status?: number;
  statusText: string;
  headers?: { get: (name: string) => string | null };
  text: () => Promise<string>;
}): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  throw createApiClientError(
    res.status ?? 0,
    text,
    res.statusText,
    res.headers?.get('X-Request-Id')
  );
}
