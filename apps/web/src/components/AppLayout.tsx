import type { ReactNode } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { AppHeader } from '@/components/AppHeader';
import type { Project, SafeUser } from '@/shared/types';

interface AppLayoutProps {
  children: ReactNode;
  projects: Project[];
  selectedProjectId: string | null;
  user: SafeUser;
  onSelectProject: (project: Project) => void;
  onShowProjects: () => void;
  onCreateProject: () => void;
  onLogout: () => void;
}

export function AppLayout({
  children,
  projects,
  selectedProjectId,
  user,
  onSelectProject,
  onShowProjects,
  onCreateProject,
  onLogout,
}: AppLayoutProps) {
  return (
    <SidebarProvider className="mx-auto h-svh w-full max-w-6xl items-start">
      <AppSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        onShowProjects={onShowProjects}
        onCreateProject={onCreateProject}
      />
      <main className="flex h-svh flex-1 flex-col overflow-hidden">
        <ScrollArea className="h-svh w-full">
          <AppHeader user={user} onLogout={onLogout} />
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6 pt-0">
            {children}
          </div>
        </ScrollArea>
      </main>
    </SidebarProvider>
  );
}
