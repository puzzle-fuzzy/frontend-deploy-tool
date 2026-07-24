import { ArrowRight, Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast-context';
import { LanguageToggle } from '@/features/i18n/LanguageToggle';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { getLocalizedError } from '@/shared/error-messages';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<unknown>;
  onRegister?: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<unknown>;
}

type AuthMode = 'login' | 'register';

export function LoginPage({ onLogin, onRegister }: LoginPageProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    !submitting &&
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === 'login' || name.trim().length > 0);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);

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
    } catch (error) {
      toast(getLocalizedError(error, t, t('auth.failed')), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    t('auth.stepUpload'),
    t('auth.stepPublish'),
    t('auth.stepRollback'),
  ];

  return (
    <main className="editorial-shell grid min-h-dvh bg-background lg:grid-cols-[1.15fr_0.85fr]">
      <section className="flex min-h-[55dvh] flex-col border-b p-5 sm:p-8 lg:min-h-dvh lg:border-b-0 lg:border-r lg:p-12">
        <div className="auth-section-header">
          <span className="editorial-meta text-primary">DeployKit / 01</span>
          <span className="editorial-meta text-muted-foreground">
            Open source · MIT
          </span>
        </div>

        <div className="editorial-enter flex flex-1 flex-col justify-center py-14 lg:py-20">
          <p className="editorial-eyebrow">{t('auth.eyebrow')}</p>
          <h1 className="editorial-display mt-8">
            {t('auth.heroLine1')}
            <br />
            {t('auth.heroLine2')}
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-foreground/80 sm:text-xl">
            {t('auth.heroDescription')}
          </p>
        </div>

        <div className="editorial-enter-delay grid bg-primary text-primary-foreground sm:grid-cols-[10rem_1fr]">
          <div className="border-b border-primary-foreground/25 p-6 sm:border-b-0 sm:border-r">
            <div className="editorial-number">01</div>
            <div className="editorial-meta mt-10 text-primary-foreground/70">
              Delivery
              <br />
              System
            </div>
          </div>
          <div className="divide-y divide-primary-foreground/25">
            {steps.map((step, index) => (
              <div
                key={step}
                className="flex items-center gap-4 px-6 py-4 text-sm sm:text-base"
              >
                <span className="editorial-meta text-primary-foreground/65">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Check className="size-4 shrink-0" />
                <span>{step}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex min-h-[45dvh] flex-col p-5 sm:p-8 lg:min-h-dvh lg:p-12">
        <div className="auth-section-header">
          <span className="editorial-meta text-primary">Account / Access</span>
          <div className="flex items-center gap-1">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>

        <div className="editorial-enter mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-12">
          <div className="mb-10">
            <span className="editorial-number text-primary">
              {mode === 'login' ? '01' : '02'}
            </span>
            <h2 className="mt-5 text-3xl font-normal tracking-[-0.05em] sm:text-4xl">
              {mode === 'login' ? t('auth.signIn') : t('auth.register')}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {mode === 'login'
                ? t('auth.subtitle')
                : t('auth.registerSubtitle')}
            </p>
          </div>

          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <Tabs
              value={mode}
              onValueChange={(value) => setMode(value as AuthMode)}
            >
              <TabsList className="grid h-14 w-full grid-cols-2 border bg-transparent p-0 group-data-horizontal/tabs:h-14">
                <TabsTrigger
                  value="login"
                  className="h-full border-r font-mono text-xs uppercase tracking-[0.15em] hover:text-primary data-active:bg-primary data-active:text-primary-foreground data-active:hover:text-primary-foreground"
                >
                  {t('auth.signIn')}
                </TabsTrigger>
                <TabsTrigger
                  value="register"
                  className="h-full font-mono text-xs uppercase tracking-[0.15em] hover:text-primary data-active:bg-primary data-active:text-primary-foreground data-active:hover:text-primary-foreground"
                >
                  {t('auth.register')}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'register' && (
              <Field
                id="login-name"
                label={t('auth.name')}
                value={name}
                placeholder={t('auth.namePlaceholder')}
                autoComplete="name"
                onChange={setName}
              />
            )}

            <Field
              id="login-email"
              label={t('auth.email')}
              type="email"
              value={email}
              placeholder={t('auth.emailPlaceholder')}
              autoComplete="email"
              onChange={setEmail}
            />

            <Field
              id="login-password"
              label={t('auth.password')}
              type="password"
              value={password}
              placeholder={t('auth.passwordPlaceholder')}
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              onChange={setPassword}
            />

            <Button
              type="submit"
              disabled={!canSubmit}
              className="mt-2 h-14 justify-between px-5 text-base"
            >
              <span>
                {submitting
                  ? t('common.loading')
                  : mode === 'login'
                    ? t('auth.signIn')
                    : t('auth.register')}
              </span>
              <ArrowRight className="size-5" />
            </Button>
          </form>
        </div>

        <div className="flex items-center justify-between border-t pt-5">
          <span className="editorial-meta text-muted-foreground">
            Secure session / 7 days
          </span>
          <span className="editorial-meta text-muted-foreground">01 / 07</span>
        </div>
      </section>
    </main>
  );
}

function Field({
  id,
  label,
  type = 'text',
  value,
  placeholder,
  autoComplete,
  onChange,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  placeholder: string;
  autoComplete: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="editorial-meta text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="h-13 border-x-0 border-t-0 px-0 text-base focus-visible:ring-0"
        required
      />
    </div>
  );
}
