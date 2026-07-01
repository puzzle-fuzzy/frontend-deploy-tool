import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
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
  const resetKey = `${project?.id ?? ''}\u0000${defaultVersionId}`;
  const [selectedVersionId, setSelectedVersionId] = useState(defaultVersionId);
  const [profile, setProfile] = useState<AuditProfile>('production-web');
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const targetKey = `${project?.id ?? ''}\u0000${selectedVersionId}\u0000${profile}`;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const invalidateAuditState = useCallback(() => {
    requestIdRef.current += 1;
    setReport(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    setSelectedVersionId(defaultVersionId);
    setReport(null);
    setError(null);
    setLoading(false);
  }, [defaultVersionId, resetKey]);

  const selectVersionId = useCallback(
    (next: SetStateAction<string>) => {
      setSelectedVersionId((prev) => {
        const nextValue = typeof next === 'function' ? next(prev) : next;
        if (nextValue !== prev) invalidateAuditState();
        return nextValue;
      });
    },
    [invalidateAuditState]
  );

  const selectProfile = useCallback(
    (next: SetStateAction<AuditProfile>) => {
      setProfile((prev) => {
        const nextValue = typeof next === 'function' ? next(prev) : next;
        if (nextValue !== prev) invalidateAuditState();
        return nextValue;
      });
    },
    [invalidateAuditState]
  );

  const runAudit = useCallback(async () => {
    if (!project || !selectedVersionId) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const requestTargetKey = targetKeyRef.current;
    const isCurrentRequest = () =>
      requestIdRef.current === requestId &&
      targetKeyRef.current === requestTargetKey;

    setLoading(true);
    setError(null);
    try {
      const nextReport = await api.runVersionAudit(
        project.id,
        selectedVersionId,
        profile
      );
      if (isCurrentRequest()) setReport(nextReport);
    } catch (err) {
      if (isCurrentRequest()) setError(getErrorMessage(err));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [project, selectedVersionId, profile]);

  return {
    selectedVersionId,
    setSelectedVersionId: selectVersionId,
    profile,
    setProfile: selectProfile,
    report,
    loading,
    error,
    runAudit,
  };
}
