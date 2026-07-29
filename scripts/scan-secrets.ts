import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

const SECRET_PATTERNS = [
  {
    name: 'private-key',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: 'aws-access-key',
    expression: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'github-token',
    expression: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    name: 'github-fine-grained-token',
    expression: /\bgithub_pat_[A-Za-z0-9_]{82,255}\b/g,
  },
  {
    name: 'npm-token',
    expression: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    name: 'slack-token',
    expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    name: 'stripe-live-secret',
    expression: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'openai-api-key',
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g,
  },
  {
    name: 'google-api-key',
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'jwt',
    expression:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
] as const;

export interface SecretFinding {
  path: string;
  line: number;
  pattern: (typeof SECRET_PATTERNS)[number]['name'];
}

export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      findings.push({
        path,
        line: lineNumberAt(text, match.index),
        pattern: pattern.name,
      });
    }
  }
  return findings.sort(
    (left, right) =>
      left.line - right.line || left.pattern.localeCompare(right.pattern)
  );
}

/**
 * Scans tracked and non-ignored untracked files. Values are never printed,
 * preventing the scanner itself from copying a discovered credential into CI
 * logs or artifacts.
 */
export function scanRepository(rootDir = process.cwd()): SecretFinding[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: rootDir, encoding: 'utf8' }
  );
  const findings: SecretFinding[] = [];
  for (const relativePath of output.split('\0').filter(Boolean)) {
    const absolutePath = join(rootDir, relativePath);
    if (statSync(absolutePath).size > MAX_SCANNED_FILE_BYTES) continue;
    const bytes = readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    findings.push(...scanText(relativePath, bytes.toString('utf8')));
  }
  return findings;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (text.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

if (import.meta.main) {
  const findings = scanRepository();
  if (findings.length > 0) {
    console.error(`Potential secrets detected (${findings.length}):`);
    for (const finding of findings) {
      console.error(
        `- ${finding.path}:${finding.line} [${finding.pattern}] value redacted`
      );
    }
    process.exitCode = 1;
  } else {
    console.log('Secret scan passed: no known credential patterns found.');
  }
}
