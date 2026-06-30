import { describe, expect, test } from 'bun:test';
import {
  createProjectSchema,
  parseCreateProject,
  parseIdParam,
} from '../../src/domain/schemas';
import { ApiError, ErrorCode } from '../../src/errors';

/** Asserts `fn` throws an ApiError with the exact code and message. */
function expectApiError(
  fn: () => unknown,
  code: ErrorCode,
  message: string
): void {
  try {
    fn();
    throw new Error('expected the function to throw');
  } catch (err) {
    if (!(err instanceof ApiError)) {
      throw new Error(`expected ApiError, got ${typeof err}`);
    }
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  }
}

describe('parseCreateProject', () => {
  test('trims and lowercases a valid payload', () => {
    const input = parseCreateProject({
      name: '  Demo App  ',
      slug: '  Demo-App  ',
      description: '  hello  ',
    });
    expect(input).toEqual({
      name: 'Demo App',
      slug: 'demo-app',
      description: 'hello',
    });
  });

  test('defaults a missing description to an empty string', () => {
    const input = parseCreateProject({ name: 'Demo', slug: 'demo' });
    expect(input.description).toBe('');
  });

  test('throws PROJECT_NAME_REQUIRED when the name is missing', () => {
    expectApiError(
      () => parseCreateProject({ slug: 'demo' }),
      ErrorCode.PROJECT_NAME_REQUIRED,
      'Project name is required'
    );
  });

  test('throws PROJECT_SLUG_REQUIRED when the slug is missing', () => {
    expectApiError(
      () => parseCreateProject({ name: 'Demo' }),
      ErrorCode.PROJECT_SLUG_REQUIRED,
      'Project slug is required'
    );
  });

  test('throws PROJECT_SLUG_INVALID for a malformed slug', () => {
    expectApiError(
      () => parseCreateProject({ name: 'Demo', slug: 'ab' }),
      ErrorCode.PROJECT_SLUG_INVALID,
      'Project slug must be 3-64 lowercase letters, numbers, or hyphens'
    );
  });

  test('falls back to INVALID_REQUEST for a non-object body', () => {
    expectApiError(
      () => parseCreateProject(null),
      ErrorCode.INVALID_REQUEST,
      'Invalid request body'
    );
    expectApiError(
      () => parseCreateProject('not-an-object'),
      ErrorCode.INVALID_REQUEST,
      'Invalid request body'
    );
  });
});

describe('createProjectSchema', () => {
  test('accepts and normalizes a valid body via safeParse', () => {
    const result = createProjectSchema.safeParse({ name: 'X', slug: 'DEMO' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'X', slug: 'demo', description: '' });
    }
  });
});

describe('parseIdParam', () => {
  test('accepts a url-safe id', () => {
    expect(parseIdParam('V1StGXR8_Z5jdHi6B-myT')).toBe('V1StGXR8_Z5jdHi6B-myT');
  });

  test('rejects empty, spaced, traversal, and over-long ids', () => {
    expectApiError(
      () => parseIdParam(''),
      ErrorCode.INVALID_PARAMS,
      'Invalid id parameter'
    );
    expect(() => parseIdParam('has space')).toThrow(ApiError);
    expect(() => parseIdParam('../escape')).toThrow(ApiError);
    expect(() => parseIdParam(`${'a'.repeat(65)}`)).toThrow(ApiError);
  });
});
