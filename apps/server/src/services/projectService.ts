import type {
  CreateProjectInput,
  HistoryEvent,
  Project,
  Settings,
} from '@deploykit/shared';
import { appendHistoryEvent } from '../domain/history';
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

    updateProjectSettings(id: string, settings: Settings): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      project.settings = settings;
      project.updatedAt = new Date().toISOString();
      repo.save(data);
      return project;
    },

    updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string }
    ): Project {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === id);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      if (updates.name !== undefined) project.name = updates.name;
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
        project.slug = newSlug;
      }
      if (updates.description !== undefined)
        project.description = updates.description;
      project.updatedAt = new Date().toISOString();
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

    listHistory(limit?: string): HistoryEvent[] {
      const max = Math.min(Number(limit) || 50, 200);
      return repo.load().history.slice(0, max);
    },
  };
}
