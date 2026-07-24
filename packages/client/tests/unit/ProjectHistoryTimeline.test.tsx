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
      listProjectHistory: vi.fn().mockResolvedValue({
        items: [
          historyEvent({
            id: 'history-2',
            action: 'version.upload',
            versionId: 'version-1',
            versionName: 'Build 01',
          }),
          historyEvent(),
        ],
        nextCursor: null,
      }),
    });

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      client
    );

    await waitFor(() =>
      expect(client.listProjectHistory).toHaveBeenCalledWith('project-1', {
        limit: 50,
      })
    );
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('history.version.upload');
    expect(items[0]).toHaveTextContent('Build 01');
    expect(items[1]).toHaveTextContent('history.project.create');
  });

  it('renders a helpful empty state', async () => {
    const client = mockApiClient({
      listProjectHistory: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
      }),
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
      .mockResolvedValueOnce({
        items: [historyEvent()],
        nextCursor: null,
      });
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

  it('loads older events using the next cursor and appends unique rows', async () => {
    const firstPage = [
      historyEvent({ id: 'history-newest' }),
      historyEvent({ id: 'history-middle' }),
    ];
    const listProjectHistory = vi
      .fn()
      .mockResolvedValueOnce({
        items: firstPage,
        nextCursor: 'cursor-middle',
      })
      .mockResolvedValueOnce({
        items: [
          historyEvent({ id: 'history-middle' }),
          historyEvent({ id: 'history-oldest' }),
        ],
        nextCursor: null,
      });
    const user = userEvent.setup();

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      mockApiClient({ listProjectHistory })
    );

    await user.click(
      await screen.findByRole('button', { name: 'history.loadMore' })
    );

    await waitFor(() =>
      expect(listProjectHistory).toHaveBeenLastCalledWith('project-1', {
        limit: 50,
        cursor: 'cursor-middle',
      })
    );
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')).toHaveLength(3)
    );
    expect(
      screen.queryByRole('button', { name: 'history.loadMore' })
    ).not.toBeInTheDocument();
  });

  it('resets the cursor and replaces rows when the refresh key changes', async () => {
    const listProjectHistory = vi
      .fn()
      .mockResolvedValueOnce({
        items: [historyEvent({ id: 'history-before' })],
        nextCursor: 'cursor-before',
      })
      .mockResolvedValueOnce({
        items: [historyEvent({ id: 'history-after' })],
        nextCursor: null,
      });
    const client = mockApiClient({ listProjectHistory });
    const view = renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      client
    );

    expect(
      await screen.findByText('history.project.create')
    ).toBeInTheDocument();
    view.rerender(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="updated" />
    );

    await waitFor(() => expect(listProjectHistory).toHaveBeenCalledTimes(2));
    expect(listProjectHistory).toHaveBeenLastCalledWith('project-1', {
      limit: 50,
    });
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('01');
  });

  it('keeps rendered events when loading older history fails and retries', async () => {
    const listProjectHistory = vi
      .fn()
      .mockResolvedValueOnce({
        items: [historyEvent({ id: 'history-current' })],
        nextCursor: 'cursor-current',
      })
      .mockRejectedValueOnce(new Error('Older history unavailable'))
      .mockResolvedValueOnce({
        items: [historyEvent({ id: 'history-older' })],
        nextCursor: null,
      });
    const user = userEvent.setup();

    renderWithClient(
      <ProjectHistoryTimeline projectId="project-1" refreshKey="initial" />,
      mockApiClient({ listProjectHistory })
    );

    await user.click(
      await screen.findByRole('button', { name: 'history.loadMore' })
    );
    expect(await screen.findByText('Older history unavailable')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    await user.click(
      screen.getByRole('button', { name: 'history.retryLoadMore' })
    );
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')).toHaveLength(2)
    );
    expect(listProjectHistory).toHaveBeenLastCalledWith('project-1', {
      limit: 50,
      cursor: 'cursor-current',
    });
  });
});
