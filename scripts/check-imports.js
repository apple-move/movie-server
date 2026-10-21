/**
 * Static check: verifies that every identifier used in the app is actually
 * exported/defined. Catches things like a removed import that would only
 * blow up at runtime.
 *
 * Run: node scripts/check-imports.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', 'screenshots', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Collect the names a module exports. */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');
  return names;
}

const files = [
  ...walk(path.join(ROOT, 'server')),
  ...walk(path.join(ROOT, 'public', 'js')),
];

const exportsByFile = new Map();
for (const file of files) {
  exportsByFile.set(file, exportedNames(fs.readFileSync(file, 'utf8')));
}

let problems = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  for (const m of source.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = m[3];
    if (specifier.startsWith('node:')) continue;
    if (!specifier.startsWith('.')) continue;

    const resolved = specifier.startsWith('.')
      ? path.resolve(path.dirname(file), specifier)
      : null;
    if (!resolved || !fs.existsSync(resolved)) {
      console.log(`${path.relative(ROOT, file)}: cannot resolve "${specifier}"`);
      problems += 1;
      continue;
    }

    const available = exportsByFile.get(resolved);
    if (!available) continue;

    const requested = [];
    if (m[1]) requested.push({ name: m[1], kind: 'default' });
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [orig, alias] = trimmed.split(/\s+as\s+/).map((s) => s.trim());
        requested.push({ name: orig, alias, kind: 'named' });
      }
    }

    for (const req of requested) {
      if (!available.has(req.name)) {
        console.log(
          `${path.relative(ROOT, file)}: "${req.name}" is not exported by ${path.relative(ROOT, resolved)}`,
        );
        problems += 1;
      }
    }
  }
}

console.log(problems ? `\n${problems} import problem(s) found.` : 'All imports resolve correctly.');
process.exit(problems ? 1 : 0);
