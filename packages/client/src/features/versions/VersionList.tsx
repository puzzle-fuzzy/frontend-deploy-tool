import { Crown, Eye, FolderOpen, Loader2, Trash2 } from 'lucide-react';
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

  const renderVersion = (v: Version, isProduction: boolean) => (
    <div
      key={v.id}
      className={`rounded-xl border transition-all ${
        isProduction
          ? 'border-emerald-200 dark:border-emerald-900 bg-gradient-to-b from-emerald-50/50 to-white dark:from-emerald-950/20 dark:to-card'
          : 'border-border bg-card hover:border-muted-foreground/20'
      }`}
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-base font-semibold">
                {v.name}
              </span>
              {isProduction && (
                <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 gap-1">
                  <Crown className="size-3" />
                  {t('versions.production')}
                </Badge>
              )}
            </div>

            <div className="mt-1.5 flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              <span>{formatDate(v.createdAt)}</span>
              {v.publishedBy && <span>by {v.publishedBy}</span>}
              {v.description && (
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="text-muted-foreground/80">
                    {v.description}
                  </span>
                </>
              )}
            </div>

            {metaText(v) && (
              <p className="mt-1.5 text-xs text-muted-foreground/60">
                {metaText(v)}
              </p>
            )}
          </div>

          {isPending(v) ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground shrink-0 mt-1" />
          ) : (
            <div className="flex items-center gap-1.5 shrink-0 mt-1">
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
              {!readOnly && !isProduction && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConfirmAction({
                      type: isProduction ? 'rollback' : 'publish',
                      versionId: v.id,
                    })
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
                  onClick={() =>
                    setConfirmAction({ type: 'delete', versionId: v.id })
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (project.versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="size-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <FolderOpen className="size-8 text-muted-foreground/50" />
        </div>
        <p className="text-base font-medium text-foreground">
          {t('versions.empty')}
        </p>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          {t('versions.emptyDesc')}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* Production version */}
      {productionVersion && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Crown className="size-4 text-emerald-500" />
            <h3 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
              {t('versions.production')}
            </h3>
          </div>
          {renderVersion(productionVersion, true)}
        </section>
      )}

      {/* Preview versions */}
      {previewVersions.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t('versions.staging')}
          </h3>
          <div className="space-y-2">
            {previewVersions.map((v) => renderVersion(v, false))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title={
          confirmAction?.type === 'delete'
            ? t('common.delete')
            : confirmAction?.type === 'rollback'
              ? t('versions.rollback')
              : t('versions.publish')
        }
        description={
          confirmAction?.type === 'delete'
            ? t('common.deleteVersionConfirm', {
                name: confirmVersion?.name ?? '',
              })
            : confirmAction?.type === 'rollback'
              ? t('common.rollbackVersionConfirm', {
                  name: confirmVersion?.name ?? '',
                })
              : t('common.publishVersionConfirm', {
                  name: confirmVersion?.name ?? '',
                })
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
