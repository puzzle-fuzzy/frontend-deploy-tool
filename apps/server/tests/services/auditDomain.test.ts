import { describe, expect, test } from 'bun:test';
import type { AuditCheck } from '@deploykit/shared';
import { scoreAudit } from '../../src/domain/audit';

const check = (severity: AuditCheck['severity']): AuditCheck => ({
  id: `check-${severity}`,
  category: 'metadata',
  severity,
  title: `${severity} check`,
  message: `${severity} message`,
});

describe('scoreAudit', () => {
  test('returns passed with a perfect score when there are no warnings or errors', () => {
    expect(scoreAudit([check('info')])).toEqual({
      score: 100,
      status: 'passed',
    });
  });

  test('subtracts five points per warning and sets warning status', () => {
    expect(scoreAudit([check('warning'), check('warning')])).toEqual({
      score: 90,
      status: 'warning',
    });
  });

  test('subtracts fifteen points per error and sets failed status', () => {
    expect(scoreAudit([check('warning'), check('error')])).toEqual({
      score: 80,
      status: 'failed',
    });
  });

  test('clamps score at zero', () => {
    expect(Array.from({ length: 10 }, () => check('error'))).toHaveLength(10);
    expect(scoreAudit(Array.from({ length: 10 }, () => check('error')))).toEqual({
      score: 0,
      status: 'failed',
    });
  });
});
