import { auditArtifactDirectory } from '../services/artifactAuditEngine';
import {
  artifactAuditExecutionInputSchema,
  artifactAuditExecutionResultSchema,
} from '../services/artifactAuditProtocol';

try {
  const input = artifactAuditExecutionInputSchema.parse(
    JSON.parse(await Bun.stdin.text())
  );
  const result = artifactAuditExecutionResultSchema.parse(
    auditArtifactDirectory(
      input.artifactDir,
      input.expectedChecksum,
      input.policy,
      input.context
    )
  );
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write('Artifact audit subprocess failed\n');
  process.exit(1);
}
