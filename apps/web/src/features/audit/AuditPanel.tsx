import { Loader2, PlayCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuditProfile, Project } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { AuditCheckList } from './AuditCheckList';
import { AuditScore } from './AuditScore';
import { useVersionAudit } from './useVersionAudit';

interface Props {
  project: Project;
}

const profiles: AuditProfile[] = [
  'demo',
  'production-web',
  'h5-campaign',
  'admin-app',
  'docs',
];

export function AuditPanel({ project }: Props) {
  const { t } = useTranslation();
  const audit = useVersionAudit(project);

  if (project.versions.length === 0) {
    return (
      <section className="flex h-full flex-col border-l border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('audit.title')}</h2>
        </div>
        <div className="flex flex-1 items-center justify-center px-4 py-10 text-sm text-muted-foreground">
          {t('audit.empty')}
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col border-l border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('audit.title')}</h2>
      </div>

      <div className="space-y-3 border-b border-border px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('audit.versions')}
            </span>
            <Select
              value={audit.selectedVersionId}
              onValueChange={audit.setSelectedVersionId}
              disabled={audit.loading}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {project.versions.map((version) => (
                  <SelectItem key={version.id} value={version.id}>
                    {version.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('audit.profile')}
            </span>
            <Select
              value={audit.profile}
              onValueChange={(value) => audit.setProfile(value as AuditProfile)}
              disabled={audit.loading}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile} value={profile}>
                    {profile}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={audit.runAudit}
          disabled={audit.loading}
        >
          {audit.loading ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayCircle data-icon="inline-start" />
          )}
          {audit.loading ? t('audit.running') : t('audit.run')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-4">
          {audit.error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {audit.error}
            </p>
          )}
          {audit.report ? (
            <>
              <AuditScore report={audit.report} />
              <AuditCheckList checks={audit.report.checks} />
            </>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('audit.noReport')}
            </p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
