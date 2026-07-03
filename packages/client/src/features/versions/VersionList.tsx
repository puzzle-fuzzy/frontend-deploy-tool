import { Eye, FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '../../shared/config';
import { formatBytes, formatDate } from '../../shared/format';
import type { Project, Version } from '../../shared/types';
import { Badge } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';

interface Props {
  project: Project;
  pendingVersionId: string | null;
  readOnly?: boolean;
  onPublish: (versionId: string) => void;
  onRollback: (versionId: string) => void;
  onDelete: (versionId: string) => void;
}

type ConfirmAction = {
  type: 'publish' | 'rollback' | 'delete';
  versionId: string;
} | null;

export function VersionList({
  project,
  pendingVersionId,
  readOnly = false,
  onPublish,
  onRollback,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const productionVersion = project.versions.find(
    (v) => v.id === project.activeVersionId,
  );
  const previewVersions = project.versions.filter(
    (v) => v.id !== project.activeVersionId,
  );
  const isPending = (v: Version) => pendingVersionId === v.id;
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const metaText = (v: Version): string => {
    const size = formatBytes(v.size);
    if (!v.fileCount && !size && v.sourceType === 'unknown') return '';
    const sourceLabel =
      v.sourceType === 'zip'
        ? t('versions.sourceZip')
        : v.sourceType === 'folder'
          ? t('versions.sourceFolder')
          : t('versions.sourceUnknown');
    return t('versions.meta', {
      source: sourceLabel,
      size: size || '—',
      count: v.fileCount,
    });
  };

  const confirmVersion = project.versions.find(
    (v) => v.id === confirmAction?.versionId,
  );

  const versionRow = (v: Version, isProd: boolean) => {
    if (isPending(v)) {
      return (
        <div key={v.id} className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5">
          <span className="font-mono text-sm font-semibold">{v.name}</span>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
    <div
      key={v.id}
      className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{v.name}</span>
          {isProd && (
            <Badge variant="secondary" className="text-[10px]">
              {t('versions.production')}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {formatDate(v.createdAt)}{' '}
          {v.publishedBy && <>by {v.publishedBy}</>}
          {v.description && <> &middot; {v.description}</>}
        </p>
        {metaText(v) && (
          <p className="text-xs text-muted-foreground/60 mt-0.5">{metaText(v)}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="outline" size="sm" asChild>
          <a
            href={`${publicBaseURL}/deploy/${project.slug}/${v.id}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Eye className="size-3.5" />
            {t('versions.preview')}
          </a>
        </Button>
        {!readOnly && !isProd && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setConfirmAction({ type: 'publish', versionId: v.id })
            }
          >
            {t('versions.publish')}
          </Button>
        )}
        {!readOnly && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={t('common.delete')}
            onClick={() => setConfirmAction({ type: 'delete', versionId: v.id })}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
  };

  if (project.versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="size-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <FolderOpen className="size-8 text-muted-foreground/50" />
        </div>
        <p className="text-base font-medium text-foreground">{t('versions.empty')}</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('versions.emptyDesc')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {productionVersion && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">{t('versions.production')}</h3>
          {versionRow(productionVersion, true)}
        </section>
      )}

      {previewVersions.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">{t('versions.staging')}</h3>
          <div className="space-y-1.5">{previewVersions.map((v) => versionRow(v, false))}</div>
        </section>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
        title={
          confirmAction?.type === 'delete'
            ? t('common.delete')
            : confirmAction?.type === 'rollback'
              ? t('versions.rollback')
              : t('versions.publish')
        }
        description={
          confirmAction?.type === 'delete'
            ? t('common.deleteVersionConfirm', { name: confirmVersion?.name ?? '' })
            : confirmAction?.type === 'rollback'
              ? t('common.rollbackVersionConfirm', { name: confirmVersion?.name ?? '' })
              : t('common.publishVersionConfirm', { name: confirmVersion?.name ?? '' })
        }
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        destructive={confirmAction?.type === 'delete'}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (!action) return;
          if (action.type === 'publish') onPublish(action.versionId);
          if (action.type === 'rollback') onRollback(action.versionId);
          if (action.type === 'delete') onDelete(action.versionId);
        }}
      />
    </div>
  );
}
