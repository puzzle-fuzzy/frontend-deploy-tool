import type { MiddlewareHandler } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { AppEnv } from '../services/contracts';

export interface UploadGateOptions {
  maxConcurrentUploads: number;
  maxConcurrentUploadsPerUser: number;
  maxConcurrentUploadsPerProject: number;
}

export interface UploadRouteLimits {
  maxUploadRequestSize: number;
  gate: MiddlewareHandler<AppEnv>;
}

/**
 * In-process upload semaphore. DeployKit currently runs as one Bun process, so
 * this bounds the memory/disk pressure that multipart parsing and extraction
 * can create without introducing an external queue.
 */
export function createUploadGate(
  options: UploadGateOptions
): MiddlewareHandler<AppEnv> {
  let activeUploads = 0;
  const activeByPrincipal = new Map<string, number>();
  const activeByProject = new Map<string, number>();

  return async (c, next) => {
    const user = c.get('user');
    const apiToken = c.get('apiToken');
    let principalKey: string;
    if (user && !apiToken) {
      principalKey = `user:${user.id}`;
    } else if (apiToken && !user) {
      principalKey = `api-token:${apiToken.tokenId}`;
    } else {
      throw new ApiError(
        ErrorCode.UNAUTHORIZED,
        'Authentication required',
        401
      );
    }
    const projectId = parseIdParam(c.req.param('id'));
    const principalCount = activeByPrincipal.get(principalKey) ?? 0;
    const projectCount = activeByProject.get(projectId) ?? 0;

    if (
      activeUploads >= options.maxConcurrentUploads ||
      principalCount >= options.maxConcurrentUploadsPerUser ||
      projectCount >= options.maxConcurrentUploadsPerProject
    ) {
      throw new ApiError(
        ErrorCode.UPLOAD_BUSY,
        'Upload capacity is busy; retry after an active upload finishes',
        429
      );
    }

    activeUploads += 1;
    activeByPrincipal.set(principalKey, principalCount + 1);
    activeByProject.set(projectId, projectCount + 1);
    try {
      await next();
    } finally {
      activeUploads -= 1;
      decrement(activeByPrincipal, principalKey);
      decrement(activeByProject, projectId);
    }
  };
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
}
