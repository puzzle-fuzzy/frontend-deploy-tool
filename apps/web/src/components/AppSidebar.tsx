import {
  IconArchive,
  IconBox,
  IconDots,
  IconFolderOpen,
  IconPlus,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { capabilities } from '@/shared/capabilities';
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
    <Sidebar collapsible="none" className="hidden md:flex p-2">
      <SidebarMenu>
        <SidebarMenuItem className="flex items-center gap-2 pt-14">
          <SidebarMenuButton
            tooltip={t('app.projects')}
            onClick={onShowProjects}
            className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
          >
            <IconFolderOpen />
            <span>{t('app.projects')}</span>
          </SidebarMenuButton>
          <Button
            size="icon"
            className="size-8 group-data-[collapsible=icon]:opacity-0"
            variant="outline"
            onClick={onCreateProject}
            aria-label={t('app.newProject')}
          >
            <IconPlus />
            <span className="sr-only">{t('app.newProject')}</span>
          </Button>
        </SidebarMenuItem>
      </SidebarMenu>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarGroupLabel>{t('app.projects')}</SidebarGroupLabel>
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={selectedProjectId === project.id}
                    onClick={() => onSelectProject(project)}
                  >
                    <IconBox />
                    <span>{project.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {projects.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    <IconBox />
                    <span>{t('app.noProjects')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}

              <Separator />

              <SidebarGroupLabel>{t('app.archive')}</SidebarGroupLabel>
              <SidebarMenuItem>
                <SidebarMenuButton disabled={!capabilities.projectArchive}>
                  <IconArchive />
                  <span>{t('app.archivedProjects')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton className="text-sidebar-foreground/70">
                  <IconDots className="text-sidebar-foreground/70" />
                  <span>{t('app.more')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
