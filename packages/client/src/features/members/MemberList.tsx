import { Crown, ShieldCheck, Trash2, UserIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { Project, ProjectMember } from '@/shared/types';

interface MemberListProps {
  project: Project;
  currentUserId: string;
  onChanged: () => void;
}

export function MemberList({
  project,
  currentUserId,
  onChanged,
}: MemberListProps) {
  const { t } = useTranslation();
  const api = useApiClient();
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentMember = project.members.find(
    (member) => member.userId === currentUserId
  );
  const isOwner = currentMember?.role === 'owner';

  const runMemberAction = async (
    userId: string,
    action: () => Promise<unknown>
  ) => {
    setPendingUserId(userId);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('members.actionFailed'));
    } finally {
      setPendingUserId(null);
    }
  };

  if (project.members.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {t('members.none')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {project.members.map((member) => (
        <MemberRow
          key={member.userId}
          member={member}
          currentUserId={currentUserId}
          isOwner={isOwner}
          pending={pendingUserId === member.userId}
          onRemove={() =>
            runMemberAction(member.userId, () =>
              api.removeMember(project.id, member.userId)
            )
          }
          onTransfer={() =>
            runMemberAction(member.userId, () =>
              api.transferOwnership(project.id, member.userId)
            )
          }
        />
      ))}
    </div>
  );
}

function MemberRow({
  member,
  currentUserId,
  isOwner,
  pending,
  onRemove,
  onTransfer,
}: {
  member: ProjectMember;
  currentUserId: string;
  isOwner: boolean;
  pending: boolean;
  onRemove: () => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const isCurrentUser = member.userId === currentUserId;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar size="sm">
          <AvatarFallback>
            {member.userId.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {isCurrentUser ? t('members.you') : member.userId}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('members.invited', {
              date: new Date(member.invitedAt).toLocaleDateString(),
            })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
          {member.role === 'owner' ? (
            <Crown className="size-3" />
          ) : (
            <UserIcon className="size-3" />
          )}
          {member.role === 'owner' ? t('members.owner') : t('members.member')}
        </span>
        {isOwner && !isCurrentUser && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onTransfer}
            >
              <ShieldCheck />
              {t('members.transfer')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              onClick={onRemove}
            >
              <Trash2 />
              <span className="sr-only">{t('members.remove')}</span>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
