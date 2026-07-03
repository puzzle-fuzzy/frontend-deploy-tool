import type {
  CreateProjectInput,
  HistoryEvent,
  Project,
  Settings,
} from '@deploykit/shared';
import { appendHistoryEvent, parseHistoryLimit } from '../domain/history';
import { DEFAULT_PROJECT_SETTINGS, isSlugUnique } from '../domain/project';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
import type { ProjectService } from './contracts';

export type { ProjectService } from './contracts';

export function createProjectService(repo: ProjectRepository): ProjectService {
  return {
    listProjects(): Project[] {
      return repo.load().projects;
    },

    createProject(input: CreateProjectInput, actorId: string): Project {
      const data = repo.load();
      if (!isSlugUnique(data.projects, input.slug)) {
        throw new ApiError(
          ErrorCode.PROJECT_SLUG_TAKEN,
          'Project slug already exists'
        );
      }

      const project: Project = {
        id: createId(),
        name: input.name,
        slug: input.slug,
        description: input.description,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: [],
        activeVersionId: null,
        settings: { ...DEFAULT_PROJECT_SETTINGS },
        createdBy: actorId,
        members: [{ userId: actorId, role: 'owner', invitedAt: new Date().toISOString() }],
      };
      data.projects.push(project);
      appendHistoryEvent(data, 'project.create', project, actorId);
      repo.save(data);
      return project;
    },

    getProject(id: string): Project {
      const project = repo.load().projects.find((p) => p.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      return project;
    },

    findBySlug(slug: string): Project | undefined {
      return repo.load().projects.find((p) => p.slug === slug);
    },

    updateProjectSettings(
      id: string,
      settings: Settings,
      actorId: string
    ): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const previousSettings = project.settings;
      const changed =
        previousSettings.spaMode !== settings.spaMode ||
        previousSettings.routingType !== settings.routingType;
      if (!changed) return project;

      project.settings = settings;
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(
        data,
        'project.update_settings',
        project,
        actorId,
        undefined,
        {
          previousSettings,
          settings,
        }
      );
      repo.save(data);
      return project;
    },

    updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string },
      actorId: string
    ): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const changes: Record<string, { from: string; to: string }> = {};
      if (updates.name !== undefined) {
        if (project.name !== updates.name) {
          changes.name = { from: project.name, to: updates.name };
        }
        project.name = updates.name;
      }
      if (updates.slug !== undefined) {
        const newSlug = updates.slug;
        // Check slug uniqueness
        const slugExists = data.projects.some(
          (p) => p.id !== id && p.slug === newSlug
        );
        if (slugExists)
          throw new ApiError(
            ErrorCode.PROJECT_SLUG_TAKEN,
            'Slug already exists',
            400
          );
        if (project.slug !== newSlug) {
          changes.slug = { from: project.slug, to: newSlug };
        }
        project.slug = newSlug;
      }
      if (updates.description !== undefined) {
        if (project.description !== updates.description) {
          changes.description = {
            from: project.description,
            to: updates.description,
          };
        }
        project.description = updates.description;
      }
      if (Object.keys(changes).length === 0) return project;

      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'project.update', project, actorId, undefined, {
        changes,
      });
      repo.save(data);
      return project;
    },

    deleteProject(id: string, actorId: string): Project {
      const data = repo.load();
      const idx = data.projects.findIndex((p) => p.id === id);
      if (idx === -1)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const removed = data.projects.splice(idx, 1)[0];
      appendHistoryEvent(data, 'project.delete', removed, actorId);
      repo.save(data);
      return removed;
    },

    addMember(projectId: string, email: string, role: 'owner' | 'member', actorId: string): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
      const user = data.users.find((u) => u.email === email);
      if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND, 'User not found with that email', 404);
      if (project.members.some((m) => m.userId === user.id)) {
        throw new ApiError(ErrorCode.ALREADY_MEMBER, 'User is already a member', 400);
      }
      project.members.push({ userId: user.id, role, invitedAt: new Date().toISOString() });
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'project.update', project, actorId);
      repo.save(data);
      return project;
    },

    removeMember(projectId: string, userId: string, actorId: string): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
      const idx = project.members.findIndex((m) => m.userId === userId);
      if (idx === -1) throw new ApiError(ErrorCode.NOT_A_MEMBER, 'User is not a member', 404);
      if (project.members[idx].role === 'owner' && project.members.filter((m) => m.role === 'owner').length <= 1) {
        throw new ApiError(ErrorCode.CANNOT_REMOVE_LAST_OWNER, 'Cannot remove the last owner', 403);
      }
      project.members.splice(idx, 1);
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'project.update', project, actorId);
      repo.save(data);
      return project;
    },

    transferOwnership(projectId: string, targetUserId: string, actorId: string): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
      const target = project.members.find((m) => m.userId === targetUserId);
      if (!target) throw new ApiError(ErrorCode.NOT_A_MEMBER, 'Target user is not a member', 404);
      const actor = project.members.find((m) => m.userId === actorId);
      if (!actor || actor.role !== 'owner') throw new ApiError(ErrorCode.FORBIDDEN, 'Owner access required', 403);
      target.role = 'owner';
      actor.role = 'member';
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'project.update', project, actorId);
      repo.save(data);
      return project;
    },

    listHistory(limit?: string): HistoryEvent[] {
      const max = parseHistoryLimit(limit);
      return repo.load().history.slice(0, max);
    },

    listProjectHistory(projectId: string, limit?: string): HistoryEvent[] {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      const max = parseHistoryLimit(limit);
      return data.history
        .filter((event) => event.projectId === projectId)
        .slice(0, max);
    },
  };
}
