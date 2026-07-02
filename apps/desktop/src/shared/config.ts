import Store from 'electron-store';

interface DesktopConfig {
  serverOrigin: string;
}

const store = new Store<DesktopConfig>({
  defaults: { serverOrigin: '' },
});

/** Normalizes a user-entered URL: trims, strips trailing slash. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function getServerOrigin(): string {
  return store.get('serverOrigin');
}

export function setServerOrigin(origin: string): void {
  store.set('serverOrigin', normalizeOrigin(origin));
}

export function clearServerOrigin(): void {
  store.set('serverOrigin', '');
}

/** True when the origin is http:// and not localhost — warn about cleartext creds. */
export function isInsecureOrigin(origin: string): boolean {
  return (
    /^http:\/\//i.test(origin) && !/\/\/(localhost|127\.0\.0\.1)/i.test(origin)
  );
}
