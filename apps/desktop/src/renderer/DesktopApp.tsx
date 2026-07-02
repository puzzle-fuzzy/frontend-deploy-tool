import type { NativeBridge } from '@deploykit/client';
import {
  ApiClientProvider,
  App,
  NativeProvider,
  ServerInfoProvider,
  useApiClient,
} from '@deploykit/client';
import type { SafeUser } from '@deploykit/shared';
import { Loader2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { createIpcApiClient } from './ipcApiClient';

type Phase = 'loading' | 'onboarding' | 'auth' | 'ready';

/**
 * Composes the renderer-facing `NativeBridge` (consumed via `useNative()`) from
 * the raw `window.deploykit` bridge. The disk-backed upload methods are wired
 * through `nativeUpload.*` so the shared UI never imports Electron types.
 */
function useNativeBridge(): NativeBridge {
  const bridge = window.deploykit;
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
}

export function DesktopApp() {
  const native = useNativeBridge();
  const [phase, setPhase] = useState<Phase>('loading');
  const [origin, setOrigin] = useState('');
  const [user, setUser] = useState<SafeUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
      <ApiClientProvider client={createIpcApiClient()}>
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
        <ApiClientProvider client={createIpcApiClient()}>
          <App />
        </ApiClientProvider>
      </ServerInfoProvider>
    </NativeProvider>
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
    <form
      className="flex flex-col gap-3 max-w-sm mx-auto mt-32 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(url);
      }}
    >
      <h1 className="text-xl font-semibold">
        Connect to your DeployKit server
      </h1>
      <input
        className="border rounded px-3 py-2"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://deploy.example.com"
      />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        className="bg-blue-600 text-white rounded px-4 py-2"
        type="submit"
      >
        Connect
      </button>
    </form>
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalErr(null);
    try {
      const me = await api.login(email, password);
      onLoggedIn(me);
    } catch (err) {
      setLocalErr(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const webLogin = async () => {
    setBusy(true);
    setLocalErr(null);
    try {
      const me = await window.deploykit.native.loginViaWeb();
      if (me) onLoggedIn(me);
    } finally {
      setBusy(false);
    }
  };

  // origin is informational (shown elsewhere); silence the unused warning.
  void origin;

  return (
    <div className="flex flex-col gap-3 max-w-sm mx-auto mt-32 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <form className="flex flex-col gap-3" onSubmit={submit}>
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
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <button
        className="text-sm underline"
        onClick={webLogin}
        disabled={busy}
        type="button"
      >
        Sign in via web page
      </button>
    </div>
  );
}
