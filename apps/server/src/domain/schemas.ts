import type { CreateProjectInput } from '@deploykit/shared';
import { z } from 'zod';
import { ApiError, ErrorCode } from '../errors';
import { isValidProjectSlug } from './project';

/**
 * Zod-based request validators. Each `parse*` helper runs a schema and throws an
 * {@link ApiError} (converted to `{ error: { code, message } }` by `app.onError`)
 * on failure, so routes get a typed value with no casts.
 */

const ID_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const idParamSchema = z.string().regex(ID_PARAM_PATTERN);

/** Throws `INVALID_PARAMS` (400) when a route id parameter is malformed. */
export function parseIdParam(raw: string | undefined): string {
  const result = idParamSchema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(ErrorCode.INVALID_PARAMS, 'Invalid id parameter');
  }
  return result.data;
}

// Internal tokens carried in zod issue messages, mapped to stable error codes.
const NAME_REQUIRED = 'NAME_REQUIRED';
const SLUG_REQUIRED = 'SLUG_REQUIRED';
const SLUG_INVALID = 'SLUG_INVALID';

const createProjectErrorMap: Record<
  string,
  { code: ErrorCode; message: string }
> = {
  [NAME_REQUIRED]: {
    code: ErrorCode.PROJECT_NAME_REQUIRED,
    message: 'Project name is required',
  },
  [SLUG_REQUIRED]: {
    code: ErrorCode.PROJECT_SLUG_REQUIRED,
    message: 'Project slug is required',
  },
  [SLUG_INVALID]: {
    code: ErrorCode.PROJECT_SLUG_INVALID,
    message: 'Project slug must be 3-64 lowercase letters, numbers, or hyphens',
  },
};

export const createProjectSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const name = (value.name ?? '').trim();
    const slug = (value.slug ?? '').trim().toLowerCase();
    if (!name) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: NAME_REQUIRED });
    } else if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['slug'], message: SLUG_REQUIRED });
    } else if (!isValidProjectSlug(slug)) {
      ctx.addIssue({ code: 'custom', path: ['slug'], message: SLUG_INVALID });
    }
  })
  .transform((value) => ({
    name: (value.name ?? '').trim(),
    slug: (value.slug ?? '').trim().toLowerCase(),
    description: (value.description ?? '').trim(),
  }));

/**
 * Validates a create-project JSON body, returning a trimmed
 * {@link CreateProjectInput}. Throws an `ApiError` with the specific field code
 * on failure.
 */
export function parseCreateProject(value: unknown): CreateProjectInput {
  const result = createProjectSchema.safeParse(value);
  if (!result.success) {
    const token = result.error.issues[0]?.message ?? '';
    const mapped = createProjectErrorMap[token] ?? {
      code: ErrorCode.INVALID_REQUEST,
      message: 'Invalid request body',
    };
    throw new ApiError(mapped.code, mapped.message);
  }
  return result.data;
}
