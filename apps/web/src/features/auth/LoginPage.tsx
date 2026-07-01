import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

interface Props {
  onLogin: (email: string, password: string) => Promise<unknown>;
}

export function LoginPage({ onLogin }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.invalid'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-dvh p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-card rounded-2xl border border-border shadow-sm p-6 space-y-4"
      >
        <div className="text-center">
          <h1 className="text-lg font-semibold">{t('app.title')}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {t('auth.subtitle')}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="login-email">{t('auth.email')}</Label>
          <Input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="login-password">{t('auth.password')}</Label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="submit"
          className="w-full"
          disabled={submitting || !email || !password}
        >
          {submitting ? t('common.loading') : t('auth.signIn')}
        </Button>
      </form>
    </div>
  );
}
