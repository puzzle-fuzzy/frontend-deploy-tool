/**
 * Error thrown by services to produce a consistent HTTP error response.
 * `app.onError` converts it into `{ error: message }` with the given status.
 *
 * Implemented without TypeScript parameter properties so the type is safe to
 * reference from contexts that enable `erasableSyntaxOnly`.
 */
export class ApiError extends Error {
  readonly status: 400 | 404 | 500;

  constructor(message: string, status: 400 | 404 | 500 = 400) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
