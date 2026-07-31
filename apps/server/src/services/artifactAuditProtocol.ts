import {
  artifactAuditCheckSchema,
  artifactAuditContextSchema,
  artifactAuditPolicySchema,
  artifactAuditStatusSchema,
  artifactAuditSummarySchema,
} from '@deploykit/shared';
import { z } from 'zod';

export const artifactAuditExecutionInputSchema = z
  .object({
    artifactDir: z.string().min(1).max(4_096),
    expectedChecksum: z.string().max(256),
    policy: artifactAuditPolicySchema,
    context: artifactAuditContextSchema,
  })
  .strict();

export const artifactAuditExecutionResultSchema = z
  .object({
    artifactChecksum: z.string().min(1).max(256),
    status: artifactAuditStatusSchema,
    score: z.number().int().min(0).max(100),
    summary: artifactAuditSummarySchema,
    checks: z.array(artifactAuditCheckSchema).max(1_000),
  })
  .strict();

export type ArtifactAuditExecutionInput = z.infer<
  typeof artifactAuditExecutionInputSchema
>;
export type ArtifactAuditExecutionResult = z.infer<
  typeof artifactAuditExecutionResultSchema
>;
