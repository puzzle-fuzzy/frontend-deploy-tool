import { ArrowRightLeft, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '@/shared/error-messages';
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
  const { toast } = useToast();
  const api = useApiClient();
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const currentMember = project.members.find(
    (member) => member.userId === currentUserId
  );
  const isOwner = currentMember?.role === 'owner';

  const runMemberAction = async (
    userId: string,
    action: () => Promise<unknown>
  ) => {
    setPendingUserId(userId);
    try {
      await action();
      toast(t('common.saved'));
      onChanged();
    } catch (err) {
      toast(getLocalizedError(err, t, t('members.actionFailed')), 'error');
    } finally {
      setPendingUserId(null);
    }
  };

  if (project.members.length === 0) {
    return (
      <div className="grid min-h-48 border border-dashed sm:grid-cols-[8rem_1fr]">
        <div className="border-b p-5 sm:border-b-0 sm:border-r">
          <span className="editorial-number text-5xl text-primary">00</span>
        </div>
        <div className="flex items-end p-6 text-sm text-muted-foreground">
          {t('members.none')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-px bg-border">
        {project.members.map((member, index) => (
          <MemberRow
            key={member.userId}
            member={member}
            index={index}
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
    </div>
  );
}

function MemberRow({
  member,
  index,
  currentUserId,
  isOwner,
  pending,
  onRemove,
  onTransfer,
}: {
  member: ProjectMember;
  index: number;
  currentUserId: string;
  isOwner: boolean;
  pending: boolean;
  onRemove: () => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const isCurrentUser = member.userId === currentUserId;

  return (
    <div className="grid min-w-0 bg-card sm:grid-cols-[7rem_1fr_auto]">
      <div className="flex items-center border-b p-4 sm:border-b-0 sm:border-r">
        <span className="editorial-number text-4xl text-primary">
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <div className="min-w-0 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="truncate text-sm font-semibold">
            {isCurrentUser ? t('members.you') : member.userId}
          </div>
          <span className="editorial-meta border border-foreground/20 px-2 py-1 text-muted-foreground">
            {member.role === 'owner' ? t('members.owner') : t('members.member')}
          </span>
        </div>
        <div className="editorial-meta mt-2 text-muted-foreground">
          {t('members.invited', {
            date: new Date(member.invitedAt).toLocaleDateString(),
          })}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t p-4 sm:border-l sm:border-t-0">
        {isOwner && !isCurrentUser && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onTransfer}
            >
              <ArrowRightLeft />
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
