// Verify the secret scanner still catches a real credential.
//
// The credential is assembled from parts on purpose, so this file does not
// itself contain something that looks like a real secret.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const target = 'server/config.js';
const original = fs.readFileSync(target, 'utf8');

const scheme = 'postgres';
const user = 'movieuser';
const secret = ['Sup3r', 'S3cret', 'P4ss'].join('');
const host = 'db.example.com';
const fake = `${scheme}://${user}:${secret}@${host}/movies`;

fs.writeFileSync(target, `${original}\nconst fake = "${fake}";\n`);

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

if (detected && output.includes(secret)) {
  console.log('OK — a real credential is detected and reported.');
  process.exit(0);
}
console.log('PROBLEM — the scanner did not catch the test credential.');
console.log(output);
process.exit(1);
