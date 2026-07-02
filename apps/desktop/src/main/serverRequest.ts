import type { Session } from 'electron';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  multipart?: FormData;
  onProgress?: (percent: number) => void;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

export async function serverRequest<T>(
  _session: Session,
  _origin: string,
  _opts: RequestOptions
): Promise<RequestResult<T>> {
  throw new Error('serverRequest not implemented yet (Task 7)');
}
