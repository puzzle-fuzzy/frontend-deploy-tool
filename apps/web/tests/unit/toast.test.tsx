import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/shared/ui/toast';
import { useToast } from '@/shared/ui/toast-context';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

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
  it('announces a success toast with role=status / aria-live=polite', () => {
    render(withProvider(<Trigger message="Saved" />));
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click();
    });

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('announces an error toast with role=alert / aria-live=assertive', () => {
    render(withProvider(<Trigger message="Failed" type="error" />));
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click();
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('can be dismissed early via the keyboard-accessible close button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(withProvider(<Trigger message="Hello" />));
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click();
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'common.close' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
