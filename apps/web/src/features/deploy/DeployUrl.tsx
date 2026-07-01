import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '@/config';
import { Button } from '@/shared/ui/button';
import { useToast } from '@/shared/ui/toast-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

interface Props {
  slug: string;
  /** null while no version has been published (upload ≠ go-live). */
  activeVersionId: string | null;
}

export function DeployUrl({ slug, activeVersionId }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;
  const isLive = activeVersionId !== null;

  return (
    <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
      {isLive ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline bg-muted px-2 py-1.5 rounded-md truncate shrink"
        >
          {deployUrl}
        </a>
      ) : (
        <span
          title={t('versions.deployHint')}
          className="text-sm text-muted-foreground bg-muted/50 px-2 py-1.5 rounded-md truncate shrink"
        >
          {deployUrl}
        </span>
      )}
      <span
        className={`inline-flex items-center gap-1 text-[11px] font-medium shrink-0 ${
          isLive
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400'
        }`}
      >
        <span
          className={`size-1.5 rounded-full ${isLive ? 'bg-emerald-500' : 'bg-amber-500'}`}
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
