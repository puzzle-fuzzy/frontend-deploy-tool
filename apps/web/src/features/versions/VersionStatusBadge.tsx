import { useTranslation } from 'react-i18next';
import type { VersionStatus } from '@/shared/types';
import { cn } from '@/lib/utils';

const statusLabelKeys: Record<VersionStatus, string> = {
  preview: 'versions.previewStatus',
  production: 'versions.productionStatus',
  archived: 'versions.archivedStatus',
  failed: 'versions.failedStatus',
};

const statusClasses: Record<VersionStatus, string> = {
  preview: 'border-border bg-muted text-muted-foreground',
  production: 'border-primary/20 bg-primary/10 text-primary',
  archived: 'border-border bg-background text-muted-foreground',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function VersionStatusBadge({
  status,
  className,
}: {
  status: VersionStatus;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        statusClasses[status],
        className
      )}
    >
      {t(statusLabelKeys[status])}
    </span>
  );
}
