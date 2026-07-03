const fs = require('fs');

const files = [
  'packages/client/src/features/members/MemberList.tsx',
  'packages/client/src/features/members/TransferOwnershipDialog.tsx',
];

for (const f of files) {
  let content = fs.readFileSync(f, 'utf-8');
  // Fix empty catch blocks
  content = content.replace(
    /catch \(err\) \{\s*\n\s*\}/g,
    `catch (err) {\n      toast(getLocalizedError(err, t, t('common.failed')), 'error');\n    }`
  );
  // Remove duplicate imports of getLocalizedError
  const lines = content.split('\n');
  const seen = new Set();
  const deduped = lines.filter(line => {
    const key = line.trim();
    if (key.includes("getLocalizedError") && key.startsWith("import")) {
      if (seen.has('gle')) return false;
      seen.add('gle');
    }
    return true;
  });
  fs.writeFileSync(f, deduped.join('\n'));
  console.log('Fixed:', f);
}
