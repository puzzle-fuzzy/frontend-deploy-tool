import {
  artifactAuditCategorySchema,
  artifactAuditContextSchema,
  artifactAuditPolicySchema,
  artifactAuditSeveritySchema,
  artifactAuditStatusSchema,
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

const artifactAuditProcessFileSchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
  })
  .strict();

const artifactAuditProcessExtensionSchema = z
  .object({
    extension: z.string(),
    bytes: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();

const artifactAuditProcessAssetBytesSchema = z
  .object({
    javascript: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024 * 1024),
    stylesheet: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024 * 1024),
    font: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024 * 1024),
    image: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024 * 1024),
  })
  .strict();

const artifactAuditProcessSummarySchema = z
  .object({
    totalBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    largestFiles: z.array(artifactAuditProcessFileSchema),
    extensions: z.array(artifactAuditProcessExtensionSchema),
    assetBytes: artifactAuditProcessAssetBytesSchema,
  })
  .strict();

const artifactAuditProcessCheckSchema = z
  .object({
    id: z.string(),
    ruleVersion: z.number().int().positive(),
    category: artifactAuditCategorySchema,
    severity: artifactAuditSeveritySchema,
    passed: z.boolean(),
    message: z.string(),
    actual: z.union([z.string(), z.number(), z.boolean()]).optional(),
    expected: z.string().optional(),
  })
  .strict();

export const artifactAuditExecutionResultSchema = z
  .object({
    artifactChecksum: z.string().min(1).max(256),
    status: artifactAuditStatusSchema,
    score: z.number().int().min(0).max(100),
    summary: artifactAuditProcessSummarySchema,
    checks: z.array(artifactAuditProcessCheckSchema).max(1_000),
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

export const ARTIFACT_AUDIT_PROCESS_ERROR_CODES = [
  'AUDIT_REQUIRED',
  'AUDIT_ARTIFACT_UNSAFE',
  'AUDIT_ARTIFACT_UNREADABLE',
  'AUDIT_ENGINE_FAILED',
  'AUDIT_ENGINE_OUTPUT_INVALID',
] as const;

export type ArtifactAuditProcessErrorCode =
  (typeof ARTIFACT_AUDIT_PROCESS_ERROR_CODES)[number];

export const ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES = {
  AUDIT_REQUIRED: 'Artifact changed while the audit was running',
  AUDIT_ARTIFACT_UNSAFE: 'Artifact contains an unsafe filesystem entry',
  AUDIT_ARTIFACT_UNREADABLE: 'Artifact files could not be read',
  AUDIT_ENGINE_FAILED: 'Artifact audit engine failed',
  AUDIT_ENGINE_OUTPUT_INVALID:
    'Artifact audit subprocess returned an invalid result',
} as const satisfies Record<ArtifactAuditProcessErrorCode, string>;

const artifactAuditProcessErrorSchema = z
  .object({
    code: z.enum(ARTIFACT_AUDIT_PROCESS_ERROR_CODES),
    message: z.string(),
    retryable: z.literal(false),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.message !== ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES[error.code]) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'Artifact audit process error message is invalid',
      });
    }
  });

export const artifactAuditProcessEnvelopeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      result: artifactAuditExecutionResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: artifactAuditProcessErrorSchema,
    })
    .strict(),
]);

export type ArtifactAuditExecutionInput = z.infer<
  typeof artifactAuditExecutionInputSchema
>;
export type ArtifactAuditExecutionResult = z.infer<
  typeof artifactAuditExecutionResultSchema
>;
export type ArtifactAuditProcessEnvelope = z.infer<
  typeof artifactAuditProcessEnvelopeSchema
>;
