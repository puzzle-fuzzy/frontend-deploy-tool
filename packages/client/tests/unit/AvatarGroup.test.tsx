import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AvatarGroup } from '../../src/shared/ui/avatar-group';

const users = [
  { id: '1', name: 'Alice' },
  { id: '2', name: 'Bob' },
  { id: '3', name: 'Charlie' },
  { id: '4', name: 'Diana' },
  { id: '5', name: 'Eve' },
  { id: '6', name: 'Frank' },
];

describe('AvatarGroup', () => {
  it('renders up to max avatars plus overflow count', () => {
    render(<AvatarGroup users={users} max={4} />);
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText('BO')).toBeInTheDocument();
    expect(screen.getByText('CH')).toBeInTheDocument();
    expect(screen.getByText('DI')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('renders all when under max', () => {
    render(<AvatarGroup users={users.slice(0, 3)} max={5} />);
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText('BO')).toBeInTheDocument();
    expect(screen.getByText('CH')).toBeInTheDocument();
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders nothing for empty users', () => {
    const { container } = render(<AvatarGroup users={[]} max={4} />);
    expect(container.firstChild).toBeNull();
  });
});
