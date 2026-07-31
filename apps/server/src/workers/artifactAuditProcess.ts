import {
  ArtifactAuditInspectionError,
  auditArtifactDirectory,
} from '../services/artifactAuditEngine';
import {
  ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES,
  type ArtifactAuditProcessEnvelope,
  artifactAuditExecutionInputSchema,
  artifactAuditExecutionResultSchema,
  artifactAuditProcessEnvelopeSchema,
} from '../services/artifactAuditProtocol';

let input: ReturnType<typeof artifactAuditExecutionInputSchema.parse>;
try {
  input = artifactAuditExecutionInputSchema.parse(
    JSON.parse(await Bun.stdin.text())
  );
} catch {
  writeEnvelope({
    ok: false,
    error: {
      code: 'AUDIT_ENGINE_FAILED',
      message: ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES.AUDIT_ENGINE_FAILED,
      retryable: false,
    },
  });
  process.exit(0);
}

try {
  const result = artifactAuditExecutionResultSchema.parse(
    auditArtifactDirectory(
      input.artifactDir,
      input.expectedChecksum,
      input.policy,
      input.context
    )
  );
  writeEnvelope({ ok: true, result });
} catch (error) {
  if (error instanceof ArtifactAuditInspectionError) {
    writeEnvelope({
      ok: false,
      error: {
        code: error.code,
        message: ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES[error.code],
        retryable: false,
      },
    });
    process.exit(0);
  }
  process.stderr.write('Artifact audit subprocess failed\n');
  process.exit(1);
}

function writeEnvelope(envelope: ArtifactAuditProcessEnvelope): void {
  const validated = artifactAuditProcessEnvelopeSchema.parse(envelope);
  process.stdout.write(JSON.stringify(validated));
}
