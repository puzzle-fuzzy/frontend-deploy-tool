const fs = require('fs');

const files = [
  'packages/client/src/features/projects/CreateProjectDialog.tsx',
  'packages/client/src/features/projects/useProjects.ts',
  'packages/client/src/features/settings/ProjectSettingsDialog.tsx',
  'packages/client/src/features/versions/UploadVersionDialog.tsx',
];

for (const f of files) {
  let content = fs.readFileSync(f, 'utf-8');
  const lines = content.split('\n');
  const result = [];
  let seenGle = false;
  for (const line of lines) {
    if (line.trim().startsWith('import') && line.includes('getLocalizedError')) {
      if (seenGle) continue;
      seenGle = true;
    }
    result.push(line);
  }
  fs.writeFileSync(f, result.join('\n'));
  console.log('Deduped:', f);
}
