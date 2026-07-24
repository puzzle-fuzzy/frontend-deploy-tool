import {
  type ApiErrorCode,
  parseApiErrorEnvelope,
} from '@deploykit/shared/errors';
import { net, type Session } from 'electron';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** JSON body (for non-multipart requests). */
  body?: unknown;
  /** Optional request headers for bearer auth or other metadata. */
  headers?: Record<string, string>;
  /** Pre-built multipart body with on-write progress reporting. */
  multipart?: { chunks: Buffer[]; totalBytes: number };
  onProgress?: (percent: number) => void;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

/** Thrown on non-2xx with the stable server error identity intact. */
export class ServerError extends Error {
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
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Thrown when the request never reaches the server / connection fails. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Pulls `error.message` out of the server's JSON error envelope. Mirrors
 * `extractMessage` in `@deploykit/client` — inlined here (rather than imported
 * through the client barrel) so the main process never transitively loads
 * renderer-only code (e.g. `shared/config`, which reads `window`).
 */
export function extractServerError(text: string): {
  message: string;
  code?: ApiErrorCode;
} {
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
  return extractServerError(text).message;
}

/**
 * Pure response decoder shared with tests. Returns the parsed body on 2xx, or
 * throws a `ServerError` on non-2xx (message = server's `{ error.message }`,
 * falling back to the raw text then `HTTP <status>`).
 */
export function parseResponseBody<T>(
  status: number,
  text: string,
  requestId?: string
): {
  isError: false;
  data: T;
} {
  if (status >= 200 && status < 300) {
    let data: T;
    try {
      data = (text ? JSON.parse(text) : {}) as T;
    } catch {
      data = text as unknown as T;
    }
    return { isError: false, data };
  }
  const parsed = extractServerError(text);
  throw new ServerError(
    parsed.message || `HTTP ${status}`,
    status,
    parsed.code,
    requestId
  );
}

export function serverRequest<T>(
  ses: Session,
  origin: string,
  opts: RequestOptions
): Promise<RequestResult<T>> {
  return new Promise((resolve, reject) => {
    const performRequest = (attempt = 0) => {
      const url = `${origin}${opts.path}`;
      const req = net.request({ url, session: ses, method: opts.method });

      // Compute the JSON body once (cleaner than a __jsonBody side-channel).
      const jsonBody =
        opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

      if (opts.headers) {
        for (const [name, value] of Object.entries(opts.headers)) {
          req.setHeader(name, value);
        }
      }
      if (jsonBody !== undefined) {
        req.setHeader('Content-Type', 'application/json');
      }
      if (opts.multipart) {
        req.setHeader(
          'Content-Type',
          'multipart/form-data; boundary=----deploykit'
        );
        req.setHeader('Content-Length', String(opts.multipart.totalBytes));
      }

      req.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode;

          try {
            const raw = response.headers['set-cookie'];
            const needsCookieSync =
              Boolean(raw) &&
              (opts.path.startsWith('/api/auth/login') ||
                opts.path.startsWith('/api/auth/register') ||
                opts.path.startsWith('/api/desktop/'));
            const cookiePromises: Array<Promise<void>> = [];
            if (raw) {
              const cookies = Array.isArray(raw) ? raw : [raw];
              for (const header of cookies) {
                const semi = header.indexOf(';');
                const eq = header.indexOf('=');
                if (eq === -1) continue;
                const name = header.slice(0, eq);
                const value =
                  semi > 0 ? header.slice(eq + 1, semi) : header.slice(eq + 1);
                const cookieOpts: Electron.CookiesSetDetails = {
                  url: origin,
                  name,
                  value,
                  path: '/',
                  httpOnly: true,
                  secure: false,
                  sameSite: 'lax',
                };
                const maxAge = header.match(/Max-Age=(\d+)/i);
                if (maxAge) {
                  cookieOpts.expirationDate =
                    Math.floor(Date.now() / 1000) + Number(maxAge[1]);
                }
                cookiePromises.push(
                  ses.cookies.set(cookieOpts).catch((err) => {
                    console.error('[deploykit] Failed to persist cookie:', err);
                  })
                );
              }
            }

            if (needsCookieSync) {
              void Promise.all(cookiePromises);
            }

            const shouldRetry =
              status === 401 &&
              attempt === 0 &&
              !opts.path.startsWith('/api/auth/') &&
              !opts.path.startsWith('/api/desktop/') &&
              Boolean(ses?.cookies?.set);

            if (shouldRetry) {
              setTimeout(() => performRequest(1), 150);
              return;
            }

            const requestId = firstHeaderValue(
              response.headers['x-request-id']
            );
            const { data } = parseResponseBody<T>(status, text, requestId);
            resolve({ status, data });
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', (err) => reject(new NetworkError(err.message)));

      // Write body.
      if (jsonBody !== undefined) {
        req.write(jsonBody, 'utf8');
      } else if (opts.multipart) {
        let written = 0;
        for (const chunk of opts.multipart.chunks) {
          req.write(chunk);
          written += chunk.length;
          if (opts.onProgress) {
            opts.onProgress(
              Math.round((written / opts.multipart.totalBytes) * 100)
            );
          }
        }
      }
      req.end();
    };

    performRequest();
  });
}

function firstHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
