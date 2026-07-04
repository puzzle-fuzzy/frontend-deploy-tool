import {
  Code2,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  UserPlus,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AddMemberDialog } from '@/features/members/AddMemberDialog';
import { MemberList } from '@/features/members/MemberList';
import { CreateProjectDialog } from '@/features/projects/CreateProjectDialog';
import { useProjects } from '@/features/projects/useProjects';
import { ProjectSettingsForm } from '@/features/settings/ProjectSettingsForm';
import { UploadVersionDialog } from '@/features/versions/UploadVersionDialog';
import { VersionList } from '@/features/versions/VersionList';
import { formatDate } from '@/shared/format';
import type { Project, SafeUser } from '@/shared/types';

type DetailTab = 'versions' | 'members' | 'settings';

function getProjectHashTab(projectId: string): DetailTab {
  const expectedPrefix = `#/projects/${projectId}/`;
  if (!window.location.hash.startsWith(expectedPrefix)) return 'versions';
  const value = window.location.hash.slice(expectedPrefix.length);
  if (value === 'members' || value === 'settings') return value;
  return 'versions';
}

function setProjectHashTab(projectId: string, tab: DetailTab) {
  window.location.hash =
    tab === 'versions'
      ? `#/projects/${projectId}`
      : `#/projects/${projectId}/${tab}`;
}

interface ProjectWorkspaceProps {
  user: SafeUser;
  onLogout: () => void;
}

export function ProjectWorkspace({ user, onLogout }: ProjectWorkspaceProps) {
  const {
    projects,
    loading,
    error,
    selectedProject,
    pendingVersionId,
    selectProject,
    refresh,
    publishVersion,
    rollbackVersion,
    deleteVersion,
    onProjectDeleted,
  } = useProjects();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <AppLayout
      projects={projects}
      selectedProjectId={selectedProject?.id ?? null}
      user={user}
      onSelectProject={selectProject}
      onShowProjects={() => selectProject(null)}
      onCreateProject={() => setShowCreate(true)}
      onLogout={onLogout}
    >
      {selectedProject ? (
        <ProjectDetail
          project={selectedProject}
          user={user}
          pendingVersionId={pendingVersionId}
          onUploaded={refresh}
          onPublish={publishVersion}
          onRollback={rollbackVersion}
          onDeleteVersion={deleteVersion}
          onProjectDeleted={onProjectDeleted}
        />
      ) : (
        <ProjectList
          projects={projects}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onCreate={() => setShowCreate(true)}
          onSelect={selectProject}
        />
      )}
      <CreateProjectDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={(project) => {
          refresh();
          selectProject(project);
        }}
      />
    </AppLayout>
  );
}

function ProjectList({
  projects,
  loading,
  error,
  onRefresh,
  onCreate,
  onSelect,
}: {
  projects: Project[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCreate: () => void;
  onSelect: (project: Project) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4 py-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('app.projectSubtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCw />
            {t('common.refresh')}
          </Button>
          <Button onClick={onCreate}>
            <Plus />
            {t('app.newProject')}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <FolderOpen className="size-8 text-muted-foreground" />
            <div>
              <h2 className="font-medium">{t('projects.empty')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('projects.emptyDesc')}
              </p>
            </div>
            <Button onClick={onCreate}>
              <Plus />
              {t('app.newProject')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelect(project)}
              className="text-left"
            >
              <Card className="transition-colors hover:bg-muted/60">
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>/{project.slug}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('projects.versions', {
                      count: project.versions.length,
                    })}
                  </span>
                  <span>
                    {project.activeVersionId
                      ? t('projects.production')
                      : t('projects.notLive')}
                  </span>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectDetail({
  project,
  user,
  pendingVersionId,
  onUploaded,
  onPublish,
  onRollback,
  onDeleteVersion,
  onProjectDeleted,
}: {
  project: Project;
  user: SafeUser;
  pendingVersionId: string | null;
  onUploaded: () => void;
  onPublish: (versionId: string) => Promise<void>;
  onRollback: (versionId: string) => Promise<void>;
  onDeleteVersion: (versionId: string) => Promise<void>;
  onProjectDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [showUpload, setShowUpload] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>(() =>
    getProjectHashTab(project.id)
  );
  const currentMember = project.members.find(
    (member) => member.userId === user.id
  );
  const currentUserIsOwner = currentMember?.role === 'owner';
  const canManage = user.role !== 'viewer' || Boolean(currentMember);
  const readOnly = !canManage;

  useEffect(() => {
    const syncTabFromHash = () => {
      setActiveTab(getProjectHashTab(project.id));
    };
    syncTabFromHash();
    window.addEventListener('hashchange', syncTabFromHash);
    return () => window.removeEventListener('hashchange', syncTabFromHash);
  }, [project.id]);

  const handleTabChange = (value: string) => {
    const next =
      value === 'members' || value === 'settings' ? value : 'versions';
    setActiveTab(next);
    setProjectHashTab(project.id, next);
  };

  return (
    <section className="flex flex-col gap-4 py-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-sm text-muted-foreground">
            {t('projects.updated', { date: formatDate(project.updatedAt) })}
          </p>
        </div>
        {!readOnly && (
          <Button onClick={() => setShowUpload(true)}>
            <Plus />
            {t('versions.upload')}
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList variant="line">
          <TabsTrigger value="versions">
            <Code2 />
            {t('versions.title')}
          </TabsTrigger>
          <TabsTrigger value="members">
            <Users />
            {t('members.title')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings />
            {t('settings.title')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="versions" className="pt-3">
          <VersionList
            project={project}
            pendingVersionId={pendingVersionId}
            readOnly={readOnly}
            onPublish={onPublish}
            onRollback={onRollback}
            onDelete={onDeleteVersion}
          />
        </TabsContent>
        <TabsContent value="members" className="pt-3">
          <Card>
            <CardHeader>
              <CardTitle>{t('members.title')}</CardTitle>
              <CardDescription>{t('members.desc')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {currentUserIsOwner && (
                <div>
                  <Button onClick={() => setShowAddMember(true)}>
                    <UserPlus />
                    {t('members.add')}
                  </Button>
                </div>
              )}
              <MemberList
                project={project}
                currentUserId={user.id}
                onChanged={onUploaded}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings" className="pt-3">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.title')}</CardTitle>
              <CardDescription>{t('settings.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProjectSettingsForm
                project={project}
                canManage={canManage}
                onSaved={onUploaded}
                onDeleted={onProjectDeleted}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <UploadVersionDialog
        projectId={project.id}
        open={showUpload}
        onOpenChange={setShowUpload}
        onUploaded={onUploaded}
      />
      <AddMemberDialog
        projectId={project.id}
        open={showAddMember}
        onOpenChange={setShowAddMember}
        onChanged={onUploaded}
      />
    </section>
  );
}
