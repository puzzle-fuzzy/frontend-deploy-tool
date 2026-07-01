import { FolderOpen, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeployUrl } from '@/features/deploy/DeployUrl';
import { LanguageToggle } from '@/features/i18n/LanguageToggle';
import { CreateProjectDialog } from '@/features/projects/CreateProjectDialog';
import { ProjectList } from '@/features/projects/ProjectList';
import { useProjects } from '@/features/projects/useProjects';
import { ProjectSettingsDialog } from '@/features/settings/ProjectSettingsDialog';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { UploadVersionDialog } from '@/features/versions/UploadVersionDialog';
import { VersionList } from '@/features/versions/VersionList';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

export function DeployPage() {
  const { t } = useTranslation();
  const {
    projects,
    loading,
    selectedProject,
    pendingVersionId,
    selectProject,
    refresh,
    activateVersion,
    deleteVersion,
    onProjectDeleted,
  } = useProjects();
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="flex items-center justify-center min-h-dvh p-4 lg:p-6">
      <div className="w-full max-w-7xl min-h-[70dvh] bg-card rounded-2xl border border-border shadow-sm flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-6 text-primary" />
            <h1 className="text-lg font-semibold">{t('app.title')}</h1>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Separator orientation="vertical" className="h-5 mx-1" />
            <LanguageToggle />
          </div>
        </div>

        {/* Two-column body */}
        <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
          <ProjectList
            projects={projects}
            loading={loading}
            selectedProjectId={selectedProject?.id}
            onSelect={selectProject}
            onCreate={() => setShowCreate(true)}
          />

          {/* Right: Version panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedProject ? (
              <>
                <div className="px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-3">
                    <div className="shrink-0">
                      <h2 className="text-lg font-semibold">
                        {selectedProject.name}
                      </h2>
                      <p className="text-sm text-muted-foreground font-mono">
                        {selectedProject.slug}
                      </p>
                    </div>
                    <DeployUrl
                      slug={selectedProject.slug}
                      activeVersionId={selectedProject.activeVersionId}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setShowSettings(true)}
                        >
                          <Settings className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('settings.title')}</TooltipContent>
                    </Tooltip>
                    <Button size="default" onClick={() => setShowUpload(true)}>
                      <Plus className="size-4" />
                      {t('versions.upload')}
                    </Button>
                  </div>
                </div>

                <VersionList
                  project={selectedProject}
                  pendingVersionId={pendingVersionId}
                  onActivate={activateVersion}
                  onDelete={deleteVersion}
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center">
                <FolderOpen className="size-12 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('projects.empty')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <CreateProjectDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={refresh}
      />
      <UploadVersionDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        projectId={selectedProject?.id ?? ''}
        onUploaded={refresh}
      />
      <ProjectSettingsDialog
        key={selectedProject?.id ?? 'no-project'}
        open={showSettings}
        onOpenChange={setShowSettings}
        project={selectedProject}
        onDeleted={onProjectDeleted}
      />
    </div>
  );
}
