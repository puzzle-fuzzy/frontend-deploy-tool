import type { AuditCategory, AuditCheck, AuditSeverity } from '@/shared/types';
import { Badge } from '@/shared/ui/badge';

interface Props {
  checks: AuditCheck[];
}

const categoryOrder: AuditCategory[] = [
  'metadata',
  'seo',
  'links',
  'images',
  'social',
  'assets',
  'deploy',
];

function severityVariant(severity: AuditSeverity) {
  if (severity === 'error') return 'destructive';
  if (severity === 'warning') return 'secondary';
  return 'outline';
}

export function AuditCheckList({ checks }: Props) {
  return (
    <div className="space-y-4">
      {categoryOrder.map((category) => {
        const categoryChecks = checks.filter(
          (check) => check.category === category
        );
        if (categoryChecks.length === 0) return null;

        return (
          <section key={category} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              {category}
            </h3>
            <div className="space-y-2">
              {categoryChecks.map((check) => (
                <div
                  key={check.id}
                  className="rounded-lg border border-border bg-card px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm font-medium leading-5">
                      {check.title}
                    </p>
                    <Badge
                      variant={severityVariant(check.severity)}
                      className="shrink-0"
                    >
                      {check.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {check.message}
                  </p>
                  {check.location && (
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                      {check.location}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
