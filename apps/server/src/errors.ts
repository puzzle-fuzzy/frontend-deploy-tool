/**
 * Error thrown by services to produce a consistent HTTP error response.
 * `app.onError` converts it into `{ error: message }` with the given status.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500 = 400
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
