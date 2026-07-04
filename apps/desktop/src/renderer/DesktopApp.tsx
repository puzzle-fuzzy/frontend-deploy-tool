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
} from '@deploykit/client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createIpcApiClient } from './ipcApiClient';

type Phase = 'loading' | 'onboarding' | 'ready';

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
      // The shared <App /> handles auth (loading → LoginPage → workspace).
      setPhase('ready');
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
      // Let the shared <App /> handle auth from here.
      setPhase('ready');
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

  // Once the server is configured, the shared <App /> from @deploykit/client
  // handles the full auth + workspace flow — identical to the web app.
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
  const [url, setUrl] = useState('http://localhost:4010');
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
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit">Connect</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
