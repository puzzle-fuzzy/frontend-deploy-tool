import { useApiClient } from '@deploykit/client';
import { Crown, Trash2, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast-context';
import { UserDisplay } from '@/components/ui/user-display';
import { getLocalizedError } from '../../shared/error-messages';

interface MemberInfo {
  userId: string;
  role: 'owner' | 'member';
  user: { id: string; name: string; email: string };
}

interface Props {
  members: MemberInfo[];
  currentUserId: string;
  projectId: string;
  onMembersChanged: () => void;
}

export function MemberList({
  members,
  currentUserId,
  projectId,
  onMembersChanged,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
  const currentMember = members.find((m) => m.userId === currentUserId);
  const isOwner = currentMember?.role === 'owner';

  const handleRemove = async (userId: string) => {
    try {
      await api.removeMember(projectId, userId);
      toast(t('common.saved'));
      onMembersChanged();
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    }
  };

  if (members.length === 0) return null;

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div
          key={m.userId}
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5"
        >
          <div className="flex items-center gap-3 min-w-0">
            <UserDisplay user={m.user} showEmail avatarSize="md" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {m.role === 'owner' ? (
              <Badge
                variant="outline"
                className="gap-1 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800"
              >
                <Crown className="size-3" />
                Owner
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <User className="size-3" />
                Member
              </Badge>
            )}
            {isOwner && m.userId !== currentUserId && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => handleRemove(m.userId)}
                aria-label={t('members.remove')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
