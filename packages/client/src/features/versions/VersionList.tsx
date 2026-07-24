import {
  ExternalLink,
  MoreHorizontal,
  Rocket,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '@/shared/error-messages';
import { formatBytes, formatDate } from '@/shared/format';
import type { Project, Version } from '@/shared/types';

interface VersionListProps {
  project: Project;
  pendingVersionId: string | null;
  readOnly: boolean;
  onPublish: (versionId: string) => Promise<void>;
  onRollback: (versionId: string) => Promise<void>;
  onDelete: (versionId: string) => Promise<void>;
}

type VersionAction = 'publish' | 'rollback' | 'delete';

interface PendingAction {
  type: VersionAction;
  version: Version;
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
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );

  const versions = useMemo(
    () =>
      [...project.versions].sort((a, b) => {
        if (a.id === project.activeVersionId) return -1;
        if (b.id === project.activeVersionId) return 1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [project.activeVersionId, project.versions]
  );

  if (versions.length === 0) {
    return (
      <div className="grid min-h-72 bg-primary text-primary-foreground sm:grid-cols-[11rem_1fr]">
        <div className="border-b border-primary-foreground/25 p-6 sm:border-b-0 sm:border-r">
          <div className="editorial-number">00</div>
          <div className="editorial-meta mt-16 text-primary-foreground/70">
            No builds
          </div>
        </div>
        <div className="flex flex-col justify-end p-7 sm:p-10">
          <h2 className="max-w-lg text-3xl font-normal tracking-[-0.05em]">
            {t('versions.empty')}
          </h2>
          <p className="editorial-meta mt-6 border-t border-primary-foreground/25 pt-4 text-primary-foreground/70">
            ZIP / Folder / index.html required
          </p>
        </div>
      </div>
    );
  }

  const runConfirmedAction = async () => {
    if (!pendingAction) return;
    try {
      if (pendingAction.type === 'publish') {
        await onPublish(pendingAction.version.id);
      } else if (pendingAction.type === 'rollback') {
        await onRollback(pendingAction.version.id);
      } else {
        await onDelete(pendingAction.version.id);
      }
      setPendingAction(null);
    } catch (error) {
      toast(getLocalizedError(error, t, t('common.failed')), 'error');
    }
  };

  const confirmDescription = pendingAction
    ? t(
        pendingAction.type === 'publish'
          ? 'common.publishVersionConfirm'
          : pendingAction.type === 'rollback'
            ? 'common.rollbackVersionConfirm'
            : 'common.deleteVersionConfirm',
        { name: pendingAction.version.name }
      )
    : '';

  return (
    <>
      <div className="mb-6 flex items-end justify-between border-b pb-5">
        <div>
          <span className="editorial-meta text-primary">01 / Versions</span>
          <h2 className="mt-3 text-3xl font-normal tracking-[-0.05em]">
            {t('versions.title')}
          </h2>
        </div>
        <span className="editorial-meta text-muted-foreground">
          {String(versions.length).padStart(2, '0')} builds
        </span>
      </div>

      <div className="grid gap-px bg-border md:grid-cols-2 xl:grid-cols-3">
        {versions.map((version, index) => (
          <VersionTile
            key={version.id}
            project={project}
            version={version}
            index={index}
            pending={pendingVersionId === version.id}
            readOnly={readOnly}
            onAction={(type) => setPendingAction({ type, version })}
          />
        ))}
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={
          pendingAction?.type === 'delete'
            ? t('versions.delete')
            : pendingAction?.type === 'rollback'
              ? t('versions.rollback')
              : t('versions.setProduction')
        }
        description={confirmDescription}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void runConfirmedAction()}
        loading={
          pendingAction ? pendingVersionId === pendingAction.version.id : false
        }
        destructive={pendingAction?.type === 'delete'}
      />
    </>
  );
}

function VersionTile({
  project,
  version,
  index,
  pending,
  readOnly,
  onAction,
}: {
  project: Project;
  version: Version;
  index: number;
  pending: boolean;
  readOnly: boolean;
  onAction: (type: VersionAction) => void;
}) {
  const { t } = useTranslation();
  const isLive = project.activeVersionId === version.id;
  const previewUrl = `/deploy/${project.slug}/${version.id}/`;
  const sourceLabel =
    version.sourceType === 'zip'
      ? t('versions.sourceZip')
      : version.sourceType === 'folder'
        ? t('versions.sourceFolder')
        : t('versions.sourceUnknown');

  return (
    <article
      className={`group flex min-h-72 flex-col justify-between p-6 sm:p-7 ${
        isLive
          ? 'bg-primary text-primary-foreground md:row-span-2 md:min-h-[36.05rem]'
          : 'bg-card hover:bg-background'
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-4">
          <span
            className={`editorial-number text-[clamp(3.25rem,6vw,6rem)] ${
              isLive ? '' : 'text-primary'
            }`}
          >
            {String(index + 1).padStart(2, '0')}
          </span>
          <span
            className={`editorial-meta border px-2 py-1 ${
              isLive
                ? 'border-primary-foreground/40 text-primary-foreground'
                : 'border-foreground/20 text-muted-foreground'
            }`}
          >
            {isLive
              ? t('versions.productionStatus')
              : t(`versions.${version.status}Status`)}
          </span>
        </div>

        <div className={isLive ? 'mt-24' : 'mt-14'}>
          <span
            className={`editorial-meta ${
              isLive ? 'text-primary-foreground/65' : 'text-muted-foreground'
            }`}
          >
            Version / {sourceLabel}
          </span>
          <h3 className="mt-3 font-mono text-xl font-medium tracking-[-0.04em]">
            {version.name || version.id.slice(0, 7)}
          </h3>
          {version.description && (
            <p
              className={`mt-3 text-sm leading-relaxed ${
                isLive ? 'text-primary-foreground/75' : 'text-muted-foreground'
              }`}
            >
              {version.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-10">
        <dl
          className={`grid grid-cols-2 gap-px border ${
            isLive
              ? 'border-primary-foreground/25 bg-primary-foreground/25'
              : 'bg-border'
          }`}
        >
          <Meta
            label={t('versions.files', { count: version.fileCount })}
            value={formatBytes(version.size) || '—'}
            live={isLive}
          />
          <Meta
            label={sourceLabel}
            value={formatDate(version.createdAt)}
            live={isLive}
          />
        </dl>

        <div
          className={`mt-4 flex items-center justify-between border-t pt-4 ${
            isLive ? 'border-primary-foreground/25' : ''
          }`}
        >
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="editorial-meta inline-flex items-center gap-2"
          >
            {t('versions.preview')}
            <ExternalLink className="size-3.5" />
          </a>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={
                    isLive
                      ? 'text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground'
                      : ''
                  }
                />
              }
            >
              <MoreHorizontal />
              <span className="sr-only">Version actions</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={readOnly || pending || isLive}
                onClick={() => onAction('publish')}
              >
                <Rocket />
                {t('versions.setProduction')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={readOnly || pending || isLive}
                onClick={() => onAction('rollback')}
              >
                <RotateCcw />
                {t('versions.rollback')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={readOnly || pending}
                onClick={() => onAction('delete')}
              >
                <Trash2 />
                {t('versions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}

function Meta({
  label,
  value,
  live,
}: {
  label: string;
  value: string;
  live: boolean;
}) {
  return (
    <div
      className={`min-w-0 p-3 ${
        live ? 'bg-primary' : 'bg-card group-hover:bg-background'
      }`}
    >
      <dt
        className={`editorial-meta truncate ${
          live ? 'text-primary-foreground/60' : 'text-muted-foreground'
        }`}
      >
        {label}
      </dt>
      <dd className="mt-1 truncate text-xs">{value}</dd>
    </div>
  );
}
