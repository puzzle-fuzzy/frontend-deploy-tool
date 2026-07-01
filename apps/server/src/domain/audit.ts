import type { AuditCheck, AuditStatus } from '@deploykit/shared';

export const DEFAULT_AUDIT_PROFILE = 'production-web' as const;

export function scoreAudit(checks: AuditCheck[]): {
  score: number;
  status: AuditStatus;
} {
  let score = 100;
  let hasWarning = false;
  let hasError = false;

  for (const check of checks) {
    if (check.severity === 'error') {
      score -= 15;
      hasError = true;
    }
    if (check.severity === 'warning') {
      score -= 5;
      hasWarning = true;
    }
  }

  return {
    score: Math.max(0, score),
    status: hasError ? 'failed' : hasWarning ? 'warning' : 'passed',
  };
}
