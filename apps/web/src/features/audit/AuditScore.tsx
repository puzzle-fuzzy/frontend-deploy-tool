import { useTranslation } from 'react-i18next';
import type { AuditReport } from '@/shared/types';
import { Badge } from '@/shared/ui/badge';

interface Props {
  report: AuditReport;
}

function statusKey(status: AuditReport['status']): string {
  return `audit.${status}`;
}

function statusVariant(status: AuditReport['status']) {
  if (status === 'failed') return 'destructive';
  if (status === 'warning') return 'secondary';
  return 'outline';
}

export function AuditScore({ report }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
      <div>
        <p className="text-xs font-medium text-muted-foreground">
          {t('audit.score')}
        </p>
        <p className="font-mono text-2xl font-semibold leading-none">
          {report.score}
        </p>
      </div>
      <Badge variant={statusVariant(report.status)}>
        {t(statusKey(report.status))}
      </Badge>
    </div>
  );
}
