import { useEffect, useState } from 'react';
import { useApiClient } from '@/shared/api/context';
import type { Project } from '@/shared/types';

function getHashProjectId(): string {
  const hash = window.location.hash;
  if (hash.startsWith('#/projects/')) {
    return hash.slice('#/projects/'.length).split('/')[0] ?? '';
  }
  return '';
}

function setHashProjectId(id: string | null) {
  if (id) {
    window.location.hash = `#/projects/${id}`;
    return;
  }
  history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search
  );
}

export function useProjects() {
  const api = useApiClient();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const data = await api.listProjects();
      const hashId = getHashProjectId();
      setProjects(data);
      setSelectedProject((current) => {
        const targetId = current?.id ?? hashId;
        return data.find((project) => project.id === targetId) ?? null;
      });
      if (hashId && !data.some((project) => project.id === hashId)) {
        setHashProjectId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const hashId = getHashProjectId();
      setSelectedProject(
        projects.find((project) => project.id === hashId) ?? null
      );
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [projects]);

  const selectProject = (project: Project | null) => {
    setSelectedProject(project);
    setHashProjectId(project?.id ?? null);
  };

  const publishVersion = async (versionId: string) => {
    if (!selectedProject) return;
    setPendingVersionId(versionId);
    try {
      await api.publishVersion(selectedProject.id, versionId);
      await refresh();
    } finally {
      setPendingVersionId(null);
    }
  };

  const rollbackVersion = async (versionId: string) => {
    if (!selectedProject) return;
    setPendingVersionId(versionId);
    try {
      await api.rollbackVersion(selectedProject.id, versionId);
      await refresh();
    } finally {
      setPendingVersionId(null);
    }
  };

  const deleteVersion = async (versionId: string) => {
    if (!selectedProject) return;
    setPendingVersionId(versionId);
    try {
      await api.deleteVersion(selectedProject.id, versionId);
      await refresh();
    } finally {
      setPendingVersionId(null);
    }
  };

  const onProjectDeleted = () => {
    selectProject(null);
    refresh();
  };

  return {
    projects,
    loading,
    error,
    selectedProject,
    pendingVersionId,
    selectProject,
    refresh,
    publishVersion,
    rollbackVersion,
    deleteVersion,
    onProjectDeleted,
  };
}
