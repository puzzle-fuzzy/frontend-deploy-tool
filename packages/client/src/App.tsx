import './i18n';
import './index.css';
import { lazy, Suspense } from 'react';
import { ToastProvider } from './components/ui/toast';
import { DesktopAuthorizePage } from './features/auth/DesktopAuthorizePage';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/useAuth';

const ProjectWorkspace = lazy(() =>
  import('./features/projects/ProjectWorkspace').then((module) => ({
    default: module.ProjectWorkspace,
  }))
);

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const { user, loading, login, logout, register } = useAuth();

  const isDesktopAuth =
    typeof window !== 'undefined' &&
    window.location.pathname === '/desktop-auth';

  if (isDesktopAuth) {
    return <DesktopAuthorizePage />;
  }

  if (loading) {
    return <WorkspaceLoading />;
  }

  if (!user) {
    return <LoginPage onLogin={login} onRegister={register} />;
  }

  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <ProjectWorkspace user={user} onLogout={logout} />
    </Suspense>
  );
}

function WorkspaceLoading() {
  return (
    <main className="editorial-shell grid min-h-dvh bg-background sm:grid-cols-[1fr_18rem]">
      <div className="flex flex-col justify-between p-8 sm:p-12">
        <span className="editorial-meta text-primary">DeployKit / Session</span>
        <div className="editorial-enter">
          <h1 className="editorial-display">Loading workspace</h1>
          <div className="mt-10 h-px w-full overflow-hidden bg-border">
            <div className="h-full w-1/3 animate-[loading-line_1.2s_ease-in-out_infinite] bg-primary motion-reduce:animate-none" />
          </div>
        </div>
        <span className="editorial-meta text-muted-foreground">
          Build · preview · publish
        </span>
      </div>
      <div className="flex flex-col justify-between bg-primary p-8 text-primary-foreground sm:p-10">
        <span className="editorial-number">01</span>
        <span className="editorial-meta text-primary-foreground/70">
          Restoring
          <br />
          secure session
        </span>
      </div>
    </main>
  );
}
