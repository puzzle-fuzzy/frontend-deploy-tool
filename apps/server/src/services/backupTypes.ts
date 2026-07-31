export const DATABASE_AUXILIARY_SUFFIXES = [
  '-journal',
  '-wal',
  '-shm',
] as const;

export type DatabaseAuxiliarySuffix =
  (typeof DATABASE_AUXILIARY_SUFFIXES)[number];

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  schemaVersion: number;
  databaseFile: string;
  storageDirectory: 'storage';
  metadataCounts: {
    users: number;
    projects: number;
    versions: number;
    artifactAudits: number;
    artifactAuditJobs: number;
    auditEvents: number;
    releases: number;
    sessions: number;
    apiTokens?: number;
    apiTokenSecurityEvents?: number;
    ciIdempotencyRecords?: number;
  };
  artifactCounts: {
    files: number;
    bytes: number;
    deployableVersions: number;
  };
}

export interface BackupVerificationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: BackupManifest | null;
}

export interface BackupRestoreReport {
  restoredFrom: string;
  rollbackPath: string;
  verification: BackupVerificationReport;
}

export interface BackupService {
  createBackup(destination: string): BackupManifest;
  verifyBackup(backupPath: string): BackupVerificationReport;
  restoreBackup(
    backupPath: string,
    options: { force: boolean }
  ): BackupRestoreReport;
}

export interface BackupServiceConfig {
  databaseFile: string;
  storageDir: string;
}

export interface BackupServiceDependencies {
  now?: () => Date;
  afterCurrentStateMoved?: (rollbackPath: string) => void;
  afterDatabaseInstalled?: (rollbackPath: string) => void;
  afterRestoredStateInstalled?: (rollbackPath: string) => void;
  restoreFileSystem?: RestoreFileSystem;
  acquireOwnership?: (
    databaseFile: string,
    storageDir: string
  ) => RuntimeOwnership;
  createOperationId?: () => string;
  afterInitialBackupVerified?: (backupPath: string) => void;
  afterRestorePayloadStaged?: (
    manifestStage: string,
    databaseStage: string,
    storageStage: string
  ) => void;
  afterRestoreStorageStageCreated?: (storageStage: string) => void;
  createTemporaryRoot?: (prefix: string) => string;
  cleanupTemporaryRoot?: (temporaryRoot: string) => void;
  createBackupTemporaryId?: () => string;
  removeBackupTemporaryPath?: (temporaryPath: string) => void;
}

export interface RestoreFileSystem {
  rename(source: string, target: string): void;
  copy(
    source: string,
    target: string,
    options?: {
      recursive?: boolean;
      preserveTimestamps?: boolean;
      errorOnExist?: boolean;
      force?: boolean;
    }
  ): void;
  remove(
    target: string,
    options?: { recursive?: boolean; force?: boolean }
  ): void;
}

export interface RuntimeOwnership {
  release(): void;
}

export interface VerifiedBackupPayload {
  report: BackupVerificationReport;
  fingerprint?: string;
}
