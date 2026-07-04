import './i18n';
import './index.css';
import { Loader2 } from 'lucide-react';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DesktopAuthorizePage } from './features/auth/DesktopAuthorizePage';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/useAuth';
import { DeployPage } from './pages/DeployPage';

export default function App() {
  const { user, loading, login, logout, register } = useAuth();

  // The desktop client opens the system browser at `/desktop-auth` to authorize.
  const isDesktopAuth =
    typeof window !== 'undefined' &&
    window.location.pathname === '/desktop-auth';

  const content = isDesktopAuth ? (
    <DesktopAuthorizePage />
  ) : loading ? (
    <div className="flex items-center justify-center min-h-dvh">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  ) : user ? (
    <DeployPage user={user} onLogout={logout} />
  ) : (
    <LoginPage onLogin={login} onRegister={register} />
  );

  return (
    <TooltipProvider>
      <ToastProvider>{content}</ToastProvider>
    </TooltipProvider>
  );
}
