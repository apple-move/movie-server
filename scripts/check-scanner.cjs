// Verify the secret scanner still catches a real credential.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const target = 'server/config.js';
const original = fs.readFileSync(target, 'utf8');

fs.writeFileSync(
  target,
  `${original}\nconst fake = "postgres://movieuser:Sup3rS3cretP4ss@db.example.com/movies";\n`,
);

let detected = false;
let output = '';
try {
  execFileSync('node', ['scripts/scan-secrets.mjs'], { stdio: 'pipe' });
} catch (err) {
  detected = true;
  output = err.stdout.toString();
} finally {
  fs.writeFileSync(target, original);
}

if (detected && /Sup3rS3cretP4ss/.test(output)) {
  console.log('OK — a real credential is detected and reported.');
  process.exit(0);
}
console.log('PROBLEM — the scanner did not catch the test credential.');
console.log(output);
process.exit(1);
