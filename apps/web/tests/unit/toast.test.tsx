import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/shared/ui/toast';
import { useToast } from '@/shared/ui/toast-context';

// setup.ts no-ops the toast module globally so other tests don't need a
// provider; this file exercises the real provider, so restore the real module.
vi.unmock('@/shared/ui/toast-context');

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

  it('can be dismissed early via the keyboard-accessible close button', () => {
    render(withProvider(<Trigger message="Hello" />));
    act(() => {
      screen.getByRole('button', { name: 'fire' }).click();
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    // The close button is a real <button> (keyboard-focusable; Enter/Space
    // fire the same click) with an accessible name.
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
