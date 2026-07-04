import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

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

  const switchMode = (next: string) => {
    const value = next as Mode;
    if (value === mode) return;
    setError(null);
    setMode(value);
  };

  const canSubmit =
    !submitting &&
    Boolean(email && password) &&
    (mode === 'login' || name.trim().length > 0);

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('app.title')}</CardTitle>
          <CardDescription>
            {mode === 'login' ? t('auth.subtitle') : t('auth.registerSubtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              {onRegister && (
                <Field>
                  <Tabs value={mode} onValueChange={switchMode}>
                    <TabsList className="w-full">
                      <TabsTrigger value="login">
                        {t('auth.signIn')}
                      </TabsTrigger>
                      <TabsTrigger value="register">
                        {t('auth.register')}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </Field>
              )}

              {mode === 'register' && (
                <Field>
                  <FieldLabel htmlFor="auth-name">{t('auth.name')}</FieldLabel>
                  <Input
                    id="auth-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                  />
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="auth-email">{t('auth.email')}</FieldLabel>
                <Input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="auth-password">
                  {t('auth.password')}
                </FieldLabel>
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
                <FieldDescription>
                  {mode === 'login' ? t('auth.signIn') : t('auth.register')}
                </FieldDescription>
              </Field>

              {error && <FieldError>{error}</FieldError>}

              <Button type="submit" disabled={!canSubmit}>
                {submitting
                  ? t('common.loading')
                  : mode === 'login'
                    ? t('auth.signIn')
                    : t('auth.register')}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
