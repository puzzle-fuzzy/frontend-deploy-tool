import { ArrowLeft, FolderOpen, LogOut, Plus, Settings, Users, UserPlus } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@deploykit/client';
import { AvatarGroup } from '../shared/ui/avatar-group';
import { UserDisplay } from '../shared/ui/user-display';
import { DeployUrl } from '../features/deploy/DeployUrl';
import { LanguageToggle } from '../features/i18n/LanguageToggle';
import { AddMemberDialog } from '../features/members/AddMemberDialog';
import { MemberList } from '../features/members/MemberList';
import { TransferOwnershipDialog } from '../features/members/TransferOwnershipDialog';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { ProjectList } from '../features/projects/ProjectList';
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

type DetailTab = 'versions' | 'members' | 'settings';

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
  const [showUpload, setShowUpload] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('versions');

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

  const handleBack = () => {
    selectProject(null);
    setActiveTab('versions');
  };

  // ── Fixed Header ──────────────────────────────────────────────
  const header = (
    <header className="border-b border-border bg-card px-5 py-3 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
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
            <Button variant="ghost" size="icon-sm" onClick={handleLogout} aria-label={t('auth.logout')}>
              <LogOut className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('auth.logout')}</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-5 mx-1" />
        <ThemeToggle />
        <LanguageToggle />
      </div>
    </header>
  );

  // ── Project List Page ─────────────────────────────────────────
  const projectListPage = (
    <div className="flex-1 flex flex-col p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">{t('app.projects')}</h2>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="size-4" />
          {t('app.newProject')}
        </Button>
      </div>
      <ProjectList
        projects={projects}
        loading={loading}
        selectedProjectId={selectedProject?.id}
        onSelect={selectProject}
        canCreate={false}
        onCreate={() => {}}
      />
    </div>
  );

  // ── Project Detail Page ───────────────────────────────────────
  const tabs: { key: DetailTab; label: string; icon: typeof FolderOpen }[] = [
    { key: 'versions', label: t('versions.title'), icon: FolderOpen },
    { key: 'members', label: t('members.addTitle'), icon: Users },
    { key: 'settings', label: t('settings.title'), icon: Settings },
  ];

  const detailPage = selectedProject && (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Back link + project header */}
      <div className="px-6 pt-4 pb-0 space-y-3">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to projects
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-bold truncate">{selectedProject.name}</h2>
            <p className="text-sm text-muted-foreground font-mono">{selectedProject.slug}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {memberInfos.length > 0 && (
              <AvatarGroup users={memberInfos.map((m) => m.user)} max={4} />
            )}
            <DeployUrl
              slug={selectedProject.slug}
              activeVersionId={selectedProject.activeVersionId}
            />
            {canManage && (
              <Button size="default" onClick={() => setShowUpload(true)}>
                <Plus className="size-4" />
                {t('versions.upload')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-border mt-4 px-6">
        <nav className="flex gap-6 -mb-px">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <tab.icon className="size-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto p-6">
        {activeTab === 'versions' && (
          <VersionList
            project={selectedProject}
            pendingVersionId={pendingVersionId}
            readOnly={!canManage}
            onPublish={publishVersion}
            onRollback={rollbackVersion}
            onDelete={deleteVersion}
          />
        )}

        {activeTab === 'members' && (
          <div className="max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                <Users className="size-4 inline mr-2" />
                {t('members.addTitle')}
              </h3>
              {currentUserIsOwner && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowAddMember(true)}>
                    <UserPlus className="size-4" />
                    {t('members.add')}
                  </Button>
                  {memberInfos.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => setShowTransfer(true)}>
                      {t('members.transfer')}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <MemberList
              members={memberInfos}
              currentUserId={user.id}
              projectId={selectedProject.id}
              onMembersChanged={refresh}
            />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-lg">
            <ProjectSettingsDialog
              key={selectedProject.id}
              open={true}
              onOpenChange={(open) => { if (!open) setActiveTab('versions'); }}
              project={selectedProject}
              onDeleted={onProjectDeleted}
              onSaved={refresh}
              canDeleteProject={canManage}
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-dvh flex flex-col bg-background">
      {header}

      <main className="flex-1 flex flex-col min-h-0">
        {selectedProject ? detailPage : projectListPage}
      </main>

      {/* Dialogs */}
      <CreateProjectDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={refresh}
      />
      {canManage && selectedProject && (
        <UploadVersionDialog
          open={showUpload}
          onOpenChange={setShowUpload}
          projectId={selectedProject.id}
          onUploaded={refresh}
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
