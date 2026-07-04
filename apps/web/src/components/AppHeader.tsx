import { DropdownMenuAvatar } from '@/components/DropdownMenuAvatar';
import type { SafeUser } from '@/shared/types';

interface AppHeaderProps {
  user: SafeUser;
  onLogout: () => void;
}

export function AppHeader({ user, onLogout }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-end bg-background/95 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex items-center">
        <DropdownMenuAvatar user={user} onLogout={onLogout} />
      </div>
    </header>
  );
}
