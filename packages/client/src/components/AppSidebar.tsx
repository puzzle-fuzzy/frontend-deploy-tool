import { ArrowUpRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { Project } from '@/shared/types';

interface AppSidebarProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (project: Project) => void;
  onShowProjects: () => void;
  onCreateProject: () => void;
}

export function AppSidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onShowProjects,
  onCreateProject,
}: AppSidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="border-b bg-background md:min-h-[calc(100dvh-5rem)] md:border-b-0 md:border-r">
      <div className="flex gap-2 border-b p-3 md:block md:p-6">
        <button
          type="button"
          onClick={onShowProjects}
          className={`flex min-w-44 flex-1 items-center justify-between border px-4 py-3 text-left md:w-full ${
            selectedProjectId === null
              ? 'border-primary bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted'
          }`}
        >
          <span>
            <span className="editorial-meta block opacity-70">Index / 00</span>
            <span className="mt-1 block text-sm font-semibold">
              {t('projects.title')}
            </span>
          </span>
          <ArrowUpRight className="size-4" />
        </button>
        <Button
          className="mt-0 h-auto min-w-36 justify-between px-4 py-3 md:mt-2 md:w-full"
          variant="outline"
          onClick={onCreateProject}
        >
          <span>{t('app.newProject')}</span>
          <Plus className="size-4" />
        </Button>
      </div>

      <nav
        aria-label={t('app.projects')}
        className="flex gap-px overflow-x-auto bg-border p-px md:block md:bg-transparent md:p-0"
      >
        {projects.map((project, index) => {
          const isActive = selectedProjectId === project.id;
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
              className={`group min-w-52 border-b bg-background px-5 py-4 text-left md:w-full md:min-w-0 ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              <span className="flex items-start justify-between gap-4">
                <span className="min-w-0">
                  <span
                    className={`editorial-meta block ${
                      isActive ? 'text-primary-foreground/70' : 'text-primary'
                    }`}
                  >
                    {String(index + 1).padStart(2, '0')} / Project
                  </span>
                  <span className="mt-2 block truncate text-sm font-semibold">
                    {project.name}
                  </span>
                  <span
                    className={`editorial-meta mt-1 block truncate ${
                      isActive
                        ? 'text-primary-foreground/65'
                        : 'text-muted-foreground'
                    }`}
                  >
                    /{project.slug}
                  </span>
                </span>
                <span
                  className={`mt-0.5 size-2 shrink-0 ${
                    project.activeVersionId
                      ? isActive
                        ? 'bg-primary-foreground'
                        : 'bg-primary'
                      : 'border border-current'
                  }`}
                  aria-hidden="true"
                />
                <span className="sr-only">
                  {project.activeVersionId
                    ? t('projects.production')
                    : t('projects.notLive')}
                </span>
              </span>
            </button>
          );
        })}
        {projects.length === 0 && (
          <div className="min-w-56 px-5 py-6 text-sm text-muted-foreground md:min-w-0">
            <span className="editorial-meta text-primary">00 / Empty</span>
            <p className="mt-2">{t('app.noProjects')}</p>
          </div>
        )}
      </nav>

      <div className="hidden border-t px-6 py-5 md:mt-10 md:block">
        <p className="editorial-meta text-muted-foreground">
          Open source / MIT
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Static artifacts, versioned with intent.
        </p>
      </div>
    </aside>
  );
}
