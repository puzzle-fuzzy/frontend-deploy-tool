import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectList } from '@/features/projects/ProjectList';
import type { Project } from '@/shared/types';
import { TooltipProvider } from '@/shared/ui/tooltip';

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: id,
  slug: id,
  description: '',
  createdAt: '',
  updatedAt: '',
  versions: [],
  activeVersionId: null,
  settings: { spaMode: false, routingType: 'path' },
  ...overrides,
});

const noop = () => {};

describe('ProjectList', () => {
  it('renders the empty state when there are no projects', () => {
    render(
      <ProjectList
        projects={[]}
        loading={false}
        selectedProjectId={undefined}
        onSelect={noop}
        onCreate={noop}
      />
    );
    expect(screen.getByText('projects.empty')).toBeInTheDocument();
  });

  it('renders a row per project and selects on click', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ProjectList
          projects={[
            project('a', { name: 'Alpha' }),
            project('b', { name: 'Beta' }),
          ]}
          loading={false}
          selectedProjectId={undefined}
          onSelect={onSelect}
          onCreate={noop}
        />
      </TooltipProvider>
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    await user.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alpha' })
    );
  });
});
