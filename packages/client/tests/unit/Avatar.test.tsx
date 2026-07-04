import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

describe('Avatar', () => {
  it('renders children inside the avatar container', () => {
    render(
      <Avatar>
        <AvatarFallback>AD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText('AD')).toBeInTheDocument();
  });

  it('renders fallback when there is no image', () => {
    render(
      <Avatar>
        <AvatarFallback>XX</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText('XX')).toBeInTheDocument();
  });
});
