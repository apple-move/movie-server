// Check for UTF-8 mojibake across the codebase.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BAD = ['â€', 'Ã©', 'Ã¼', 'ï¿½', '�'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', 'screenshots', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|html|css|json|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let issues = 0;
for (const file of walk(ROOT)) {
  // This file deliberately contains the bad sequences it looks for.
  if (file.endsWith('check-encoding.cjs')) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const bad of BAD) {
      if (line.includes(bad)) {
        console.log(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        issues += 1;
        break;
      }
    }
  });
}
console.log(issues ? `\n${issues} line(s) with mojibake` : 'No mojibake found.');
