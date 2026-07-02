import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { useToast } from '@/shared/ui/toast-context';

function getHashProjectId(): string {
  const hash = window.location.hash;
  if (hash.startsWith('#/projects/')) return hash.slice('#/projects/'.length);
  return '';
}

function setHashProjectId(id: string | null) {
  if (id) {
    window.location.hash = `#/projects/${id}`;
  } else {
    history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search
    );
  }
}

/**
 * Owns the project list, the selected project, and the URL-hash deep-linking.
 * Actions (`publishVersion`, `rollbackVersion`, `deleteVersion`,
 * `onProjectDeleted`) call the API and refresh the list, surfacing errors via
 * toast.
 */
export function useProjects() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listProjects();
      const hashId = getHashProjectId();
      setProjects(data);
      if (hashId && !data.some((p) => p.id === hashId)) {
        setHashProjectId(null);
      }
      setSelectedProject((prev) =>
        prev ? (data.find((p) => p.id === prev.id) ?? null) : prev
      );
    } catch {
      toast(t('common.failed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  const selectProject = useCallback((p: Project | null) => {
    setSelectedProject(p);
    setHashProjectId(p?.id ?? null);
  }, []);

  // Initial load + restore selection from the URL hash.
  useEffect(() => {
    api
      .listProjects()
      .then((data) => {
        setProjects(data);
        const hashId = getHashProjectId();
        if (hashId) {
          const found = data.find((p) => p.id === hashId);
          if (found) setSelectedProject(found);
          else setHashProjectId(null);
        }
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  // Keep selection in sync with back/forward navigation.
  useEffect(() => {
    const handler = () => {
      const hashId = getHashProjectId();
      setSelectedProject(projects.find((p) => p.id === hashId) ?? null);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [projects]);

  const publishVersion = useCallback(
    async (versionId: string) => {
      if (!selectedProject) return;
      setPendingVersionId(versionId);
      try {
        await api.publishVersion(selectedProject.id, versionId);
        toast(t('common.published'));
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('common.failed'), 'error');
      } finally {
        setPendingVersionId(null);
      }
    },
    [selectedProject, refresh, toast, t]
  );

  const rollbackVersion = useCallback(
    async (versionId: string) => {
      if (!selectedProject) return;
      setPendingVersionId(versionId);
      try {
        await api.rollbackVersion(selectedProject.id, versionId);
        toast(t('common.rolledBack'));
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('common.failed'), 'error');
      } finally {
        setPendingVersionId(null);
      }
    },
    [selectedProject, refresh, toast, t]
  );

  const deleteVersion = useCallback(
    async (versionId: string) => {
      if (!selectedProject) return;
      setPendingVersionId(versionId);
      try {
        await api.deleteVersion(selectedProject.id, versionId);
        toast(t('common.deleted'));
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('common.failed'), 'error');
      } finally {
        setPendingVersionId(null);
      }
    },
    [selectedProject, refresh, toast, t]
  );

  const onProjectDeleted = useCallback(() => {
    selectProject(null);
    refresh();
  }, [selectProject, refresh]);

  return {
    projects,
    loading,
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
