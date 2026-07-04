import './i18n';
import './index.css';
import { Loader2 } from 'lucide-react';
import { DesktopAuthorizePage } from './features/auth/DesktopAuthorizePage';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/useAuth';
import { ProjectWorkspace } from './features/projects/ProjectWorkspace';

export default function App() {
  const { user, loading, login, logout, register } = useAuth();

  const isDesktopAuth =
    typeof window !== 'undefined' &&
    window.location.pathname === '/desktop-auth';

  if (isDesktopAuth) {
    return <DesktopAuthorizePage />;
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={login} onRegister={register} />;
  }

  return <ProjectWorkspace user={user} onLogout={logout} />;
}
