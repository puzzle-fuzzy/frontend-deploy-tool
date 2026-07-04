import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<unknown>;
  onRegister: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<unknown>;
}

type AuthMode = 'login' | 'register';

export function LoginPage({ onLogin, onRegister }: LoginPageProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    !submitting &&
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === 'login' || name.trim().length > 0);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (mode === 'login') {
        await onLogin(email.trim(), password);
      } else {
        await onRegister({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>DeployKit</CardTitle>
          <CardDescription>
            {mode === 'login' ? t('auth.subtitle') : t('auth.registerSubtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as AuthMode);
                setError(null);
              }}
            >
              <TabsList className="w-full">
                <TabsTrigger value="login">{t('auth.signIn')}</TabsTrigger>
                <TabsTrigger value="register">{t('auth.register')}</TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'register' && (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {t('auth.name')}
                <Input
                  value={name}
                  placeholder={t('auth.namePlaceholder')}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                />
              </label>
            )}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('auth.email')}
              <Input
                type="email"
                value={email}
                placeholder={t('auth.emailPlaceholder')}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t('auth.password')}
              <Input
                type="password"
                value={password}
                placeholder={t('auth.passwordPlaceholder')}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  mode === 'login' ? 'current-password' : 'new-password'
                }
                required
              />
            </label>

            {error && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={!canSubmit}>
              {submitting
                ? t('common.loading')
                : mode === 'login'
                  ? t('auth.signIn')
                  : t('auth.register')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
