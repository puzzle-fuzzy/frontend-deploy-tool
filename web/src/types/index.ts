export interface Settings {
  spaMode: boolean;
  routingType: "hash" | "path";
}

export interface Version {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  active: boolean;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  versions: Version[];
  settings: Settings;
}

export interface HistoryEvent {
  id: string;
  action: "project.create" | "project.delete" | "version.upload" | "version.activate" | "version.delete";
  projectId: string;
  projectName: string;
  versionId: string;
  versionName: string;
  timestamp: string;
}
