const fs = require('fs');
const path = require('path');

const files = [
  'packages/client/src/features/members/MemberList.tsx',
  'packages/client/src/features/members/TransferOwnershipDialog.tsx',
  'packages/client/src/features/settings/ProjectSettingsDialog.tsx',
  'packages/client/src/features/versions/UploadVersionDialog.tsx',
  'packages/client/src/features/projects/CreateProjectDialog.tsx',
  'packages/client/src/features/projects/useProjects.ts',
];

for (const filePath of files) {
  const fullPath = path.resolve(filePath);
  let content = fs.readFileSync(fullPath, 'utf-8');

  if (!content.includes('getLocalizedError')) {
    content = content.replace(
      /(import .+ from ['"][^'"]+['"];)([\s\S]*?)(\n\w)/m,
      (match, importStmt, rest, after) => {
        return importStmt + rest + "\nimport { getLocalizedError } from '../../shared/error-messages';" + after;
      }
    );
    // Simpler approach: find the last import and add after it
    const importLines = content.match(/^import .+;$/gm);
    if (importLines && importLines.length > 0) {
      const lastLine = importLines[importLines.length - 1];
      content = content.replace(
        lastLine,
        lastLine + "\nimport { getLocalizedError } from '../../shared/error-messages';"
      );
    }
  }

  content = content.replace(
    /err instanceof Error \? err\.message : t\('common\.failed'\)/g,
    "getLocalizedError(err, t, t('common.failed'))"
  );

  fs.writeFileSync(fullPath, content);
  console.log('Updated:', filePath);
}
