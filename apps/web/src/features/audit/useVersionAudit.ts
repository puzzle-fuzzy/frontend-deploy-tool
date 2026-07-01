import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/shared/api';
import type { AuditProfile, AuditReport, Project } from '@/shared/types';

function getDefaultVersionId(project: Project | null): string {
  return project?.activeVersionId ?? project?.versions[0]?.id ?? '';
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useVersionAudit(project: Project | null) {
  const defaultVersionId = useMemo(() => getDefaultVersionId(project), [project]);
  const [selectedVersionId, setSelectedVersionId] = useState(defaultVersionId);
  const [profile, setProfile] = useState<AuditProfile>('production-web');
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedVersionId(defaultVersionId);
    setReport(null);
    setError(null);
  }, [defaultVersionId]);

  const runAudit = useCallback(async () => {
    if (!project || !selectedVersionId) return;

    setLoading(true);
    setError(null);
    try {
      const nextReport = await api.runVersionAudit(
        project.id,
        selectedVersionId,
        profile
      );
      setReport(nextReport);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [project, selectedVersionId, profile]);

  return {
    selectedVersionId,
    setSelectedVersionId,
    profile,
    setProfile,
    report,
    loading,
    error,
    runAudit,
  };
}
