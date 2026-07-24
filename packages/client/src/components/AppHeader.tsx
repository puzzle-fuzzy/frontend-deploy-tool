import { DropdownMenuAvatar } from '@/components/DropdownMenuAvatar';
import type { SafeUser } from '@/shared/types';

interface AppHeaderProps {
  user: SafeUser;
  onLogout: () => void;
}

export function AppHeader({ user, onLogout }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 grid min-h-20 grid-cols-[1fr_auto] items-center border-b bg-background/95 px-5 backdrop-blur-md md:grid-cols-[17rem_1fr_auto] md:px-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <div className="flex h-full items-center md:border-r md:px-6">
        <div>
          <div className="editorial-meta text-primary">DeployKit / 01</div>
          <div className="mt-1 text-sm font-semibold tracking-[-0.02em]">
            Artifact delivery
          </div>
        </div>
      </div>
      <div className="hidden items-center justify-between px-6 md:flex">
        <span className="editorial-meta text-muted-foreground">
          Self hosted · Bun runtime
        </span>
        <span className="editorial-meta text-muted-foreground">
          Build / preview / publish
        </span>
      </div>
      <div className="flex items-center gap-3 pr-0 md:pr-5">
        <div className="hidden text-right lg:block">
          <div className="text-xs font-medium">{user.name}</div>
          <div className="editorial-meta mt-0.5 text-muted-foreground">
            {user.role}
          </div>
        </div>
        <DropdownMenuAvatar user={user} onLogout={onLogout} />
      </div>
    </header>
  );
}
