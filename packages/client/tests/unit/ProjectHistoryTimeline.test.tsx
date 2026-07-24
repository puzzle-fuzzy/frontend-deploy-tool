import type { HistoryEvent } from '@deploykit/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectHistoryTimeline } from '../../src/features/history/ProjectHistoryTimeline';
import { mockApiClient, renderWithClient } from '../helpers/renderWithClient';

function historyEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: 'history-1',
    action: 'project.create',
    projectId: 'project-1',
    projectName: 'Signal Desk',
    versionId: '',
    versionName: '',
    timestamp: '2026-07-24T08:30:00.000Z',
    actorId: 'user-1',
    ...overrides,
  };
}

describe('ProjectHistoryTimeline', () => {
  it('renders project events in the API order', async () => {
    const client = mockApiClient({
      listProjectHistory: vi.fn().mockResolvedValue([
        historyEvent({
          id: 'history-2',
          action: 'version.upload',
          versionId: 'version-1',
          versionName: 'Build 01',
        }),
        historyEvent(),
      ]),
    });

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      client
    );

    await waitFor(() =>
      expect(client.listProjectHistory).toHaveBeenCalledWith('project-1', 50)
    );
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('history.version.upload');
    expect(items[0]).toHaveTextContent('Build 01');
    expect(items[1]).toHaveTextContent('history.project.create');
  });

  it('renders a helpful empty state', async () => {
    const client = mockApiClient({
      listProjectHistory: vi.fn().mockResolvedValue([]),
    });

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      client
    );

    expect(await screen.findByText('history.empty')).toBeInTheDocument();
    expect(screen.getByText('history.emptyDesc')).toBeInTheDocument();
  });

  it('retries after a failed request', async () => {
    const listProjectHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce([historyEvent()]);
    const client = mockApiClient({ listProjectHistory });
    const user = userEvent.setup();

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      client
    );

    await user.click(
      await screen.findByRole('button', { name: 'history.retry' })
    );

    expect(
      await screen.findByText('history.project.create')
    ).toBeInTheDocument();
    expect(listProjectHistory).toHaveBeenCalledTimes(2);
  });

  it('loads older events in bounded batches', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      historyEvent({ id: `history-${index}` })
    );
    const expandedPage = [...firstPage, historyEvent({ id: 'history-older' })];
    const listProjectHistory = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(expandedPage);
    const user = userEvent.setup();

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      mockApiClient({ listProjectHistory })
    );

    await user.click(
      await screen.findByRole('button', { name: 'history.loadMore' })
    );

    await waitFor(() =>
      expect(listProjectHistory).toHaveBeenLastCalledWith('project-1', 100)
    );
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')).toHaveLength(51)
    );
    expect(
      screen.queryByRole('button', { name: 'history.loadMore' })
    ).not.toBeInTheDocument();
  });
});
