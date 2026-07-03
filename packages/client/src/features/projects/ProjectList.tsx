import { FolderOpen, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../shared/types';
import { Button } from '../../shared/ui/button';
import { ScrollArea } from '../../shared/ui/scroll-area';
import { Skeleton } from '../../shared/ui/skeleton';

interface Props {
  projects: Project[];
  loading: boolean;
  selectedProjectId?: string;
  onSelect: (project: Project) => void;
  canCreate?: boolean;
  onCreate: () => void;
}

export function ProjectList({
  projects,
  loading,
  selectedProjectId,
  onSelect,
  canCreate = true,
  onCreate,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full flex-col border-border bg-card lg:w-80 lg:border-r xl:w-96">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-muted-foreground">
          {t('projects.title')}
        </p>
        {canCreate && (
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            {t('app.newProject')}
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="space-y-2 p-3">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="rounded-md border border-border bg-background p-3"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-md border border-border bg-muted">
              <FolderOpen className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{t('projects.empty')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('projects.emptyDesc')}
            </p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors ${
                  selectedProjectId === project.id
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-transparent hover:border-border hover:bg-muted/60'
                }`}
                onClick={() => onSelect(project)}
              >
                <p className="truncate text-sm font-medium">{project.name}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  /deploy/{project.slug} ·{' '}
                  {t('projects.versions', {
                    count: project.versions.length,
                  })}
                </p>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
