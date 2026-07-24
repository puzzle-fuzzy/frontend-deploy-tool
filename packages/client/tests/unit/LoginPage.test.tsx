import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/components/ui/toast';
import { LoginPage } from '../../src/features/auth/LoginPage';

vi.unmock('@/components/ui/toast-context');

function renderLoginPage(props: React.ComponentProps<typeof LoginPage>) {
  return render(
    <ToastProvider>
      <LoginPage {...props} />
    </ToastProvider>
  );
}

describe('LoginPage', () => {
  it('submits the email and password via onLogin', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLoginPage({ onLogin });

    await user.type(screen.getByLabelText('auth.email'), 'a@b.c');
    await user.type(screen.getByLabelText('auth.password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'auth.signIn' }));

    expect(onLogin).toHaveBeenCalledWith('a@b.c', 'secret');
  });

  it('shows a localized toast without inserting an inline error', async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValue(new Error('Invalid email or password'));
    const user = userEvent.setup();
    renderLoginPage({ onLogin });

    await user.type(screen.getByLabelText('auth.email'), 'a@b.c');
    await user.type(screen.getByLabelText('auth.password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'auth.signIn' }));

    expect(
      await screen.findByText('error.invalidCredentials')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Invalid email or password')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-inline-error')).not.toBeInTheDocument();
  });
});
