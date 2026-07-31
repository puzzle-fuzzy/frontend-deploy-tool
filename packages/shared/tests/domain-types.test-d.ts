import {
  type ArtifactAuditContext,
  type ArtifactAuditPolicyUpdate,
  type ArtifactAuditRuleConfig,
  getArtifactAuditRuleConfig,
  type HistoryEvent,
  type Project,
  type Settings,
  type Version,
} from '../src';

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
  integrityStatus: 'verified',
  integrityCheckedAt: '2026-07-30T00:00:00.000Z',
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
  auditPolicy: {
    enforcement: 'advisory',
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxFileCount: 1_000,
    maxJavaScriptBytes: 10 * 1024 * 1024,
    maxStylesheetBytes: 2 * 1024 * 1024,
    maxFontBytes: 10 * 1024 * 1024,
  },
  createdBy: 'user-1',
  members: [
    { userId: 'user-1', role: 'owner', invitedAt: '2026-06-30T00:00:00.000Z' },
  ],
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

const auditContext: ArtifactAuditContext = settings;
const legacyPolicyUpdate: ArtifactAuditPolicyUpdate = {
  enforcement: 'blocking',
  maxTotalBytes: 1_024,
  maxFileBytes: 512,
  maxFileCount: 10,
};
const ruleConfig: ArtifactAuditRuleConfig = getArtifactAuditRuleConfig(
  project.auditPolicy
);

void auditContext;
void legacyPolicyUpdate;
void ruleConfig;
void event;
