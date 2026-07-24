import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast-context';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useServerInfo } from '../../api/ServerInfoProvider';
import { publicBaseURL } from '../../shared/config';

interface Props {
  slug: string;
  /** null while no version has been published. */
  activeVersionId: string | null;
}

export function DeployUrl({ slug, activeVersionId }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  // Desktop: use the user-configured server origin (from ServerInfoProvider).
  // Web: ServerInfoProvider is absent, so origin is '' → fall back to publicBaseURL.
  const { origin } = useServerInfo();
  const baseUrl = origin || publicBaseURL;
  const deployUrl = `${baseUrl}/deploy/${slug}/`;
  const isLive = activeVersionId !== null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
      {isLive ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-xs text-current underline-offset-4 hover:underline"
        >
          {deployUrl}
        </a>
      ) : (
        <span
          title={t('versions.deployHint')}
          className="min-w-0 flex-1 truncate font-mono text-xs text-current opacity-60"
        >
          {deployUrl}
        </span>
      )}
      <span className="editorial-meta inline-flex shrink-0 items-center gap-2">
        <span
          className={`size-2 ${isLive ? 'bg-current' : 'border border-current'}`}
        />
        {isLive ? t('versions.live') : t('versions.notLive')}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              className="border-current/40 bg-transparent text-current hover:bg-current/10 hover:text-current"
              onClick={() => {
                navigator.clipboard.writeText(deployUrl);
                toast(t('common.copied'));
              }}
            />
          }
        >
          <Copy className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t('common.copy')}</TooltipContent>
      </Tooltip>
      {isLive && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'icon-sm' }),
                  'border-current/40 bg-transparent text-current hover:bg-current/10 hover:text-current'
                )}
              />
            }
          >
            <ExternalLink className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t('versions.preview')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
