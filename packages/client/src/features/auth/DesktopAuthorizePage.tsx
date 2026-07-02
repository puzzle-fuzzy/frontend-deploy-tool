import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { desktopAuthorize } from '../../api/desktopAuth';
import { Button } from '../../shared/ui/button';
import { LoginPage } from './LoginPage';
import { useAuth } from './useAuth';

/**
 * Shown by the web SPA at `/desktop-auth` when the desktop client opens the
 * system browser to sign in. The user authenticates here (reusing the normal
 * login form), then clicks Authorize to hand a one-time code back to the
 * desktop's loopback callback (`?cb=…`). The web app never sees the session
 * token — only the server-issued code.
 */
export function DesktopAuthorizePage() {
  const { t } = useTranslation();
  const { user, loading, login, logout } = useAuth();
  const [cb] = useState(() =>
    new URLSearchParams(window.location.search).get('cb')
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!cb) {
    return <Shell>{t('auth.desktopAuth.missingCallback')}</Shell>;
  }
  if (loading) {
    return (
      <Shell>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Shell>
    );
  }
  if (!user) {
    return <LoginPage onLogin={login} />;
  }

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const { code, redirectUri } = await desktopAuthorize(cb);
      const sep = redirectUri.includes('?') ? '&' : '?';
      window.location.href = `${redirectUri}${sep}code=${encodeURIComponent(
        code
      )}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('auth.desktopAuth.failed'));
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void authorize();
        }}
        className="w-full max-w-sm bg-card rounded-2xl border border-border shadow-sm p-6 space-y-4"
      >
        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold">
            {t('auth.desktopAuth.title')}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t('auth.desktopAuth.desc')}
          </p>
        </div>
        <p className="text-center text-sm">
          {t('auth.desktopAuth.signedInAs', { email: user.email })}
        </p>
        {error && (
          <p className="text-xs text-destructive text-center">{error}</p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy
            ? t('auth.desktopAuth.authorizing')
            : t('auth.desktopAuth.authorize')}
        </Button>
        <button
          type="button"
          onClick={() => void logout()}
          className="block w-full text-center text-xs text-muted-foreground underline"
        >
          {t('auth.desktopAuth.notYou')}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center min-h-dvh p-6">
      {children}
    </div>
  );
}
