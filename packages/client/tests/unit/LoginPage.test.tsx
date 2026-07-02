import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from '@/features/auth/LoginPage';

describe('LoginPage', () => {
  it('submits the email and password via onLogin', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LoginPage onLogin={onLogin} />);

    await user.type(screen.getByLabelText('auth.email'), 'a@b.c');
    await user.type(screen.getByLabelText('auth.password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'auth.signIn' }));

    expect(onLogin).toHaveBeenCalledWith('a@b.c', 'secret');
  });

  it('surfaces an error message when login fails', async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error('Invalid credentials'));
    const user = userEvent.setup();
    render(<LoginPage onLogin={onLogin} />);

    await user.type(screen.getByLabelText('auth.email'), 'a@b.c');
    await user.type(screen.getByLabelText('auth.password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'auth.signIn' }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });
});
