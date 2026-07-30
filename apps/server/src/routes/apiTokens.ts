import { Hono } from 'hono';
import { validator } from 'hono/validator';
import {
  parseCreateApiToken,
  parseIdParam,
  parseRotateApiToken,
} from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import { requireProjectRole } from '../middleware/auth';
import type {
  ApiTokenService,
  AppEnv,
  ProjectService,
} from '../services/contracts';

export function createApiTokenRoutes(deps: {
  apiTokenService: ApiTokenService;
  projectService: ProjectService;
}) {
  const { apiTokenService, projectService } = deps;
  const ownerOnly = requireProjectRole('owner', () => projectService);

  return new Hono<AppEnv>()
    .get('/api/projects/:id/api-tokens', ownerOnly, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      return c.json({ tokens: apiTokenService.list(projectId) });
    })
    .post(
      '/api/projects/:id/api-tokens',
      ownerOnly,
      validator('json', parseCreateApiToken),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        c.header('Cache-Control', 'no-store');
        return c.json(
          apiTokenService.create(
            projectId,
            c.req.valid('json'),
            requireActorId(c)
          ),
          201
        );
      }
    )
    .post(
      '/api/projects/:id/api-tokens/:tokenId/rotate',
      ownerOnly,
      validator('json', parseRotateApiToken),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const tokenId = parseIdParam(c.req.param('tokenId'));
        c.header('Cache-Control', 'no-store');
        return c.json(
          apiTokenService.rotate(
            projectId,
            tokenId,
            c.req.valid('json'),
            requireActorId(c)
          ),
          201
        );
      }
    )
    .delete('/api/projects/:id/api-tokens/:tokenId', ownerOnly, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const tokenId = parseIdParam(c.req.param('tokenId'));
      return c.json({
        token: apiTokenService.revoke(projectId, tokenId, requireActorId(c)),
      });
    })
    .get('/api/projects/:id/api-tokens/security-events', ownerOnly, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      return c.json({
        events: apiTokenService.listSecurityEvents(projectId),
      });
    });
}

function requireActorId(c: {
  get: (key: 'user') => { id: string } | null;
}): string {
  const actorId = c.get('user')?.id;
  if (!actorId) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
  }
  return actorId;
}
