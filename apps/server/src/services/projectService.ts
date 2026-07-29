import type {
  ArtifactAuditPolicy,
  CreateProjectInput,
  HistoryPage,
  Project,
  Settings,
} from '@deploykit/shared';
import {
  type Actor,
  canReadProject,
  hasProjectRole,
} from '../domain/authorization';
import { appendHistoryEvent, paginateHistory } from '../domain/history';
import {
  DEFAULT_PROJECT_AUDIT_POLICY,
  DEFAULT_PROJECT_SETTINGS,
  isSlugUnique,
} from '../domain/project';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
import type { ArtifactRecoveryService } from './artifactRecovery';
import type { ProjectService } from './contracts';

export type { ProjectService } from './contracts';

export function createProjectService(
  repo: ProjectRepository,
  options: { artifactRecovery?: ArtifactRecoveryService } = {}
): ProjectService {
  return {
    listProjects(actor: Actor): Project[] {
      return repo
        .load()
        .projects.filter((project) => canReadProject(actor, project));
    },

    createProject(input: CreateProjectInput, actorId: string): Project {
      return repo.mutate((data) => {
        if (!isSlugUnique(data.projects, input.slug)) {
          throw new ApiError(
            ErrorCode.PROJECT_SLUG_TAKEN,
            'Project slug already exists'
          );
        }

        const now = new Date().toISOString();
        const project: Project = {
          id: createId(),
          name: input.name,
          slug: input.slug,
          description: input.description,
          createdAt: now,
          updatedAt: now,
          versions: [],
          activeVersionId: null,
          settings: { ...DEFAULT_PROJECT_SETTINGS },
          auditPolicy: { ...DEFAULT_PROJECT_AUDIT_POLICY },
          createdBy: actorId,
          members: [
            {
              userId: actorId,
              role: 'owner',
              invitedAt: now,
            },
          ],
        };
        data.projects.push(project);
        appendHistoryEvent(data, 'project.create', project, actorId);
        return project;
      });
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

    getProjectForActor(id: string, actor: Actor): Project {
      const project = repo
        .load()
        .projects.find((candidate) => candidate.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      if (!canReadProject(actor, project)) {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Project access required', 403);
      }
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
      return repo.mutate((data) => {
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
        return project;
      });
    },

    updateProjectAuditPolicy(
      id: string,
      auditPolicy: ArtifactAuditPolicy,
      actorId: string
    ): Project {
      return repo.mutate((data) => {
        const project = data.projects.find((candidate) => candidate.id === id);
        if (!project) {
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        }

        const previousPolicy = project.auditPolicy;
        if (
          previousPolicy.enforcement === auditPolicy.enforcement &&
          previousPolicy.maxTotalBytes === auditPolicy.maxTotalBytes &&
          previousPolicy.maxFileBytes === auditPolicy.maxFileBytes &&
          previousPolicy.maxFileCount === auditPolicy.maxFileCount
        ) {
          return project;
        }

        project.auditPolicy = auditPolicy;
        project.updatedAt = new Date().toISOString();
        appendHistoryEvent(
          data,
          'project.update_audit_policy',
          project,
          actorId,
          undefined,
          { previousPolicy, auditPolicy }
        );
        return project;
      });
    },

    updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string },
      actorId: string
    ): Project {
      return repo.mutate((data) => {
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
        appendHistoryEvent(
          data,
          'project.update',
          project,
          actorId,
          undefined,
          {
            changes,
          }
        );
        return project;
      });
    },

    deleteProject(id: string, actorId: string): Project {
      const lease = options.artifactRecovery?.stageProjectDeletion(id);
      try {
        const removed = repo.mutate((data) => {
          const idx = data.projects.findIndex((p) => p.id === id);
          if (idx === -1)
            throw new ApiError(
              ErrorCode.PROJECT_NOT_FOUND,
              'Project not found',
              404
            );

          const deleted = data.projects.splice(idx, 1)[0];
          data.artifactAudits = data.artifactAudits.filter(
            (report) => report.projectId !== id
          );
          appendHistoryEvent(data, 'project.delete', deleted, actorId);
          return deleted;
        });
        commitRecoveryLease(lease);
        return removed;
      } catch (error) {
        lease?.rollback();
        throw error;
      }
    },

    addMember(
      projectId: string,
      email: string,
      role: 'owner' | 'member',
      actorId: string
    ): Project {
      return repo.mutate((data) => {
        const project = data.projects.find((p) => p.id === projectId);
        if (!project)
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        const normalizedEmail = email.toLowerCase();
        const user = data.users.find(
          (candidate) => candidate.email.toLowerCase() === normalizedEmail
        );
        if (!user)
          throw new ApiError(
            ErrorCode.USER_NOT_FOUND,
            'User not found with that email',
            404
          );
        if (project.members.some((m) => m.userId === user.id)) {
          throw new ApiError(
            ErrorCode.ALREADY_MEMBER,
            'User is already a member',
            400
          );
        }
        project.members.push({
          userId: user.id,
          role,
          invitedAt: new Date().toISOString(),
        });
        project.updatedAt = new Date().toISOString();
        appendHistoryEvent(data, 'project.update', project, actorId);
        return project;
      });
    },

    removeMember(projectId: string, userId: string, actorId: string): Project {
      return repo.mutate((data) => {
        const project = data.projects.find((p) => p.id === projectId);
        if (!project)
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        const idx = project.members.findIndex((m) => m.userId === userId);
        if (idx === -1)
          throw new ApiError(
            ErrorCode.NOT_A_MEMBER,
            'User is not a member',
            404
          );
        if (
          project.members[idx].role === 'owner' &&
          project.members.filter((m) => m.role === 'owner').length <= 1
        ) {
          throw new ApiError(
            ErrorCode.CANNOT_REMOVE_LAST_OWNER,
            'Cannot remove the last owner',
            403
          );
        }
        project.members.splice(idx, 1);
        project.updatedAt = new Date().toISOString();
        appendHistoryEvent(data, 'project.update', project, actorId);
        return project;
      });
    },

    transferOwnership(
      projectId: string,
      targetUserId: string,
      actor: Actor
    ): Project {
      return repo.mutate((data) => {
        const project = data.projects.find((p) => p.id === projectId);
        if (!project)
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        const target = project.members.find((m) => m.userId === targetUserId);
        if (!target)
          throw new ApiError(
            ErrorCode.NOT_A_MEMBER,
            'Target user is not a member',
            404
          );
        if (!hasProjectRole(actor, project, 'owner'))
          throw new ApiError(ErrorCode.FORBIDDEN, 'Owner access required', 403);
        target.role = 'owner';
        const actorMembership = project.members.find(
          (member) => member.userId === actor.id
        );
        if (actorMembership && actorMembership.userId !== targetUserId) {
          actorMembership.role = 'member';
        }
        project.updatedAt = new Date().toISOString();
        appendHistoryEvent(data, 'project.update', project, actor.id);
        return project;
      });
    },

    listHistory(actor: Actor, limit?: string, cursor?: string): HistoryPage {
      const data = repo.load();
      const visibleProjectIds =
        actor.role === 'admin'
          ? null
          : new Set(
              data.projects
                .filter((project) => canReadProject(actor, project))
                .map((project) => project.id)
            );
      const visibleHistory = visibleProjectIds
        ? data.history.filter((event) => visibleProjectIds.has(event.projectId))
        : data.history;
      const page = repo.listHistoryPage
        ? repo.listHistoryPage({
            projectIds: visibleProjectIds ? [...visibleProjectIds] : null,
            limit,
            cursor,
          })
        : paginateHistory(visibleHistory, limit, cursor);
      if (!page) {
        throw new ApiError(
          ErrorCode.INVALID_HISTORY_CURSOR,
          'History cursor is invalid or has expired'
        );
      }
      return page;
    },

    listProjectHistory(
      projectId: string,
      actor: Actor,
      limit?: string,
      cursor?: string
    ): HistoryPage {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      if (!canReadProject(actor, project)) {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Project access required', 403);
      }
      const page = repo.listHistoryPage
        ? repo.listHistoryPage({
            projectIds: [projectId],
            limit,
            cursor,
          })
        : paginateHistory(
            data.history.filter((event) => event.projectId === projectId),
            limit,
            cursor
          );
      if (!page) {
        throw new ApiError(
          ErrorCode.INVALID_HISTORY_CURSOR,
          'History cursor is invalid or has expired'
        );
      }
      return page;
    },
  };
}

function commitRecoveryLease(
  lease: ReturnType<ArtifactRecoveryService['stageProjectDeletion']> | undefined
): void {
  try {
    lease?.commit();
  } catch (error) {
    console.error(
      '[deploykit] Metadata deletion committed but trash marker failed',
      error
    );
  }
}
