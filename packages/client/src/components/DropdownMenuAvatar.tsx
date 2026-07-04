'use client';

import {
  LanguagesIcon,
  LogOutIcon,
  MoonIcon,
  SunIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useThemePreference } from '@/shared/preferences';
import type { SafeUser } from '@/shared/types';

interface DropdownMenuAvatarProps {
  user: SafeUser;
  onLogout: () => void;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function DropdownMenuAvatar({
  user,
  onLogout,
}: DropdownMenuAvatarProps) {
  const { t, i18n } = useTranslation();
  const { dark, toggleTheme } = useThemePreference();
  const isZh = i18n.language.startsWith('zh');
  const toggleLanguage = () => {
    i18n.changeLanguage(isZh ? 'en' : 'zh');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" />}
      >
        <Avatar>
          <AvatarImage src="" alt={user.name} />
          <AvatarFallback>{initials(user.name) || 'DK'}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem className="items-start">
            <Avatar size="sm">
              <AvatarFallback>{initials(user.name) || 'DK'}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate font-medium">{user.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {user.email}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleLanguage}>
            <LanguagesIcon />
            {isZh
              ? t('preferences.switchToEnglish')
              : t('preferences.switchToChinese')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleTheme}>
            {dark ? <SunIcon /> : <MoonIcon />}
            {dark ? t('preferences.lightTheme') : t('preferences.darkTheme')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onLogout}>
          <LogOutIcon />
          {t('auth.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
