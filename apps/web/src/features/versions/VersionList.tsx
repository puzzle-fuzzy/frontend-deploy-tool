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
  onActivate: (versionId: string) => void;
  onDelete: (versionId: string) => void;
}

export function VersionList({
  project,
  pendingVersionId,
  onActivate,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const isActive = (v: Version) => project.activeVersionId === v.id;
  const isPending = (v: Version) => pendingVersionId === v.id;
  const [confirmVersionId, setConfirmVersionId] = useState<string | null>(null);

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
    (v) => v.id === confirmVersionId
  );

  const handleConfirmDelete = () => {
    const id = confirmVersionId;
    setConfirmVersionId(null);
    if (id) onDelete(id);
  };

  return (
    <>
      <ScrollArea className="flex-1">
        {project.versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="size-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
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
                    <code className="text-xs font-mono">{v.name}</code>
                    {isActive(v) && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0"
                      >
                        {t('versions.production')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(v.createdAt)}
                    {v.description && ` · ${v.description}`}
                  </p>
                  {metaText(v) && (
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {metaText(v)}
                    </p>
                  )}
                </div>
                {isPending(v) ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground ml-3" />
                ) : (
                  <div className="flex items-center gap-1 ml-3">
                    {!isActive(v) && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => onActivate(v.id)}
                      >
                        {t('versions.setProduction')}
                      </Button>
                    )}
                    <Button variant="ghost" size="xs" asChild>
                      <a
                        href={`${publicBaseURL}/deploy/${project.slug}/${v.id}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('versions.preview')}
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmVersionId(v.id)}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={confirmVersionId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmVersionId(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteVersionConfirm', {
          name: confirmVersion?.name ?? '',
        })}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
