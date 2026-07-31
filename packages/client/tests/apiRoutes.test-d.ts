import type { ApiApp } from '@deploykit/server/api';
import type { ArtifactAuditAssessment } from '@deploykit/shared';
import { hc, type InferResponseType } from 'hono/client';

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const client = hc<ApiApp>('');
const getAuditAssessment =
  client.api.projects[':id'].versions[':versionId']['audit-assessment'].$get;

getAuditAssessment({
  param: { id: 'project-1', versionId: 'version-1' },
});

type AuditAssessmentResponse = InferResponseType<
  typeof getAuditAssessment,
  200
>;

const exactResponseType: Equal<
  AuditAssessmentResponse,
  ArtifactAuditAssessment
> = true;

void exactResponseType;
