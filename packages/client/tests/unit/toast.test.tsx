import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { useToast } from '@/components/ui/toast-context';

vi.unmock('@/components/ui/toast-context');

const Trigger = ({ message, type }: { message: string; type?: 'error' }) => {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(message, type)}>
      fire
    </button>
  );
};

function withProvider(node: ReactNode) {
  return <ToastProvider>{node}</ToastProvider>;
}

describe('ToastProvider', () => {
  it('shows a success toast through sonner', async () => {
    render(withProvider(<Trigger message="Saved" />));
    screen.getByRole('button', { name: 'fire' }).click();

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });
    expect(screen.getByRole('region')).toHaveAttribute('aria-live', 'polite');
  });

  it('shows an error toast through sonner', async () => {
    render(withProvider(<Trigger message="Failed" type="error" />));
    screen.getByRole('button', { name: 'fire' }).click();

    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });
});
