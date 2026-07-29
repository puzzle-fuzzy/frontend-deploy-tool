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
  const activeByUser = new Map<string, number>();
  const activeByProject = new Map<string, number>();

  return async (c, next) => {
    const actor = c.get('user');
    if (!actor) {
      throw new ApiError(
        ErrorCode.UNAUTHORIZED,
        'Authentication required',
        401
      );
    }
    const projectId = parseIdParam(c.req.param('id'));
    const userCount = activeByUser.get(actor.id) ?? 0;
    const projectCount = activeByProject.get(projectId) ?? 0;

    if (
      activeUploads >= options.maxConcurrentUploads ||
      userCount >= options.maxConcurrentUploadsPerUser ||
      projectCount >= options.maxConcurrentUploadsPerProject
    ) {
      throw new ApiError(
        ErrorCode.UPLOAD_BUSY,
        'Upload capacity is busy; retry after an active upload finishes',
        429
      );
    }

    activeUploads += 1;
    activeByUser.set(actor.id, userCount + 1);
    activeByProject.set(projectId, projectCount + 1);
    try {
      await next();
    } finally {
      activeUploads -= 1;
      decrement(activeByUser, actor.id);
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
