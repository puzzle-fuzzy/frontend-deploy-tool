import type { ApiClient } from '@deploykit/client';
import { ApiClientProvider } from '@deploykit/client';
import { type RenderOptions, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

/** Builds a mock ApiClient whose every method is a vi.fn returning undefined. */
export function mockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const stub = {
    getMe: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    updateSettings: vi.fn(),
    uploadVersion: vi.fn(),
    publishVersion: vi.fn(),
    rollbackVersion: vi.fn(),
    deleteVersion: vi.fn(),
  } as unknown as ApiClient;
  return Object.assign(stub, overrides) as ApiClient;
}

/** Wraps children in an ApiClientProvider backed by the given client. */
export function clientWrapper(client: ApiClient) {
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
}

export function renderWithClient(
  ui: ReactNode,
  client: ApiClient,
  options?: RenderOptions
) {
  // Pass the provider as the RTL `wrapper` so `rerender` re-applies it too.
  return render(ui, { wrapper: clientWrapper(client), ...options });
}
