import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '@/config';
import { Button } from '@/shared/ui/button';
import { useToast } from '@/shared/ui/toast-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

interface DeployUrlProps {
  slug: string;
  /** Whether the project has an active (production) version. */
  hasProduction: boolean;
}

export function DeployUrl({ slug, hasProduction }: DeployUrlProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;

  return (
    <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
      {hasProduction ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline bg-muted px-2 py-1.5 rounded-md truncate shrink"
        >
          {deployUrl}
        </a>
      ) : (
        <div className="flex flex-col items-end min-w-0">
          <span className="text-sm text-muted-foreground bg-muted px-2 py-1.5 rounded-md truncate shrink">
            {deployUrl}
          </span>
          <span className="text-xs text-muted-foreground/80 mt-0.5">
            {t('versions.deployHint')}
          </span>
        </div>
      )}
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
      {hasProduction && (
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
