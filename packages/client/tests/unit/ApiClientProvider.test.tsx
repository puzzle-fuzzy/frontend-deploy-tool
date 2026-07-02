import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@/api/ApiClient';
import { ApiClientProvider, useApiClient } from '@/api/ApiClientProvider';

const stubClient = { getMe: vi.fn() } as unknown as ApiClient;

function Consumer() {
  const c = useApiClient();
  return <span>{c === stubClient ? 'got-it' : 'wrong'}</span>;
}

describe('ApiClientProvider', () => {
  it('provides the client through context', () => {
    render(
      <ApiClientProvider client={stubClient}>
        <Consumer />
      </ApiClientProvider>
    );
    expect(screen.getByText('got-it')).toBeInTheDocument();
  });

  it('throws when used without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/ApiClientProvider/);
    spy.mockRestore();
  });
});
