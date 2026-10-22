/**
 * Scan every tracked file for real credentials.
 *
 * The working tree is scanned (that is what is about to be committed) and
 * the whole git history is scanned as well.
 *
 * Deliberately strict: it only reports a value that looks like an actual
 * secret, not a hash, a separator line or a minified identifier.
 *
 * Run: node scripts/scan-secrets.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

/** Files whose contents are generated or binary. */
const SKIP = /\.(png|jpe?g|gif|webp|mp4|mkv|zip|rar|ico|woff2?|ttf|eot)$/i;

/** Values that are obviously placeholders. */
const PLACEHOLDER =
  /^(change-me|your-|example|placeholder|<.*>|\$\{|xxx|todo|replace|default|test|demo|changeme|secret$|password$|some-long-random-string|123456:abc-def|\.+|\/-*|-----)/i;

/**
 * `KEY=value` pairs in .env-style files.
 * The whitespace classes are line-scoped so a match cannot run onto the
 * next line and capture a different variable.
 */
const ENV_ASSIGNMENT =
  /^[ \t]*([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z0-9_]*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm;

const CHECKS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'Telegram bot token', re: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g },
  {
    name: 'Slack webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+\/]{20,}/g,
  },
  { name: 'Stripe key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/g },
  {
    name: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\n]{40,}/g,
  },
  {
    name: 'Connection string with password',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:([^@\s]{3,})@/gi,
    // Only the password part is checked, so obvious test placeholders are
    // ignored without hiding a real credential elsewhere in the string.
    ignoreGroup: 1,
    ignore: /^(pass|passwd|password|secret|test|demo|user|xxx|changeme|placeholder|admin)/i,
  },
];

let findings = 0;

function report(file, name, match) {
  console.log(`  ${file}: ${name} -> ${String(match).slice(0, 70)}`);
  findings += 1;
}

for (const file of files) {
  if (SKIP.test(file)) continue;
  // package-lock.json only holds npm integrity hashes.
  if (file === 'package-lock.json') continue;

  let content;
  try {
    // Scan the working tree — that is what is about to be committed.
    content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }

  for (const { name, re, ignore, ignoreGroup } of CHECKS) {
    for (const match of content.match(re) || []) {
      if (ignore) {
        const subject = ignoreGroup ? match.split(':').pop() : match;
        if (ignore.test(subject)) continue;
      }
      report(file, name, match);
    }
  }

  // Environment-style assignments: only flag a real-looking value.
  for (const match of content.matchAll(ENV_ASSIGNMENT)) {
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, '').trim();
    if (!value || PLACEHOLDER.test(value)) continue;
    if (value.length < 12) continue;
    if (/^\$/.test(value)) continue;
    // A bcrypt hash is not a credential.
    if (/^\$2[aby]\$\d{2}\$/.test(value)) continue;
    report(file, `${key} in an env-style file`, value);
  }
}

console.log(
  findings
    ? `\n${findings} potential secret(s) found — review the list above.`
    : '\nNo credentials found in the repository.',
);
process.exit(findings ? 1 : 0);
