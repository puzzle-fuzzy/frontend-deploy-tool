import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { publicBaseURL } from '@/config';
import { useToast } from '@/lib/toast-context';

export function DeployUrl({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;

  return (
    <div className="flex-1 flex items-center justify-end gap-1.5 min-w-0">
      <a
        href={deployUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary hover:underline bg-muted px-2 py-1 rounded-md truncate shrink"
      >
        {deployUrl}
      </a>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => {
              navigator.clipboard.writeText(deployUrl);
              toast(t('common.copied'));
            }}
          >
            <Copy className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('common.copy')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon-xs" asChild>
            <a href={deployUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3" />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('versions.preview')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
