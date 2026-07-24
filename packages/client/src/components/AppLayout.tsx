import type { ReactNode } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { AppSidebar } from '@/components/AppSidebar';
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
    <div className="editorial-shell flex min-h-dvh flex-col bg-background">
      <AppHeader user={user} onLogout={onLogout} />
      <div className="grid flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
        <AppSidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onShowProjects={onShowProjects}
          onCreateProject={onCreateProject}
        />
        <main id="main-content" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
