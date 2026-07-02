import { Loader2 } from 'lucide-react';
import { ToastProvider } from '@/shared/ui/toast';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/useAuth';
import { DeployPage } from './pages/DeployPage';

export default function App() {
  const { user, loading, login, logout } = useAuth();

  const content = loading ? (
    <div className="flex items-center justify-center min-h-dvh">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  ) : user ? (
    <DeployPage user={user} onLogout={logout} />
  ) : (
    <LoginPage onLogin={login} />
  );

  return (
    <TooltipProvider>
      <ToastProvider>{content}</ToastProvider>
    </TooltipProvider>
  );
}
