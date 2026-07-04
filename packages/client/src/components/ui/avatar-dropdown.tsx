import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getUserAvatarUrl, getUserInitials } from '@/shared/avatar';
import type { SafeUser } from '@/shared/types';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';

interface Props {
  user: SafeUser;
  onLogout: () => Promise<void> | void;
}

export function AvatarDropdown({ user, onLogout }: Props) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" />}
      >
        <Avatar>
          <AvatarImage src={getUserAvatarUrl(user.id)} alt={user.name} />
          <AvatarFallback>{getUserInitials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-1.5 py-1.5">
          <p className="text-sm font-medium">{user.name}</p>
          <p className="text-xs text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onLogout()}>
          <LogOut />
          {t('auth.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
