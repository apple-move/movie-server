// Find emoji still used in the frontend source.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2B50}-\u{2B55}]/gu;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'vendor', 'data', 'screenshots'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let count = 0;
for (const file of walk(path.join(ROOT, 'public'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const matches = line.match(EMOJI);
    if (matches) {
      count += matches.length;
      console.log(`${path.relative(ROOT, file)}:${i + 1}: ${matches.join(' ')}  |  ${line.trim().slice(0, 90)}`);
    }
  });
}
console.log(`\n${count} emoji left in public/`);
