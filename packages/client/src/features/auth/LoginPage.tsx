import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../shared/ui/button';
import { Input } from '../../shared/ui/input';
import { Label } from '../../shared/ui/label';

interface Props {
  onLogin: (email: string, password: string) => Promise<unknown>;
  /** When provided, a "register" mode is offered alongside sign-in. */
  onRegister?: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<unknown>;
}

type Mode = 'login' | 'register';

export function LoginPage({ onLogin, onRegister }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'login') {
        await onLogin(email.trim(), password);
      } else {
        await onRegister?.({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : mode === 'login'
            ? t('auth.invalid')
            : t('auth.registerFailed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setError(null);
    setMode(next);
  };

  const canSubmit =
    !submitting &&
    Boolean(email && password) &&
    (mode === 'login' || name.trim().length > 0);

  return (
    <div className="flex items-center justify-center min-h-dvh p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-card rounded-2xl border border-border shadow-sm p-6 space-y-4"
      >
        <div className="text-center">
          <h1 className="text-lg font-semibold">{t('app.title')}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {mode === 'login' ? t('auth.subtitle') : t('auth.registerSubtitle')}
          </p>
        </div>
        {mode === 'register' && (
          <div className="space-y-1.5">
            <Label htmlFor="auth-name">{t('auth.name')}</Label>
            <Input
              id="auth-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="auth-email">{t('auth.email')}</Label>
          <Input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="auth-password">{t('auth.password')}</Label>
          <Input
            id="auth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={
              mode === 'login' ? 'current-password' : 'new-password'
            }
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={!canSubmit}>
          {submitting
            ? t('common.loading')
            : mode === 'login'
              ? t('auth.signIn')
              : t('auth.register')}
        </Button>
        {onRegister && (
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            className="block w-full text-center text-xs text-muted-foreground underline"
          >
            {mode === 'login' ? t('auth.goToRegister') : t('auth.goToLogin')}
          </button>
        )}
      </form>
    </div>
  );
}
