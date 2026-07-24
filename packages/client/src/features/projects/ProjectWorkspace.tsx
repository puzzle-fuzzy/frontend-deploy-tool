import {
  ArrowRight,
  Code2,
  History as HistoryIcon,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast-context';
import { DeployUrl } from '@/features/deploy/DeployUrl';
import { ProjectHistoryTimeline } from '@/features/history/ProjectHistoryTimeline';
import { AddMemberDialog } from '@/features/members/AddMemberDialog';
import { MemberList } from '@/features/members/MemberList';
import { CreateProjectDialog } from '@/features/projects/CreateProjectDialog';
import { useProjects } from '@/features/projects/useProjects';
import { ProjectSettingsForm } from '@/features/settings/ProjectSettingsForm';
import { UploadVersionDialog } from '@/features/versions/UploadVersionDialog';
import { VersionList } from '@/features/versions/VersionList';
import { formatDate } from '@/shared/format';
import type { Project, SafeUser } from '@/shared/types';

type DetailTab = 'versions' | 'history' | 'members' | 'settings';

function getProjectHashTab(projectId: string): DetailTab {
  const expectedPrefix = `#/projects/${projectId}/`;
  if (!window.location.hash.startsWith(expectedPrefix)) return 'versions';
  const value = window.location.hash.slice(expectedPrefix.length);
  if (value === 'history' || value === 'members' || value === 'settings') {
    return value;
  }
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
  const { toast } = useToast();
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

  useEffect(() => {
    if (error) toast(error, 'error');
  }, [error, toast]);

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
  onRefresh,
  onCreate,
  onSelect,
}: {
  projects: Project[];
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onSelect: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const liveProjects = projects.filter((project) =>
    Boolean(project.activeVersionId)
  ).length;
  const previewVersions = projects.reduce(
    (count, project) =>
      count +
      project.versions.filter(
        (version) => version.id !== project.activeVersionId
      ).length,
    0
  );

  return (
    <section className="editorial-enter">
      <div className="grid border-b lg:grid-cols-[1.25fr_0.75fr]">
        <div className="px-5 py-12 sm:px-8 sm:py-16 lg:border-r lg:px-12 lg:py-20">
          <p className="editorial-eyebrow">{t('projects.eyebrow')}</p>
          <h1 className="editorial-display mt-8">{t('projects.heroTitle')}</h1>
        </div>
        <div className="flex flex-col justify-end border-t px-5 py-8 sm:px-8 lg:border-t-0 lg:px-10 lg:py-12">
          <p className="max-w-md text-lg leading-relaxed text-foreground/75">
            {t('projects.heroDescription')}
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            <Button onClick={onCreate} className="h-12 px-5">
              <Plus />
              {t('app.newProject')}
            </Button>
            <Button variant="outline" onClick={onRefresh} className="h-12 px-5">
              <RefreshCw />
              {t('common.refresh')}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 border-b">
        <Metric
          index="01"
          value={projects.length}
          label={t('projects.totalLabel')}
        />
        <Metric
          index="02"
          value={liveProjects}
          label={t('projects.liveLabel')}
          accent
        />
        <Metric
          index="03"
          value={previewVersions}
          label={t('projects.previewLabel')}
        />
      </div>

      <div className="px-5 py-10 sm:px-8 lg:px-12 lg:py-14">
        <div className="mb-5 flex items-end justify-between border-b pb-4">
          <div>
            <p className="editorial-eyebrow">Project library</p>
            <h2 className="mt-2 text-2xl font-medium tracking-[-0.04em]">
              {t('projects.title')}
            </h2>
          </div>
          <span className="editorial-meta text-muted-foreground">
            {String(projects.length).padStart(2, '0')} items
          </span>
        </div>

        {loading ? (
          <ProjectSkeleton />
        ) : projects.length === 0 ? (
          <button
            type="button"
            onClick={onCreate}
            className="grid w-full bg-primary text-left text-primary-foreground sm:grid-cols-[12rem_1fr]"
          >
            <div className="border-b border-primary-foreground/25 p-6 sm:border-b-0 sm:border-r">
              <div className="editorial-number">01</div>
              <div className="editorial-meta mt-16 text-primary-foreground/70">
                Start here
              </div>
            </div>
            <div className="flex min-h-64 flex-col justify-between p-6 sm:p-10">
              <div>
                <h3 className="text-3xl font-normal tracking-[-0.05em]">
                  {t('projects.empty')}
                </h3>
                <p className="mt-3 max-w-md text-primary-foreground/75">
                  {t('projects.emptyDesc')}
                </p>
              </div>
              <span className="mt-12 flex items-center justify-between border-t border-primary-foreground/25 pt-4">
                <span className="editorial-meta">Create first project</span>
                <ArrowRight className="size-5" />
              </span>
            </div>
          </button>
        ) : (
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {projects.map((project, index) => (
              <ProjectTile
                key={project.id}
                project={project}
                index={index}
                onSelect={() => onSelect(project)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mx-5 flex items-center justify-between border-t py-5 sm:mx-8 lg:mx-12">
        <span className="editorial-meta text-muted-foreground">
          Upload · preview · publish · rollback
        </span>
        <span className="editorial-meta text-muted-foreground">01 / 07</span>
      </div>
    </section>
  );
}

function Metric({
  index,
  value,
  label,
  accent = false,
}: {
  index: string;
  value: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`min-w-0 border-r px-4 py-5 last:border-r-0 sm:px-7 sm:py-7 ${
        accent ? 'bg-primary text-primary-foreground' : ''
      }`}
    >
      <span
        className={`editorial-meta ${
          accent ? 'text-primary-foreground/65' : 'text-primary'
        }`}
      >
        {index}
      </span>
      <div className="editorial-number mt-5 text-[clamp(2.4rem,6vw,5.5rem)]">
        {String(value).padStart(2, '0')}
      </div>
      <p
        className={`mt-3 text-xs sm:text-sm ${
          accent ? 'text-primary-foreground/75' : 'text-muted-foreground'
        }`}
      >
        {label}
      </p>
    </div>
  );
}

function ProjectTile({
  project,
  index,
  onSelect,
}: {
  project: Project;
  index: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const isLive = Boolean(project.activeVersionId);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex min-h-72 flex-col justify-between bg-card p-6 text-left hover:bg-background sm:p-8"
    >
      <div className="flex items-start justify-between">
        <span className="editorial-number text-[clamp(3rem,6vw,5.5rem)] text-primary">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span
          className={`editorial-meta border px-2 py-1 ${
            isLive
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-foreground/25 text-muted-foreground'
          }`}
        >
          {isLive ? t('projects.production') : t('projects.notLive')}
        </span>
      </div>
      <div className="mt-12">
        <h3 className="text-2xl font-medium tracking-[-0.045em] sm:text-3xl">
          {project.name}
        </h3>
        <p className="editorial-meta mt-2 text-muted-foreground">
          /{project.slug}
        </p>
        <div className="mt-6 flex items-end justify-between gap-4 border-t pt-4">
          <span className="text-xs text-muted-foreground">
            {t('projects.versions', { count: project.versions.length })}
          </span>
          <ArrowRight className="size-5 transition-transform group-hover:translate-x-1" />
        </div>
      </div>
    </button>
  );
}

function ProjectSkeleton() {
  return (
    <div
      className="grid gap-px bg-border sm:grid-cols-2"
      role="status"
      aria-label="Loading"
    >
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="min-h-72 animate-pulse bg-card p-8 motion-reduce:animate-none"
        >
          <div className="h-16 w-20 bg-muted-foreground/15" />
          <div className="mt-24 h-7 w-2/3 bg-muted-foreground/15" />
          <div className="mt-4 h-px w-full bg-border" />
        </div>
      ))}
    </div>
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
      value === 'history' || value === 'members' || value === 'settings'
        ? value
        : 'versions';
    setActiveTab(next);
    setProjectHashTab(project.id, next);
  };

  return (
    <section className="editorial-enter">
      <div className="grid border-b xl:grid-cols-[1fr_20rem]">
        <div className="px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
          <p className="editorial-eyebrow">Project / {project.slug}</p>
          <h1 className="mt-8 max-w-[13ch] text-[clamp(3.25rem,8vw,7rem)] font-light leading-[0.9] tracking-[-0.075em]">
            {project.name}
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-foreground/75">
            {project.description || t('app.projectSubtitle')}
          </p>
        </div>
        <div className="flex flex-col justify-between border-t bg-card p-6 xl:border-l xl:border-t-0 xl:p-8">
          <div>
            <span className="editorial-meta text-primary">Release status</span>
            <div className="mt-8">
              <span
                className={`inline-block size-3 ${
                  project.activeVersionId ? 'bg-primary' : 'border'
                }`}
              />
              <p className="mt-3 text-xl font-medium">
                {project.activeVersionId
                  ? t('projects.production')
                  : t('projects.notLive')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('projects.updated', { date: formatDate(project.updatedAt) })}
              </p>
            </div>
          </div>
          {!readOnly && (
            <Button
              onClick={() => setShowUpload(true)}
              className="mt-10 h-12 justify-between px-4"
            >
              {t('versions.upload')}
              <Plus />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 border-b">
        <Metric
          index="01"
          value={project.versions.length}
          label={t('versions.title')}
        />
        <Metric
          index="02"
          value={project.members.length}
          label={t('members.title')}
        />
        <Metric
          index="03"
          value={project.settings.spaMode ? 1 : 0}
          label="SPA fallback"
          accent={Boolean(project.activeVersionId)}
        />
      </div>

      <div className="border-b bg-primary px-5 py-5 text-primary-foreground sm:px-8 lg:px-12">
        <div className="grid items-center gap-4 lg:grid-cols-[12rem_1fr]">
          <span className="editorial-meta text-primary-foreground/70">
            Production URL
          </span>
          <DeployUrl
            slug={project.slug}
            activeVersionId={project.activeVersionId}
          />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-0">
        <TabsList
          variant="line"
          className="grid h-auto w-full grid-cols-4 gap-0 border-b p-0"
        >
          <EditorialTab
            value="versions"
            index="01"
            label={t('versions.title')}
            icon={<Code2 />}
          />
          <EditorialTab
            value="history"
            index="02"
            label={t('history.title')}
            icon={<HistoryIcon />}
          />
          <EditorialTab
            value="members"
            index="03"
            label={t('members.title')}
            icon={<Users />}
          />
          <EditorialTab
            value="settings"
            index="04"
            label={t('settings.title')}
            icon={<Settings />}
          />
        </TabsList>

        <TabsContent value="versions" className="m-0 p-5 sm:p-8 lg:p-12">
          <VersionList
            project={project}
            pendingVersionId={pendingVersionId}
            readOnly={readOnly}
            onPublish={onPublish}
            onRollback={onRollback}
            onDelete={onDeleteVersion}
          />
        </TabsContent>

        <TabsContent value="history" className="m-0 p-5 sm:p-8 lg:p-12">
          <SectionHeading
            index="02"
            title={t('history.title')}
            description={t('history.desc')}
          />
          <ProjectHistoryTimeline
            projectId={project.id}
            refreshKey={`${project.updatedAt}:${project.versions.length}`}
          />
        </TabsContent>

        <TabsContent value="members" className="m-0 p-5 sm:p-8 lg:p-12">
          <SectionHeading
            index="03"
            title={t('members.title')}
            description={t('members.desc')}
            action={
              currentUserIsOwner ? (
                <Button onClick={() => setShowAddMember(true)}>
                  <UserPlus />
                  {t('members.add')}
                </Button>
              ) : undefined
            }
          />
          <MemberList
            project={project}
            currentUserId={user.id}
            onChanged={onUploaded}
          />
        </TabsContent>

        <TabsContent value="settings" className="m-0 p-5 sm:p-8 lg:p-12">
          <SectionHeading
            index="04"
            title={t('settings.title')}
            description={t('settings.desc')}
          />
          <ProjectSettingsForm
            project={project}
            canManage={canManage}
            onSaved={onUploaded}
            onDeleted={onProjectDeleted}
          />
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

function EditorialTab({
  value,
  index,
  label,
  icon,
}: {
  value: string;
  index: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      className="group h-auto min-w-0 justify-start gap-3 border-r px-4 py-5 text-left last:border-r-0 data-active:bg-card sm:px-7"
    >
      <span className="editorial-meta text-primary">{index}</span>
      <span className="hidden sm:block">{icon}</span>
      <span className="truncate text-sm font-semibold">{label}</span>
    </TabsTrigger>
  );
}

function SectionHeading({
  index,
  title,
  description,
  action,
}: {
  index: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 border-b pb-6 sm:flex-row sm:items-end">
      <div>
        <span className="editorial-meta text-primary">{index} / Section</span>
        <h2 className="mt-3 text-3xl font-normal tracking-[-0.05em]">
          {title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
