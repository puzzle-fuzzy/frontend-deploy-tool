import { z } from 'zod';

/**
 * Domain types are derived (`z.infer`) from these zod schemas, which are the
 * single source of truth shared by the server and the web. Schemas are pure JS
 * (no Bun/Node), so they type-check under both apps.
 */

export const settingsSchema = z.object({
  spaMode: z.boolean(),
  routingType: z.enum(['hash', 'path']),
});

export const versionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versions: z.array(versionSchema),
  /** The single source of truth for which version is live (null = none). */
  activeVersionId: z.string().nullable(),
  settings: settingsSchema,
});

export const historyEventSchema = z.object({
  id: z.string(),
  action: z.enum([
    'project.create',
    'project.delete',
    'version.upload',
    'version.activate',
    'version.delete',
  ]),
  projectId: z.string(),
  projectName: z.string(),
  versionId: z.string(),
  versionName: z.string(),
  timestamp: z.string(),
});

export const dataSchema = z.object({
  schemaVersion: z.number(),
  projects: z.array(projectSchema),
  history: z.array(historyEventSchema),
});

/** Input body for creating a project (plain type, used by the service contract). */
export interface CreateProjectInput {
  name: string;
  slug: string;
  description: string;
}

export type Settings = z.infer<typeof settingsSchema>;
export type Version = z.infer<typeof versionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type HistoryAction = z.infer<typeof historyEventSchema>['action'];
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type Data = z.infer<typeof dataSchema>;
