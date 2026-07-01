import type { AuditProfile } from '@deploykit/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { AuditService } from '../services/contracts';

interface AuditRequestBody {
  profile?: AuditProfile;
}

export function createAuditRoutes(deps: { auditService: AuditService }) {
  const { auditService } = deps;
  const runAudit = async (
    c: Context<
      never,
      '/api/projects/:id/versions/:versionId/audit',
      { in: { json: AuditRequestBody } }
    >
  ) => {
    const projectId = parseIdParam(c.req.param('id'));
    const versionId = parseIdParam(c.req.param('versionId'));
    const body = await parseAuditRequestBody(c.req.raw);

    return c.json(
      auditService.runVersionAudit(projectId, versionId, body.profile)
    );
  };

  return new Hono().post('/api/projects/:id/versions/:versionId/audit', runAudit);
}

async function parseAuditRequestBody(request: Request): Promise<AuditRequestBody> {
  if (!request.body) {
    return {};
  }

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid request payload');
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as AuditRequestBody;
}
