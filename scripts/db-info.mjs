import { db, q, one } from '../server/db.js';

const tables = q(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);

console.log('tables:');
for (const t of tables) {
  const { c } = one(`SELECT COUNT(*) AS c FROM ${t.name}`);
  console.log(`  ${t.name.padEnd(22)} ${String(c).padStart(6)} rows`);
}

console.log('\njournal mode :', one('PRAGMA journal_mode').journal_mode);
console.log('page size    :', one('PRAGMA page_size').page_size);
