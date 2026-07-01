import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Skeleton } from '@/shared/ui/skeleton';

interface Props {
  projects: Project[];
  loading: boolean;
  selectedProjectId?: string;
  onSelect: (project: Project) => void;
  onCreate: () => void;
}

export function ProjectList({
  projects,
  loading,
  selectedProjectId,
  onSelect,
  onCreate,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="w-full lg:w-80 xl:w-96 border-b lg:border-r lg:border-b-0 border-border flex flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-sm font-medium text-muted-foreground">
          {t('projects.title')}
        </p>
        <Button variant="ghost" size="default" onClick={onCreate}>
          <Plus className="size-4" />
          {t('projects.create')}
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-2 p-3 rounded-lg border border-border"
              >
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('projects.empty')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('projects.emptyDesc')}
            </p>
          </div>
        ) : (
          <div className="px-2 space-y-0.5">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`group flex items-center gap-1 rounded-lg transition-colors ${
                  selectedProjectId === project.id
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted/50'
                }`}
              >
                <button
                  type="button"
                  className="flex flex-1 min-w-0 items-center gap-2 px-3 py-2.5 text-left"
                  onClick={() => onSelect(project)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-medium truncate">
                      {project.name}
                    </p>
                    <p className="text-sm text-muted-foreground truncate">
                      {project.slug} ·{' '}
                      {t('projects.versions', {
                        count: project.versions.length,
                      })}
                    </p>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
