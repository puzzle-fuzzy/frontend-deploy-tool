import { describe, expect, test } from 'bun:test';
import { scanText } from './scan-secrets';

describe('secret scanner', () => {
  test('detects high-confidence credential formats without returning values', () => {
    const aws = `AKIA${'A'.repeat(16)}`;
    const github = `ghp_${'b'.repeat(36)}`;
    const privateKey = `-----BEGIN ${'PRIVATE'} KEY-----`;
    const findings = scanText(
      'fixture.env',
      `safe=true\nAWS=${aws}\nGITHUB=${github}\n${privateKey}\n`
    );

    expect(findings).toEqual([
      { path: 'fixture.env', line: 2, pattern: 'aws-access-key' },
      { path: 'fixture.env', line: 3, pattern: 'github-token' },
      { path: 'fixture.env', line: 4, pattern: 'private-key' },
    ]);
    expect(JSON.stringify(findings)).not.toContain(aws);
    expect(JSON.stringify(findings)).not.toContain(github);
  });

  test('does not flag normal configuration placeholders', () => {
    expect(
      scanText(
        '.env.example',
        'SESSION_SECRET=\nADMIN_PASSWORD=\nMETRICS_TOKEN=replace-me\n'
      )
    ).toEqual([]);
  });
});
