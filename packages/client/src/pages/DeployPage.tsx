import { useApiClient } from '@deploykit/client';
import {
  ArrowLeft,
  Bell,
  Box,
  Code2,
  FolderOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  UploadCloud,
  UserPlus,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeployUrl } from '../features/deploy/DeployUrl';
import { LanguageToggle } from '../features/i18n/LanguageToggle';
import { AddMemberDialog } from '../features/members/AddMemberDialog';
import { MemberList } from '../features/members/MemberList';
import { TransferOwnershipDialog } from '../features/members/TransferOwnershipDialog';
import { CreateProjectDialog } from '../features/projects/CreateProjectDialog';
import { useProjects } from '../features/projects/useProjects';
import { ProjectSettingsForm } from '../features/settings/ProjectSettingsDialog';
import { ThemeToggle } from '../features/theme/ThemeToggle';
import { UploadVersionDialog } from '../features/versions/UploadVersionDialog';
import { VersionList } from '../features/versions/VersionList';
import { formatDate } from '../shared/format';
import type { Project, SafeUser } from '../shared/types';
import { AvatarGroup } from '../shared/ui/avatar-group';
import { Badge } from '../shared/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../shared/ui/breadcrumb';
import { Button } from '../shared/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../shared/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../shared/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '../shared/ui/input-group';
// import {
//   NavigationMenu,
//   NavigationMenuItem,
//   NavigationMenuLink,
//   NavigationMenuList,
// } from '../shared/ui/navigation-menu';
import { Separator } from '../shared/ui/separator';
import { Skeleton } from '../shared/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shared/ui/tabs';
import { useToast } from '../shared/ui/toast-context';

import { AvatarDropdown } from '../shared/ui/avatar-dropdown';

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
    return members.some((m) => m.userId === user.id && m.role === 'owner');
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

  const totalVersions = useMemo(
    () => projects.reduce((sum, project) => sum + project.versions.length, 0),
    [projects]
  );

  const liveProjects = useMemo(
    () => projects.filter((project) => project.activeVersionId).length,
    [projects]
  );

  const activeVersion = selectedProject?.versions.find(
    (version) => version.id === selectedProject.activeVersionId
  );

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

  const projectStatus = (project: Project) =>
    project.activeVersionId ? t('versions.live') : t('versions.notLive');

  const header = (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={handleBack}>
            DeployKit
          </Button>
          {/* <NavigationMenu viewport={false} className="hidden md:flex">
            <NavigationMenuList>
              <NavigationMenuItem>
                <NavigationMenuLink asChild>
                  <Button variant="ghost" onClick={handleBack}>
                    {t('app.projects')}
                  </Button>
                </NavigationMenuLink>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <NavigationMenuLink asChild active>
                  <Button variant="ghost">{t('versions.title')}</Button>
                </NavigationMenuLink>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <NavigationMenuLink asChild>
                  <Button variant="ghost">{t('app.settings')}</Button>
                </NavigationMenuLink>
              </NavigationMenuItem>
            </NavigationMenuList>
          </NavigationMenu> */}
        </div>

        <div className="flex items-center gap-2">
          <InputGroup className="hidden w-64 sm:flex">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search..." type="search" />
          </InputGroup>
          <Button variant="ghost" size="icon-sm" aria-label="Notifications">
            <Bell />
          </Button>
          <ThemeToggle />
          <LanguageToggle />
          <AvatarDropdown user={user} onLogout={handleLogout} />
        </div>
      </div>
    </header>
  );

  const projectListPage = (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {projects.length} {t('app.projects')} / {totalVersions}{' '}
            {t('versions.title')} / {liveProjects} {t('versions.live')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={refresh}>
            Refresh
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus data-icon="inline-start" />
            {t('app.newProject')}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">

        {loading ? (
          <div className="flex flex-col gap-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>{t('projects.empty')}</EmptyTitle>
              <EmptyDescription>{t('projects.emptyDesc')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {projects.map((project) => {
              const isLive = Boolean(project.activeVersionId);
              return (
                <Button
                  key={project.id}
                  type="button"
                  variant="ghost"
                  onClick={() => selectProject(project)}
                >
                  <div className="flex w-full items-center gap-3 text-left">
                    <Box className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {project.name}
                        </span>
                        <Badge variant={isLive ? 'default' : 'outline'}>
                          {projectStatus(project)}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </Button>
              );
            })}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('app.projects')}</span>
              <span>{projects.length}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('versions.title')}
              </span>
              <span>{totalVersions}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('versions.live')}
              </span>
              <span>{liveProjects}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );

  const detailPage = selectedProject && (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button" onClick={handleBack}>
                {t('app.projects')}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{selectedProject.slug}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {activeVersion?.name ?? selectedProject.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              variant={selectedProject.activeVersionId ? 'default' : 'outline'}
            >
              {selectedProject.activeVersionId
                ? t('versions.live')
                : t('versions.notLive')}
            </Badge>
            <Badge variant="outline">{selectedProject.name}</Badge>
            <span className="text-sm text-muted-foreground">
              {formatDate(selectedProject.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft data-icon="inline-start" />
            {t('app.projects')}
          </Button>
          {canManage && (
            <Button onClick={() => setShowUpload(true)}>
              <UploadCloud data-icon="inline-start" />
              {t('versions.upload')}
            </Button>
          )}
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as DetailTab)}
      >
        <TabsList variant="line">
          <TabsTrigger value="versions">
            <Code2 data-icon="inline-start" />
            {t('versions.title')}
          </TabsTrigger>
          <TabsTrigger value="members">
            <Users data-icon="inline-start" />
            {t('members.addTitle')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings data-icon="inline-start" />
            {t('settings.title')}
          </TabsTrigger>
        </TabsList>

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] mt-4">
          <div>
            <TabsContent value="versions">
              <VersionList
                project={selectedProject}
                pendingVersionId={pendingVersionId}
                readOnly={!canManage}
                onPublish={publishVersion}
                onRollback={rollbackVersion}
                onDelete={deleteVersion}
              />
            </TabsContent>

            <TabsContent value="members">
              <Card>
                <CardHeader>
                  <CardTitle>{t('members.addTitle')}</CardTitle>
                  <CardAction>
                    {currentUserIsOwner && (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowAddMember(true)}
                        >
                          <UserPlus data-icon="inline-start" />
                          {t('members.add')}
                        </Button>
                        {memberInfos.length > 1 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowTransfer(true)}
                          >
                            <ShieldCheck data-icon="inline-start" />
                            {t('members.transfer')}
                          </Button>
                        )}
                      </div>
                    )}
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <MemberList
                    members={memberInfos}
                    currentUserId={user.id}
                    projectId={selectedProject.id}
                    onMembersChanged={refresh}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="settings">
              <Card>
                <CardContent>
                  <ProjectSettingsForm
                    project={selectedProject}
                    onDeleted={onProjectDeleted}
                    onSaved={refresh}
                    canDeleteProject={canManage}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Release</CardTitle>
              <CardDescription>{selectedProject.name}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Notes</p>
                <p>
                  {activeVersion?.description ||
                    selectedProject.description ||
                    t('versions.emptyDesc')}
                </p>
              </div>
              <Separator />
              <div>
                <p className="mb-2 text-muted-foreground">Domain</p>
                <DeployUrl
                  slug={selectedProject.slug}
                  activeVersionId={selectedProject.activeVersionId}
                />
              </div>
              <Separator />
              <div>
                <p className="mb-2 text-muted-foreground">Members</p>
                {memberInfos.length > 0 ? (
                  <AvatarGroup users={memberInfos.map((m) => m.user)} max={5} />
                ) : (
                  <p className="text-muted-foreground">No members</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </Tabs>
    </div>
  );

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {header}
      <main>{selectedProject ? detailPage : projectListPage}</main>

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
