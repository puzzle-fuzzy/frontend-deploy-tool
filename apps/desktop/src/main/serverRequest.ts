import { net, type Session } from 'electron';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** JSON body (for non-multipart requests). */
  body?: unknown;
  /** Pre-built multipart body with on-write progress reporting. */
  multipart?: { chunks: Buffer[]; totalBytes: number };
  onProgress?: (percent: number) => void;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

/** Thrown on non-2xx; message is the server's `{ error.message }`. */
export class ServerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
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
export function extractMessage(text: string): string {
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

/**
 * Pure response decoder shared with tests. Returns the parsed body on 2xx, or
 * throws a `ServerError` on non-2xx (message = server's `{ error.message }`,
 * falling back to the raw text then `HTTP <status>`).
 */
export function parseResponseBody<T>(
  status: number,
  text: string
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
  throw new ServerError(extractMessage(text) || `HTTP ${status}`, status);
}

export function serverRequest<T>(
  ses: Session,
  origin: string,
  opts: RequestOptions
): Promise<RequestResult<T>> {
  return new Promise((resolve, reject) => {
    const url = `${origin}${opts.path}`;
    const req = net.request({ url, session: ses, method: opts.method });

    // Compute the JSON body once (cleaner than a __jsonBody side-channel).
    const jsonBody =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

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
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode;
        try {
          const { data } = parseResponseBody<T>(status, text);
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
  });
}
