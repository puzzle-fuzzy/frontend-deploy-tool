import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { dark, toggle } = useTheme();

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" onClick={toggle} />}
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </TooltipTrigger>
      <TooltipContent>{dark ? 'Light Mode' : 'Dark Mode'}</TooltipContent>
    </Tooltip>
  );
}
