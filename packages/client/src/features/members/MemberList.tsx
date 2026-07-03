import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@deploykit/client';
import { Button } from '../../shared/ui/button';
import { useToast } from '../../shared/ui/toast-context';
import { UserDisplay } from '../../shared/ui/user-display';

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

export function MemberList({ members, currentUserId, projectId, onMembersChanged }: Props) {
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
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    }
  };

  if (members.length === 0) return null;

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div key={m.userId} className="flex items-center justify-between py-1">
          <UserDisplay user={m.user} showEmail avatarSize="sm" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase font-medium">
              {m.role}
            </span>
            {isOwner && m.userId !== currentUserId && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => handleRemove(m.userId)}
                aria-label={t('members.remove')}
              >
                <Trash2 className="size-3" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
