import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { ApiError, ErrorCode } from '../errors';
import { requireProjectRole } from '../middleware/auth';
import type { AppEnv, ProjectService } from '../services/contracts';

export function createMemberRoutes(deps: {
  projectService: ProjectService;
}) {
  const { projectService } = deps;

  return new Hono<AppEnv>()
    .post(
      '/api/projects/:id/members',
      requireProjectRole('owner', () => projectService),
      validator('json', (value) => {
        const parsed = z
          .object({ email: z.string().email(), role: z.enum(['owner', 'member']).default('member') })
          .safeParse(value);
        if (!parsed.success) throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid member data', 400);
        return parsed.data;
      }),
      (c) => {
        const { email, role } = c.req.valid('json');
        const project = projectService.addMember(c.req.param('id'), email, role, c.get('user')!.id);
        return c.json({ project });
      },
    )
    .delete(
      '/api/projects/:id/members/:userId',
      requireProjectRole('owner', () => projectService),
      (c) => {
        projectService.removeMember(c.req.param('id'), c.req.param('userId'), c.get('user')!.id);
        return c.json({ ok: true });
      },
    )
    .post(
      '/api/projects/:id/transfer',
      requireProjectRole('owner', () => projectService),
      validator('json', (value) => {
        const parsed = z.object({ targetUserId: z.string() }).safeParse(value);
        if (!parsed.success) throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid transfer data', 400);
        return parsed.data;
      }),
      (c) => {
        const { targetUserId } = c.req.valid('json');
        const project = projectService.transferOwnership(c.req.param('id'), targetUserId, c.get('user')!.id);
        return c.json({ project });
      },
    );
}
