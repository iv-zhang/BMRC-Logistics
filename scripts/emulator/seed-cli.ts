/**
 * Seed CLI — loads the representative BMRC dataset into the running emulator.
 * Runs the production-config guard (via ./harness) before writing anything.
 *
 * Usage (emulator must be running or use emulators:exec):
 *   npm run seed
 */
import { db } from './harness';
import { EMULATOR } from './guard';
import { seedAll, SEED_COLLECTIONS } from './seed';
import { getDocs, collection } from 'firebase/firestore';

async function main() {
  // eslint-disable-next-line no-console
  console.log(`\nSeeding emulator (${EMULATOR.projectId} @ ${EMULATOR.host})…`);
  await seedAll(db);
  let total = 0;
  for (const name of SEED_COLLECTIONS) {
    const snap = await getDocs(collection(db, name));
    if (snap.size > 0) {
      total += snap.size;
      // eslint-disable-next-line no-console
      console.log(`  • ${name.padEnd(26)} ${snap.size} docs`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n✅ Seeded ${total} docs into the emulator.\n`);
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', e);
  process.exit(1);
});
