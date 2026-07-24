import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { dark, toggle } = useTheme();
  const { t } = useTranslation();
  const label = dark ? t('preferences.lightTheme') : t('preferences.darkTheme');

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-11"
            aria-label={label}
            onClick={toggle}
          />
        }
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
