export interface Settings {
  spaMode: boolean;
  routingType: 'hash' | 'path';
}

export interface Version {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  versions: Version[];
  /** The single source of truth for which version is live (null = none). */
  activeVersionId: string | null;
  settings: Settings;
}

export type HistoryAction =
  | 'project.create'
  | 'project.delete'
  | 'version.upload'
  | 'version.activate'
  | 'version.delete';

export interface HistoryEvent {
  id: string;
  action: HistoryAction;
  projectId: string;
  projectName: string;
  versionId: string;
  versionName: string;
  timestamp: string;
}

export interface Data {
  schemaVersion: number;
  projects: Project[];
  history: HistoryEvent[];
}
