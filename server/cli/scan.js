import { initProviders, listProviders } from '../providers/index.js';
import { scanProvider } from '../services/scanner.js';

const providerArg = process.argv[2] || 'local';
const prefixArg = process.argv[3] || '';

async function main() {
  await initProviders();
  const providers = listProviders();
  const target = providers.find((p) => p.id === providerArg);

  if (!target) {
    console.error(`Unknown provider "${providerArg}". Available: ${providers.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  if (!target.configured) {
    console.error(`Provider "${providerArg}" is not configured. Check your .env file.`);
    process.exit(1);
  }

  console.log(`\nScanning ${target.name}...`);
  const stats = await scanProvider(providerArg, { prefix: prefixArg });
  console.log('\nScan complete:');
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key.padEnd(12)} ${value}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
