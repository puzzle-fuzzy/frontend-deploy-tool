import { FolderOpen, LogOut, Plus, Settings, UserPlus } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AvatarGroup } from '../shared/ui/avatar-group';
import { UserDisplay } from '../shared/ui/user-display';
import { DeployUrl } from '../features/deploy/DeployUrl';
import { LanguageToggle } from '../features/i18n/LanguageToggle';
import { AddMemberDialog } from '../features/members/AddMemberDialog';
import { MemberList } from '../features/members/MemberList';
import { TransferOwnershipDialog } from '../features/members/TransferOwnershipDialog';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { ProjectList } from '../features/projects/ProjectList';
import { useApiClient } from '@deploykit/client';
import { useProjects } from '../features/projects/useProjects';
import { ProjectSettingsDialog } from '../features/settings/ProjectSettingsDialog';
import { ThemeToggle } from '../features/theme/ThemeToggle';
import { UploadVersionDialog } from '../features/versions/UploadVersionDialog';
import { VersionList } from '../features/versions/VersionList';
import type { SafeUser } from '../shared/types';
import { Badge } from '../shared/ui/badge';
import { Button } from '../shared/ui/button';
import { Separator } from '../shared/ui/separator';
import { useToast } from '../shared/ui/toast-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '../shared/ui/tooltip';

interface Props {
  user: SafeUser;
  onLogout: () => Promise<void> | void;
}

export function DeployPage({ user, onLogout }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    projects,
    loading,
    selectedProject,
    pendingVersionId,
    selectProject,
    refresh,
    publishVersion,
    rollbackVersion,
    deleteVersion,
    onProjectDeleted,
  } = useProjects();
  const api = useApiClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const canCreateProject = true;
  const members = selectedProject?.members ?? [];

  const canManage = useMemo(() => {
    if (user.role !== 'viewer') return true;
    if (!selectedProject) return false;
    return members.some((m) => m.userId === user.id);
  }, [user.role, selectedProject, members, user.id]);

  const currentUserIsOwner = useMemo(() => {
    if (!selectedProject) return false;
    return members.some(
      (m) => m.userId === user.id && m.role === 'owner',
    );
  }, [members, selectedProject, user.id]);

  // Build member info list with resolved user data.
  const memberInfos = useMemo(() => {
    if (!selectedProject) return [];
    return members.map((m) => {
      const n = m.userId === user.id ? user.name : m.userId;
      return {
        userId: m.userId,
        role: m.role,
        user: { id: m.userId, name: n, email: '' },
      };
    });
  }, [members, selectedProject, user]);

  const handleLogout = async () => {
    try {
      await onLogout();
    } catch {
      toast(t('common.failed'), 'error');
    }
  };

  return (
    <div className="flex items-center justify-center min-h-dvh p-4 lg:p-6">
      <div className="w-full max-w-7xl min-h-[70dvh] bg-card rounded-2xl border border-border shadow-sm flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-6 text-primary" />
            <h1 className="text-lg font-semibold">{t('app.title')}</h1>
          </div>
          <div className="flex items-center gap-3">
            <UserDisplay user={user} avatarSize="md" />
            <Badge variant="secondary" className="text-[10px] uppercase">
              {t(`auth.roles.${user.role}`)}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleLogout}
                  aria-label={t('auth.logout')}
                >
                  <LogOut className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('auth.logout')}</TooltipContent>
            </Tooltip>
            <Separator orientation="vertical" className="h-5 mx-1" />
            <ThemeToggle />
            <LanguageToggle />
          </div>
        </div>

        {/* Two-column body */}
        <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
          <ProjectList
            projects={projects}
            loading={loading}
            selectedProjectId={selectedProject?.id}
            onSelect={selectProject}
            canCreate={canCreateProject}
            onCreate={() => setShowCreate(true)}
          />

          {/* Right: Version panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedProject ? (
              <>
                <div className="px-5 py-3 border-b border-border space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="shrink-0">
                      <h2 className="text-lg font-semibold">
                        {selectedProject.name}
                      </h2>
                      <p className="text-sm text-muted-foreground font-mono">
                        {selectedProject.slug}
                      </p>
                    </div>
                    {memberInfos.length > 0 && (
                      <AvatarGroup users={memberInfos.map((m) => m.user)} max={4} />
                    )}
                    <DeployUrl
                      slug={selectedProject.slug}
                      activeVersionId={selectedProject.activeVersionId}
                    />
                    {canManage && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            onClick={() => setShowSettings(true)}
                          >
                            <Settings className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.title')}</TooltipContent>
                      </Tooltip>
                    )}
                    {canManage && (
                      <Button
                        size="default"
                        onClick={() => setShowUpload(true)}
                      >
                        <Plus className="size-4" />
                        {t('versions.upload')}
                      </Button>
                    )}
                  </div>
                  {/* Member section */}
                  {(memberInfos.length > 0 || currentUserIsOwner) && (
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      <MemberList
                        members={memberInfos}
                        currentUserId={user.id}
                        projectId={selectedProject.id}
                        onMembersChanged={refresh}
                      />
                      {currentUserIsOwner && (
                        <div className="flex items-center gap-2 shrink-0 ml-4">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                onClick={() => setShowAddMember(true)}
                              >
                                <UserPlus className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('members.addTitle')}</TooltipContent>
                          </Tooltip>
                          {memberInfos.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setShowTransfer(true)}
                              className="text-xs"
                            >
                              {t('members.transfer')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <VersionList
                  project={selectedProject}
                  pendingVersionId={pendingVersionId}
                  readOnly={!canManage}
                  onPublish={publishVersion}
                  onRollback={rollbackVersion}
                  onDelete={deleteVersion}
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center">
                <FolderOpen className="size-12 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('projects.empty')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {canCreateProject && (
        <CreateProjectDialog
          open={showCreate}
          onOpenChange={setShowCreate}
          onCreated={refresh}
        />
      )}
      {canManage && (
        <UploadVersionDialog
          open={showUpload}
          onOpenChange={setShowUpload}
          projectId={selectedProject?.id ?? ''}
          onUploaded={refresh}
        />
      )}
      {canManage && (
        <ProjectSettingsDialog
          key={selectedProject?.id ?? 'no-project'}
          open={showSettings}
          onOpenChange={setShowSettings}
          project={selectedProject}
          onDeleted={onProjectDeleted}
          onSaved={refresh}
          canDeleteProject={canCreateProject}
        />
      )}
      {currentUserIsOwner && selectedProject && (
        <AddMemberDialog
          open={showAddMember}
          projectId={selectedProject.id}
          onAdded={refresh}
          onClose={() => setShowAddMember(false)}
        />
      )}
      {currentUserIsOwner && selectedProject && (
        <TransferOwnershipDialog
          open={showTransfer}
          members={memberInfos
            .filter((m) => m.userId !== user.id)
            .map((m) => ({ userId: m.userId, name: m.user.name }))}
          onTransfer={async (targetUserId) => {
            await api.transferOwnership(selectedProject.id, targetUserId);
            void refresh();
          }}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  );
}
