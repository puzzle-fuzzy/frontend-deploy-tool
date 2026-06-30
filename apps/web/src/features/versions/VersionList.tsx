import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { publicBaseURL } from '@/config';
import { formatDate } from '@/lib/format';
import type { Project } from '@/types';

interface Props {
  project: Project;
  onActivate: (versionId: string) => void;
  onDelete: (versionId: string) => void;
}

export function VersionList({ project, onActivate, onDelete }: Props) {
  const { t } = useTranslation();

  return (
    <ScrollArea className="flex-1">
      {project.versions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <FolderOpen className="size-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('versions.empty')}</p>
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
                  {v.active && (
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
              </div>
              <div className="flex items-center gap-1 ml-3">
                {!v.active && (
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
                  onClick={() => onDelete(v.id)}
                >
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
