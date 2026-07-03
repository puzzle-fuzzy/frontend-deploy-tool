import { getUserAvatarUrl, getUserInitials } from '../avatar';
import { cn } from '../utils';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';

interface Props {
  user: { id: string; name: string; email?: string };
  showEmail?: boolean;
  avatarSize?: 'sm' | 'md';
  className?: string;
}

const sizeMap = { sm: 'size-6', md: 'size-8' } as const;

export function UserDisplay({
  user,
  showEmail,
  avatarSize = 'sm',
  className,
}: Props) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Avatar className={sizeMap[avatarSize]}>
        <AvatarImage src={getUserAvatarUrl(user.id)} alt={user.name} />
        <AvatarFallback>{getUserInitials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium truncate max-w-32">
          {user.name}
        </span>
        {showEmail && (
          <span className="text-xs text-muted-foreground truncate max-w-32">
            {user.email}
          </span>
        )}
      </div>
    </div>
  );
}
