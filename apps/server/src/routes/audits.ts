import type { AuditProfile } from '@deploykit/shared';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseIdParam } from '../domain/schemas';
import type { AuditService } from '../services/contracts';

interface AuditRequestBody {
  profile?: AuditProfile;
}

export function createAuditRoutes(deps: { auditService: AuditService }) {
  const { auditService } = deps;

  return new Hono().post(
    '/api/projects/:id/versions/:versionId/audit',
    validator('json', parseAuditRequestBody),
    (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const body = c.req.valid('json');

      return c.json(
        auditService.runVersionAudit(projectId, versionId, body.profile)
      );
    }
  );
}

function parseAuditRequestBody(value: unknown): AuditRequestBody {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as AuditRequestBody;
}
