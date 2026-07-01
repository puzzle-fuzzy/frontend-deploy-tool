import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '@/config';
import { Button } from '@/shared/ui/button';
import { useToast } from '@/shared/ui/toast-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

export function DeployUrl({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;

  return (
    <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
      <a
        href={deployUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-primary hover:underline bg-muted px-2 py-1.5 rounded-md truncate shrink"
      >
        {deployUrl}
      </a>
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
    </div>
  );
}
