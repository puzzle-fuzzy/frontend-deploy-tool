import type { HistoryEvent, Project, Settings } from '@deploykit/shared';
import { appendHistoryEvent } from '../domain/history';
import {
  DEFAULT_PROJECT_SETTINGS,
  isValidProjectSlug,
} from '../domain/project';
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

    createProject(body: unknown): Project {
      const raw = (body ?? {}) as {
        name?: string;
        slug?: string;
        description?: string;
      };
      const name = ((raw.name as string) || '').trim();
      const slug = ((raw.slug as string) || '').trim().toLowerCase();
      const description = ((raw.description as string) || '').trim();

      if (!name)
        throw new ApiError(
          ErrorCode.PROJECT_NAME_REQUIRED,
          'Project name is required'
        );
      if (!slug)
        throw new ApiError(
          ErrorCode.PROJECT_SLUG_REQUIRED,
          'Project slug is required'
        );
      if (!isValidProjectSlug(slug)) {
        throw new ApiError(
          ErrorCode.PROJECT_SLUG_INVALID,
          'Project slug must be 3-64 lowercase letters, numbers, or hyphens'
        );
      }

      const data = repo.load();
      if (data.projects.some((p) => p.slug === slug)) {
        throw new ApiError(
          ErrorCode.PROJECT_SLUG_TAKEN,
          'Project slug already exists'
        );
      }

      const project: Project = {
        id: createId(),
        name,
        slug,
        description,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: [],
        activeVersionId: null,
        settings: { ...DEFAULT_PROJECT_SETTINGS },
      };
      data.projects.push(project);
      appendHistoryEvent(data, 'project.create', project);
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

    deleteProject(id: string): Project {
      const data = repo.load();
      const idx = data.projects.findIndex((p) => p.id === id);
      if (idx === -1)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const removed = data.projects.splice(idx, 1)[0];
      appendHistoryEvent(data, 'project.delete', removed);
      repo.save(data);
      return removed;
    },

    listHistory(limit?: string): HistoryEvent[] {
      const max = Math.min(Number(limit) || 50, 200);
      return repo.load().history.slice(0, max);
    },
  };
}
