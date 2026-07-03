import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '../../src/shared/ui/avatar';

describe('Avatar', () => {
  it('renders children inside the avatar container', () => {
    render(
      <Avatar>
        <AvatarImage src="data:," alt="user" />
        <AvatarFallback>AD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText('AD')).toBeInTheDocument();
    expect(screen.getByAltText('user')).toBeInTheDocument();
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
