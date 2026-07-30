import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import {
  createApiTokenMiddleware,
  invalidApiTokenResponse,
  isApiTokenAuthenticationError,
} from '../middleware/apiToken';
import type { UploadRouteLimits } from '../middleware/uploadLimits';
import type {
  ApiTokenService,
  AppEnv,
  VersionService,
} from '../services/contracts';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]{1,128}$/;

export function createCiVersionRoutes(deps: {
  apiTokenService: ApiTokenService;
  versionService: VersionService;
  uploadRouteLimits: UploadRouteLimits;
}) {
  return new Hono<AppEnv>().post(
    '/projects/:id/versions',
    createApiTokenMiddleware(deps.apiTokenService),
    async (c, next) => {
      const idempotencyKey = c.req.header('Idempotency-Key');
      if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new ApiError(
          ErrorCode.INVALID_IDEMPOTENCY_KEY,
          'Idempotency-Key must be 1-128 URL-safe characters',
          400
        );
      }
      c.set('ciIdempotencyKey', idempotencyKey);
      await next();
    },
    bodyLimit({
      maxSize: deps.uploadRouteLimits.maxUploadRequestSize,
      onError: (c) =>
        c.json(
          {
            error: {
              code: ErrorCode.UPLOAD_TOO_LARGE,
              message: 'Upload request exceeds the configured limit',
            },
          },
          413
        ),
    }),
    deps.uploadRouteLimits.gate,
    async (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const principal = c.get('apiToken');
      const idempotencyKey = c.get('ciIdempotencyKey');
      if (!principal) return invalidApiTokenResponse(c);
      if (!idempotencyKey) {
        throw new ApiError(
          ErrorCode.INVALID_IDEMPOTENCY_KEY,
          'Idempotency-Key is required',
          400
        );
      }

      const formData = await c.req.formData();
      const versionDescRaw = formData.get('versionDesc');
      const versionDesc = (
        typeof versionDescRaw === 'string' ? versionDescRaw : ''
      ).trim();
      const fileEntry = formData.get('file');
      const file = fileEntry instanceof File ? fileEntry : null;
      const folderFiles = formData
        .getAll('folderFiles')
        .filter((entry): entry is File => entry instanceof File);

      try {
        const result = await deps.versionService.uploadCiVersion(
          projectId,
          { versionDesc, file, folderFiles },
          principal,
          idempotencyKey
        );
        c.header('Idempotency-Replayed', String(result.replayed));
        return c.json(result, result.replayed ? 200 : 201);
      } catch (error) {
        if (isApiTokenAuthenticationError(error)) {
          return invalidApiTokenResponse(c);
        }
        throw error;
      }
    }
  );
}
