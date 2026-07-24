import type { NativeBridge } from '@deploykit/client';
import {
  ApiClientProvider,
  App,
  Button,
  Input,
  NativeProvider,
  ServerInfoProvider,
} from '@deploykit/client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createIpcApiClient, unwrapIpcResult } from './ipcApiClient';

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
        unwrapIpcResult(
          bridge.nativeUpload.uploadFolder(
            projectId,
            directoryPath,
            description,
            onProgress
          )
        ),
      uploadZipPath: (projectId, zipPath, description, onProgress) =>
        unwrapIpcResult(
          bridge.nativeUpload.uploadZipPath(
            projectId,
            zipPath,
            description,
            onProgress
          )
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
      <main className="editorial-shell grid min-h-dvh bg-background md:grid-cols-[1fr_18rem]">
        <div className="flex flex-col justify-between p-10">
          <span className="editorial-meta text-primary">
            DeployKit / Desktop
          </span>
          <div>
            <h1 className="editorial-display">Loading workspace</h1>
            <Loader2 className="mt-10 size-5 animate-spin text-primary" />
          </div>
          <span className="editorial-meta text-muted-foreground">
            Native client / Electron
          </span>
        </div>
        <div className="flex flex-col justify-between bg-primary p-8 text-primary-foreground">
          <span className="editorial-number">01</span>
          <span className="editorial-meta text-primary-foreground/70">
            Connecting
          </span>
        </div>
      </main>
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
    <main className="editorial-shell grid min-h-dvh bg-background md:grid-cols-[16rem_1fr]">
      <div className="flex flex-col justify-between bg-primary p-8 text-primary-foreground">
        <span className="editorial-number">00</span>
        <span className="editorial-meta text-primary-foreground/70">
          Bridge missing
        </span>
      </div>
      <div className="flex flex-col justify-center p-8 md:p-16">
        <span className="editorial-meta text-primary">Desktop / Runtime</span>
        <h1 className="mt-6 max-w-2xl text-5xl font-light tracking-[-0.06em]">
          Desktop bridge unavailable
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
          Open this screen from the DeployKit desktop app instead of a plain
          browser tab, then reload.
        </p>
      </div>
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
    <main className="editorial-shell grid min-h-dvh bg-background md:grid-cols-[1fr_0.8fr]">
      <section className="flex flex-col justify-between border-b p-8 md:border-b-0 md:border-r md:p-12">
        <div className="flex justify-between border-b pb-5">
          <span className="editorial-meta text-primary">
            DeployKit / Desktop
          </span>
          <span className="editorial-meta text-muted-foreground">01 / 03</span>
        </div>
        <div>
          <span className="editorial-eyebrow">Remote server / Origin</span>
          <h1 className="editorial-display mt-8">Connect workspace</h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Enter the address of the DeployKit server this desktop client should
            manage.
          </p>
        </div>
        <span className="editorial-meta text-muted-foreground">
          Native upload · System notifications
        </span>
      </section>
      <section className="flex flex-col justify-center p-8 md:p-12">
        <div className="mb-10 bg-primary p-6 text-primary-foreground">
          <span className="editorial-number">01</span>
          <p className="editorial-meta mt-16 text-primary-foreground/70">
            Server origin
          </p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(url);
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://deploy.example.com"
            className="h-13 font-mono"
          />
          {error && (
            <p className="border-l-4 border-destructive bg-destructive/8 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-13 justify-between px-5">
            Connect
            <span aria-hidden>→</span>
          </Button>
        </form>
      </section>
    </main>
  );
}
