import {
  artifactAuditCheckSchema,
  artifactAuditContextSchema,
  artifactAuditPolicySchema,
  artifactAuditStatusSchema,
  artifactAuditSummarySchema,
} from '@deploykit/shared';
import { z } from 'zod';
import {
  ARTIFACT_AUDIT_RULES,
  isArtifactAuditRuleId,
} from '../domain/artifactAuditRules';

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
  .strict()
  .superRefine((result, context) => {
    const seen = new Set<string>();
    for (const [index, check] of result.checks.entries()) {
      const path = ['checks', index];
      if (seen.has(check.id)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: 'Artifact audit check IDs must be unique',
        });
        continue;
      }
      seen.add(check.id);
      if (!isArtifactAuditRuleId(check.id)) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: 'Artifact audit check ID is unknown',
        });
        continue;
      }

      const rule = ARTIFACT_AUDIT_RULES[check.id];
      if (check.ruleVersion !== rule.version) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'ruleVersion'],
          message: 'Artifact audit check rule version is invalid',
        });
      }
      if (check.category !== rule.category) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'category'],
          message: 'Artifact audit check category is invalid',
        });
      }
      const expectedSeverity = check.passed ? 'info' : rule.failureSeverity;
      if (check.severity !== expectedSeverity) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'severity'],
          message: 'Artifact audit check severity is invalid',
        });
      }
    }
  });

export type ArtifactAuditExecutionInput = z.infer<
  typeof artifactAuditExecutionInputSchema
>;
export type ArtifactAuditExecutionResult = z.infer<
  typeof artifactAuditExecutionResultSchema
>;
