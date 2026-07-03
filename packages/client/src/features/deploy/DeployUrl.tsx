import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '../../shared/config';
import { Button } from '../../shared/ui/button';
import { useToast } from '../../shared/ui/toast-context';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../shared/ui/tooltip';

interface Props {
  slug: string;
  /** null while no version has been published. */
  activeVersionId: string | null;
}

export function DeployUrl({ slug, activeVersionId }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;
  const isLive = activeVersionId !== null;

  return (
    <div className="flex min-w-0 items-center justify-end gap-2 rounded-lg">
      {isLive ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
        >
          {deployUrl}
        </a>
      ) : (
        <span
          title={t('versions.deployHint')}
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
        >
          {deployUrl}
        </span>
      )}
      <span
        className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${
          isLive ? 'text-primary' : 'text-muted-foreground'
        }`}
      >
        <span
          className={`size-1.5 rounded-full ${
            isLive ? 'bg-primary' : 'bg-muted-foreground'
          }`}
        />
        {isLive ? t('versions.live') : t('versions.notLive')}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => {
              navigator.clipboard.writeText(deployUrl);
              toast(t('common.copied'));
            }}
          >
            <Copy className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('common.copy')}</TooltipContent>
      </Tooltip>
      {isLive && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" asChild>
              <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('versions.preview')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
