import { ChevronRight, Plus, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

interface Props {
  projects: Project[];
  loading: boolean;
  selectedProjectId?: string;
  onSelect: (project: Project) => void;
  onOpenSettings: (project: Project) => void;
  onCreate: () => void;
}

export function ProjectList({
  projects,
  loading,
  selectedProjectId,
  onSelect,
  onOpenSettings,
  onCreate,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="w-full lg:w-80 xl:w-96 border-b lg:border-r lg:border-b-0 border-border flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">
          {t('projects.title')}
        </p>
        <Button variant="ghost" size="icon-xs" onClick={onCreate}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="px-4 py-8 text-sm text-muted-foreground text-center">
            {t('common.loading')}
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
                  className="flex flex-1 min-w-0 items-center gap-2 px-3 py-2 text-left"
                  onClick={() => onSelect(project)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {project.name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {project.slug} ·{' '}
                      {t('projects.versions', {
                        count: project.versions.length,
                      })}
                    </p>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground/50 shrink-0" />
                </button>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSettings(project);
                        }}
                      >
                        <Settings className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('app.settings')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
