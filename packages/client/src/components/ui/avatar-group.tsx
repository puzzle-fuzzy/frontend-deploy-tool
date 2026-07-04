import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { getUserAvatarUrl, getUserInitials } from '@/shared/avatar';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

interface AvatarGroupUser {
  id: string;
  name: string;
}

interface Props {
  users: AvatarGroupUser[];
  max?: number;
  className?: string;
}

export function AvatarGroup({ users, max = 4, className }: Props) {
  const visible = useMemo(() => users.slice(0, max), [users, max]);
  const overflow = users.length - max;

  if (users.length === 0) return null;

  return (
    <TooltipProvider>
      <div className={cn('flex -space-x-2', className)}>
        {visible.map((user) => (
          <Tooltip key={user.id}>
            <TooltipTrigger
              render={<Avatar className="ring-2 ring-background" />}
            >
              <AvatarImage src={getUserAvatarUrl(user.id)} alt={user.name} />
              <AvatarFallback>{getUserInitials(user.name)}</AvatarFallback>
            </TooltipTrigger>
            <TooltipContent>{user.name}</TooltipContent>
          </Tooltip>
        ))}
        {overflow > 0 && (
          <Avatar className="ring-2 ring-background">
            <AvatarFallback>+{overflow}</AvatarFallback>
          </Avatar>
        )}
      </div>
    </TooltipProvider>
  );
}
