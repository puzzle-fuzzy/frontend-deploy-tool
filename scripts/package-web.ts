import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Package the built web assets (apps/web/dist) into the server's public dir so
// the backend can serve the management UI. The web app builds to its own
// package-local `dist`; this copy is the packaging step that decouples the web
// build output from the server's served directory.
const root = resolve(import.meta.dir, '..');
const src = resolve(root, 'apps', 'web', 'dist');
const dest = resolve(root, 'apps', 'server', 'public');

if (!existsSync(src)) {
  console.error(
    `[package-web] web build output not found at ${src}. Run "bun run build" first.`
  );
  process.exit(1);
}

// Mirror dist into public exactly (clear stale assets first).
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

console.log('[package-web] copied apps/web/dist → apps/server/public');
