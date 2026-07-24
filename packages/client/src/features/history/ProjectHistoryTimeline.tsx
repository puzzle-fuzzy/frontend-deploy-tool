import type { HistoryAction, HistoryEvent } from '@deploykit/shared';
import {
  FileClock,
  FolderPlus,
  FolderSync,
  type LucideIcon,
  Rocket,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
import { Button } from '@/components/ui/button';
import { getLocalizedError } from '@/shared/error-messages';
import { formatBytes, formatDate } from '@/shared/format';

interface ProjectHistoryTimelineProps {
  projectId: string;
  refreshKey: string;
}

const HISTORY_PAGE_SIZE = 50;

const ACTION_ICONS: Record<HistoryAction, LucideIcon> = {
  'project.create': FolderPlus,
  'project.update': FolderSync,
  'project.update_settings': Settings2,
  'project.delete': Trash2,
  'version.upload': Upload,
  'version.publish': Rocket,
  'version.activate': Rocket,
  'version.rollback': RotateCcw,
  'version.delete': Trash2,
  'version.reconcile': ShieldAlert,
};

export function ProjectHistoryTimeline({
  projectId,
  refreshKey,
}: ProjectHistoryTimelineProps) {
  const { t } = useTranslation();
  const api = useApiClient();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const translateRef = useRef(t);
  translateRef.current = t;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setEvents([]);
    setNextCursor(null);
    setLoadingMore(false);
    setLoadMoreError(null);
    setError(null);

    api
      .listProjectHistory(projectId, { limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        if (requestGeneration.current !== generation) return;
        setEvents(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (requestGeneration.current !== generation) return;
        setError(
          getLocalizedError(
            reason,
            translateRef.current,
            translateRef.current('history.failed')
          )
        );
      })
      .finally(() => {
        if (requestGeneration.current === generation) setLoading(false);
      });

    return () => {
      if (requestGeneration.current === generation) {
        requestGeneration.current += 1;
      }
    };
  }, [api, projectId, refreshKey, retryToken]);

  const loadOlder = async () => {
    if (!nextCursor || loadingMore) return;
    const cursor = nextCursor;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await api.listProjectHistory(projectId, {
        limit: HISTORY_PAGE_SIZE,
        cursor,
      });
      if (requestGeneration.current !== generation) return;
      setEvents((current) => {
        const knownIds = new Set(current.map((event) => event.id));
        return [
          ...current,
          ...page.items.filter((event) => !knownIds.has(event.id)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (requestGeneration.current !== generation) return;
      setLoadMoreError(
        getLocalizedError(
          reason,
          translateRef.current,
          translateRef.current('history.failed')
        )
      );
    } finally {
      if (requestGeneration.current === generation) setLoadingMore(false);
    }
  };

  if (loading) {
    return <HistorySkeleton />;
  }

  if (error) {
    return (
      <div className="grid min-h-48 place-items-center border border-destructive/40 bg-card p-6 text-center">
        <div>
          <FileClock className="mx-auto size-7 text-destructive" />
          <p className="mt-4 text-sm font-medium">{error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-5 min-h-11"
            onClick={() => setRetryToken((value) => value + 1)}
          >
            {t('history.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="grid min-h-64 border bg-card sm:grid-cols-[10rem_1fr]">
        <div className="flex items-start border-b bg-primary p-6 text-primary-foreground sm:border-b-0 sm:border-r">
          <FileClock className="size-8" />
        </div>
        <div className="flex flex-col justify-center p-6 sm:p-8">
          <h3 className="text-2xl font-medium tracking-[-0.035em]">
            {t('history.empty')}
          </h3>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
            {t('history.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('history.eventCount', { count: events.length })}
        </span>
        <span className="editorial-meta text-muted-foreground">
          {t('history.latestFirst')}
        </span>
      </div>
      <ol className="border-x border-t">
        {events.map((event, index) => (
          <HistoryRow key={event.id} event={event} index={index} />
        ))}
      </ol>
      {(nextCursor || loadingMore || loadMoreError) && (
        <div className="flex justify-center border-x border-b bg-card p-5">
          {loadMoreError ? (
            <div className="flex flex-col items-center gap-3 text-center sm:flex-row">
              <p className="text-sm text-destructive">{loadMoreError}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={loadingMore}
                onClick={loadOlder}
              >
                {t('history.retryLoadMore')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 min-w-40"
              disabled={loadingMore}
              onClick={loadOlder}
            >
              {loadingMore ? t('history.loadingMore') : t('history.loadMore')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ event, index }: { event: HistoryEvent; index: number }) {
  const { t } = useTranslation();
  const Icon = ACTION_ICONS[event.action];
  const isDestructive = event.action.endsWith('delete');
  const metadata = formatMetadata(
    event,
    typeof event.metadata?.fileCount === 'number'
      ? t('history.files', { count: event.metadata.fileCount })
      : ''
  );

  return (
    <li className="grid border-b bg-card sm:grid-cols-[6rem_4rem_1fr_auto]">
      <div className="border-b p-4 sm:border-b-0 sm:border-r sm:p-5">
        <span className="editorial-meta text-primary">
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <div className="hidden place-items-center border-r sm:grid">
        <span
          className={`grid size-9 place-items-center border ${
            isDestructive
              ? 'border-destructive/40 text-destructive'
              : 'border-primary/35 text-primary'
          }`}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <div className="min-w-0 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <Icon
            className={`size-4 shrink-0 sm:hidden ${
              isDestructive ? 'text-destructive' : 'text-primary'
            }`}
          />
          <p className="font-medium">{t(`history.${event.action}`)}</p>
        </div>
        {event.versionName && (
          <p className="mt-2 truncate font-mono text-xs text-foreground/75">
            {t('history.versionLabel')}: {event.versionName}
          </p>
        )}
        {metadata && (
          <p className="mt-2 text-xs text-muted-foreground">{metadata}</p>
        )}
      </div>
      <div className="flex min-w-44 flex-col justify-between border-t p-4 sm:border-l sm:border-t-0 sm:p-5 sm:text-right">
        <time
          dateTime={event.timestamp}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatDate(event.timestamp)}
        </time>
        <span className="mt-3 truncate text-xs text-muted-foreground">
          {event.actorId === 'system'
            ? t('history.systemActor')
            : `${t('history.actor')} · ${event.actorId}`}
        </span>
      </div>
    </li>
  );
}

function formatMetadata(event: HistoryEvent, fileCountLabel: string): string {
  if (!event.metadata) return '';
  const parts: string[] = [];
  const size =
    typeof event.metadata.size === 'number'
      ? formatBytes(event.metadata.size)
      : '';
  const sourceType =
    typeof event.metadata.sourceType === 'string'
      ? event.metadata.sourceType
      : '';
  if (sourceType) parts.push(sourceType);
  if (fileCountLabel) parts.push(fileCountLabel);
  if (size) parts.push(size);
  return parts.join(' · ');
}

function HistorySkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="border-x border-t"
      role="status"
      aria-label={t('history.loading')}
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="grid min-h-24 animate-pulse border-b bg-card p-5 motion-reduce:animate-none sm:grid-cols-[8rem_1fr_10rem] sm:gap-5"
        >
          <div className="h-4 w-14 bg-muted-foreground/15" />
          <div>
            <div className="h-5 w-40 bg-muted-foreground/15" />
            <div className="mt-3 h-3 w-24 bg-muted-foreground/15" />
          </div>
          <div className="mt-4 h-3 w-28 bg-muted-foreground/15 sm:mt-0" />
        </div>
      ))}
    </div>
  );
}
