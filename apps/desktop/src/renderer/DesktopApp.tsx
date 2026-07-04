import type { NativeBridge } from '@deploykit/client';
import {
  ApiClientProvider,
  App,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  NativeProvider,
  ServerInfoProvider,
  useApiClient,
} from '@deploykit/client';
import type { SafeUser } from '@deploykit/shared';
import { Loader2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createIpcApiClient } from './ipcApiClient';

type Phase = 'loading' | 'onboarding' | 'auth' | 'ready';

/**
 * Composes the renderer-facing `NativeBridge` (consumed via `useNative()`) from
 * the raw `window.deploykit` bridge. The disk-backed upload methods are wired
 * through `nativeUpload.*` so the shared UI never imports Electron types.
 */
function useNativeBridge(): NativeBridge | null {
  return useMemo(() => {
    const bridge = window.deploykit;
    if (!bridge?.api || !bridge.native || !bridge.nativeUpload) return null;

    return {
      ...bridge.native,
      uploadFolder: (projectId, directoryPath, description, onProgress) =>
        bridge.nativeUpload.uploadFolder(
          projectId,
          directoryPath,
          description,
          onProgress
        ),
      uploadZipPath: (projectId, zipPath, description, onProgress) =>
        bridge.nativeUpload.uploadZipPath(
          projectId,
          zipPath,
          description,
          onProgress
        ),
    };
  }, []);
}

export function DesktopApp() {
  const native = useNativeBridge();
  const apiClient = useMemo(() => createIpcApiClient(), []);
  const [phase, setPhase] = useState<Phase>('loading');
  const [origin, setOrigin] = useState('');
  const [user, setUser] = useState<SafeUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!native) return;

    let cancelled = false;
    (async () => {
      const o = await native.getServerOrigin();
      if (cancelled) return;
      if (!o) {
        setPhase('onboarding');
        return;
      }
      setOrigin(o);
      // Resume persisted session.
      try {
        const me = await window.deploykit.api.getMe();
        if (cancelled) return;
        if (me) {
          setUser(me);
          setPhase('ready');
        } else {
          setPhase('auth');
        }
      } catch (e) {
        setPhase('auth');
        setError(e instanceof Error ? e.message : 'Cannot reach server');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [native]);

  const onConnect = useCallback(
    async (url: string) => {
      if (!native) return;
      setError(null);
      const result = await native.validateServer(url);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      await native.configureServer(url);
      setOrigin(url);
      setPhase('auth');
    },
    [native]
  );

  if (!native) {
    return <MissingDesktopBridge />;
  }

  if (phase === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (phase === 'onboarding') {
    return <Onboarding onSubmit={onConnect} error={error} />;
  }

  if (phase === 'auth' || !user) {
    // LoginGate calls useApiClient(), so it needs a provider for the
    // password-login path.
    return (
      <ApiClientProvider client={apiClient}>
        <LoginGate
          origin={origin}
          onLoggedIn={(me) => {
            setUser(me);
            setPhase('ready');
          }}
          error={error}
        />
      </ApiClientProvider>
    );
  }

  return (
    <NativeProvider bridge={native}>
      <ServerInfoProvider origin={origin}>
        <ApiClientProvider client={apiClient}>
          <App />
        </ApiClientProvider>
      </ServerInfoProvider>
    </NativeProvider>
  );
}

function MissingDesktopBridge() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Desktop bridge unavailable</CardTitle>
          <CardDescription>
            Open this screen from the DeployKit desktop app instead of a plain
            browser tab, then reload.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

function Onboarding({
  onSubmit,
  error,
}: {
  onSubmit: (url: string) => void | Promise<void>;
  error: string | null;
}) {
  const [url, setUrl] = useState('http://localhost:3000');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Connect to DeployKit</CardTitle>
          <CardDescription>
            Enter your DeployKit server URL to get started.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit(url);
            }}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://deploy.example.com"
            />
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit">Connect</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function LoginGate({
  origin,
  onLoggedIn,
  error,
}: {
  origin: string;
  onLoggedIn: (me: SafeUser) => void;
  error: string | null;
}) {
  const api = useApiClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [webWaiting, setWebWaiting] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalErr(null);
    try {
      const me =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register({ name: name.trim(), email, password });
      onLoggedIn(me);
    } catch (err) {
      setLocalErr(
        err instanceof Error
          ? err.message
          : mode === 'login'
            ? 'Login failed'
            : 'Registration failed'
      );
    } finally {
      setBusy(false);
    }
  };

  const webLogin = async () => {
    setBusy(true);
    setWebWaiting(true);
    setLocalErr(null);
    try {
      const me = await window.deploykit.native.loginViaWeb();
      if (me) onLoggedIn(me);
    } finally {
      setBusy(false);
      setWebWaiting(false);
    }
  };

  // origin is informational (shown elsewhere); silence the unused warning.
  void origin;

  return (
    <div className="flex flex-col gap-3 max-w-sm mx-auto mt-32 p-6">
      <h1 className="text-xl font-semibold">
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </h1>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        {mode === 'register' && (
          <input
            className="border rounded px-3 py-2"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          className="border rounded px-3 py-2"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="border rounded px-3 py-2"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {(localErr || error) && (
          <p className="text-red-600 text-sm">{localErr ?? error}</p>
        )}
        <button
          className="bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50"
          type="submit"
          disabled={busy}
        >
          {busy
            ? mode === 'login'
              ? 'Signing in…'
              : 'Creating…'
            : mode === 'login'
              ? 'Sign in'
              : 'Register'}
        </button>
      </form>
      {mode === 'login' && (
        <>
          <button
            className="text-sm underline"
            onClick={webLogin}
            disabled={busy}
            type="button"
          >
            {webWaiting ? 'Waiting for browser…' : 'Sign in via web page'}
          </button>
          {webWaiting && (
            <p className="text-sm text-muted-foreground">
              A sign-in page opened in your browser. Sign in and click
              Authorize, then you will return here automatically.
            </p>
          )}
        </>
      )}
      <button
        type="button"
        className="text-sm underline"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login'
          ? 'No account? Register'
          : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}
