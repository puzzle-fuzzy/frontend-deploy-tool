import {
  CalendarIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  RocketIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { formatBytes, formatDate } from '@/shared/format';
import type { Project, Version } from '@/shared/types';
import { VersionStatusBadge } from './VersionStatusBadge';

interface VersionListProps {
  project: Project;
  pendingVersionId: string | null;
  readOnly: boolean;
  onPublish: (versionId: string) => Promise<void>;
  onRollback: (versionId: string) => Promise<void>;
  onDelete: (versionId: string) => Promise<void>;
}

export function VersionList({
  project,
  pendingVersionId,
  readOnly,
  onPublish,
  onRollback,
  onDelete,
}: VersionListProps) {
  const { t } = useTranslation();

  if (project.versions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('versions.empty')}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card">
      {project.versions.map((version, index) => (
        <VersionItem
          key={version.id}
          project={project}
          version={version}
          pending={pendingVersionId === version.id}
          readOnly={readOnly}
          showSeparator={index < project.versions.length - 1}
          onPublish={onPublish}
          onRollback={onRollback}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function VersionItem({
  project,
  version,
  pending,
  readOnly,
  showSeparator,
  onPublish,
  onRollback,
  onDelete,
}: {
  project: Project;
  version: Version;
  pending: boolean;
  readOnly: boolean;
  showSeparator: boolean;
  onPublish: (versionId: string) => Promise<void>;
  onRollback: (versionId: string) => Promise<void>;
  onDelete: (versionId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const isLive = project.activeVersionId === version.id;
  const previewUrl = `/deploy/${project.slug}/${version.id}/`;

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
    }
  };

  return (
    <div>
      <Item variant="default" size="default" className="flex-col py-3.5">
        <div className="flex w-full items-center justify-between gap-4">
          <ItemContent className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                Ver.
              </span>
              <ItemTitle className="truncate font-mono text-xs tracking-tight">
                {version.name || version.id}
              </ItemTitle>
              <VersionStatusBadge
                status={isLive ? 'production' : version.status}
              />
            </div>
          </ItemContent>

          <ItemActions>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="min-w-40"
              >
                <DropdownMenuItem
                  onClick={() =>
                    window.open(previewUrl, '_blank', 'noopener,noreferrer')
                  }
                >
                  <ExternalLinkIcon className="size-4" />
                  {t('versions.preview')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={readOnly || pending || isLive}
                  onClick={() => runAction(() => onPublish(version.id))}
                >
                  <RocketIcon className="size-4" />
                  {t('versions.setProduction')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={readOnly || pending || isLive}
                  onClick={() => runAction(() => onRollback(version.id))}
                >
                  <RotateCcwIcon className="size-4" />
                  {t('versions.rollback')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={readOnly || pending}
                  onClick={() => runAction(() => onDelete(version.id))}
                >
                  <Trash2Icon className="size-4" />
                  {t('versions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ItemActions>
        </div>

        <ItemDescription className="flex w-full flex-wrap items-center gap-3 pt-1">
          <span className="inline-flex items-center gap-1 text-xs">
            <FileTextIcon className="size-3" />
            {t('versions.files', { count: version.fileCount })}
          </span>
          {formatBytes(version.size) && (
            <span className="text-xs">{formatBytes(version.size)}</span>
          )}
          <span className="text-border select-none">.</span>
          <span className="inline-flex items-center gap-1 text-xs">
            <CalendarIcon className="size-3" />
            {formatDate(version.createdAt)}
          </span>
          <span className="text-border select-none">.</span>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-xs underline underline-offset-4 hover:text-primary"
          >
            {previewUrl}
          </a>
        </ItemDescription>
        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </Item>
      {showSeparator && <Separator />}
    </div>
  );
}
