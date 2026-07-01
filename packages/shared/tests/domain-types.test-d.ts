import type { HistoryEvent, Project, Settings, Version } from '../src';

const settings: Settings = {
  spaMode: true,
  routingType: 'path',
};

const version: Version = {
  id: 'version-1',
  name: 'v1',
  description: 'Initial build',
  createdAt: '2026-06-30T00:00:00.000Z',
  size: 1024,
  fileCount: 3,
  sourceType: 'zip',
  status: 'production',
  publishedAt: '2026-06-30T00:01:00.000Z',
  publishedBy: 'user-1',
  checksum: 'a'.repeat(64),
};

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: 'Demo project',
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z',
  versions: [version],
  activeVersionId: version.id,
  settings,
};

const event: HistoryEvent = {
  id: 'event-1',
  action: 'version.activate',
  projectId: project.id,
  projectName: project.name,
  versionId: version.id,
  versionName: version.name,
  timestamp: '2026-06-30T00:00:00.000Z',
  actorId: 'user-1',
};

void event;
