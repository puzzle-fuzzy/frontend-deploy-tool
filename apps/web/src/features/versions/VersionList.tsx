import { FolderOpen, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '@/config';
import { formatBytes, formatDate } from '@/shared/format';
import type { Project, Version, VersionSourceType } from '@/shared/types';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { ScrollArea } from '@/shared/ui/scroll-area';

interface Props {
  project: Project;
  pendingVersionId: string | null;
  /** When true (viewer), hide activate/delete actions. */
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
    (version) => version.id === project.activeVersionId
  );
  const isProduction = (v: Version) => v.id === project.activeVersionId;
  const isPending = (v: Version) => pendingVersionId === v.id;
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const sourceLabel = (sourceType: VersionSourceType): string =>
    t(
      sourceType === 'zip'
        ? 'versions.sourceZip'
        : sourceType === 'folder'
          ? 'versions.sourceFolder'
          : 'versions.sourceUnknown'
    );
  const metaText = (v: Version): string => {
    const size = formatBytes(v.size);
    if (!v.fileCount && !size) return '';
    return t('versions.meta', {
      source: sourceLabel(v.sourceType),
      size: size || '—',
      count: v.fileCount,
    });
  };
  const confirmVersion = project.versions.find(
    (v) => v.id === confirmAction?.versionId
  );

  const isRollbackTarget = (v: Version): boolean =>
    Boolean(
      productionVersion &&
        v.id !== productionVersion.id &&
        new Date(v.createdAt).getTime() <
          new Date(productionVersion.createdAt).getTime()
    );

  const releaseActionLabel = (v: Version): string =>
    isRollbackTarget(v) ? t('versions.rollback') : t('versions.publish');

  const handleConfirm = () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    if (action.type === 'publish') onPublish(action.versionId);
    if (action.type === 'rollback') onRollback(action.versionId);
    if (action.type === 'delete') onDelete(action.versionId);
  };

  return (
    <>
      <ScrollArea className="flex-1">
        {project.versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="size-16 text-muted-foreground/40 mb-4" />
            <p className="text-base text-muted-foreground">
              {t('versions.empty')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('versions.emptyDesc')}
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {project.versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono">{v.name}</code>
                    {isProduction(v) && (
                      <Badge
                        variant="secondary"
                        className="text-xs px-2 py-0.5"
                      >
                        {t('versions.production')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {formatDate(v.createdAt)}
                    {v.description && ` · ${v.description}`}
                  </p>
                  {metaText(v) && (
                    <p className="text-sm text-muted-foreground/80 mt-0.5">
                      {metaText(v)}
                    </p>
                  )}
                </div>
                {isPending(v) ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground ml-3" />
                ) : (
                  <div className="flex items-center gap-1.5 ml-3">
                    {!readOnly && !isProduction(v) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setConfirmAction({
                            type: isRollbackTarget(v) ? 'rollback' : 'publish',
                            versionId: v.id,
                          })
                        }
                      >
                        {releaseActionLabel(v)}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" asChild>
                      <a
                        href={`${publicBaseURL}/deploy/${project.slug}/${v.id}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('versions.preview')}
                      </a>
                    </Button>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive/80"
                        onClick={() =>
                          setConfirmAction({ type: 'delete', versionId: v.id })
                        }
                      >
                        {t('common.delete')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title={
          confirmAction?.type === 'rollback'
            ? t('versions.rollback')
            : confirmAction?.type === 'publish'
              ? t('versions.publish')
              : t('common.delete')
        }
        description={
          confirmAction?.type === 'rollback'
            ? t('common.rollbackVersionConfirm', {
                name: confirmVersion?.name ?? '',
              })
            : confirmAction?.type === 'publish'
              ? t('common.publishVersionConfirm', {
                  name: confirmVersion?.name ?? '',
                })
              : t('common.deleteVersionConfirm', {
                  name: confirmVersion?.name ?? '',
                })
        }
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        destructive={confirmAction?.type === 'delete'}
        onConfirm={handleConfirm}
      />
    </>
  );
}
