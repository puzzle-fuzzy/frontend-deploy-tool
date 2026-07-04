import {
  Eye,
  FileArchive,
  FolderOpen,
  Loader2,
  Rocket,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { publicBaseURL } from '../../shared/config';
import { formatBytes, formatDate } from '../../shared/format';
import type { Project, Version } from '../../shared/types';

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
    (v) => v.id === project.activeVersionId
  );
  const previewVersions = project.versions.filter(
    (v) => v.id !== project.activeVersionId
  );
  const orderedVersions = productionVersion
    ? [productionVersion, ...previewVersions]
    : previewVersions;
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
      size: size || '-',
      count: v.fileCount,
    });
  };

  const confirmVersion = project.versions.find(
    (v) => v.id === confirmAction?.versionId
  );

  const sourceIcon = (v: Version) =>
    v.sourceType === 'zip' ? <FileArchive /> : <FolderOpen />;

  if (project.versions.length === 0) {
    return (
      <Card>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>{t('versions.empty')}</EmptyTitle>
              <EmptyDescription>{t('versions.emptyDesc')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('versions.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orderedVersions.map((version) => {
              const isProd = version.id === project.activeVersionId;
              const pending = pendingVersionId === version.id;

              return (
                <TableRow key={version.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      {pending ? (
                        <Loader2 className="animate-spin" />
                      ) : isProd ? (
                        <Rocket />
                      ) : (
                        sourceIcon(version)
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium">{version.name}</p>
                        {version.description && (
                          <p className="truncate text-xs text-muted-foreground">
                            {version.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={isProd ? 'default' : 'outline'}>
                      {isProd
                        ? t('versions.production')
                        : t('versions.staging')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {metaText(version) || t('versions.sourceUnknown')}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(version.createdAt)}
                    {version.publishedBy ? ` by ${version.publishedBy}` : ''}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {!pending && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            render={
                              <a
                                href={`${publicBaseURL}/deploy/${project.slug}/${version.id}/`}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            }
                          >
                            <Eye data-icon="inline-start" />
                            {t('versions.preview')}
                          </Button>
                          {!readOnly && !isProd && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setConfirmAction({
                                  type: 'publish',
                                  versionId: version.id,
                                })
                              }
                            >
                              <Rocket data-icon="inline-start" />
                              {t('versions.publish')}
                            </Button>
                          )}
                          {!readOnly && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('common.delete')}
                              onClick={() =>
                                setConfirmAction({
                                  type: 'delete',
                                  versionId: version.id,
                                })
                              }
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

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
    </Card>
  );
}
