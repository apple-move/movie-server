import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser, countUsers } from '../lib/auth.js';

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log('\n  Create a Movie Server account\n');

  const username = (await rl.question('  Username: ')).trim();
  if (!username) {
    console.error('Username is required.');
    process.exit(1);
  }

  const password = await rl.question('  Password: ');
  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }

  const isFirst = countUsers() === 0;
  const roleAnswer = isFirst
    ? 'admin (first account)'
    : (await rl.question('  Role [member/admin]: ')).trim() || 'member';

  const role = roleAnswer.toLowerCase().startsWith('a') ? 'admin' : 'member';
  const displayName = (await rl.question('  Display name (optional): ')).trim() || null;

  try {
    const user = await createUser({ username, password, role, displayName });
    console.log(`\n  ✔ Created ${role} account "${user.username}" (id ${user.id})\n`);
  } catch (err) {
    console.error(`\n  ✖ ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
