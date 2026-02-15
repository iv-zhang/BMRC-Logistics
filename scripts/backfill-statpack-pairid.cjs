#!/usr/bin/env node

/**
 * Migration Script: Backfill `pairId` for statpack_logs
 *
 * Heuristic: For each `statpackId`, iterate logs in chronological order. Pair the
 * nearest preceding unmatched `checkout` with a subsequent `checkin`. For each
 * matched pair, write a `pairId` (format: `pair-<checkoutId>-<checkinId>`) to both
 * documents. Skip logs that already have a `pairId`.
 *
 * Usage:
 *   node scripts/backfill-statpack-pairid.cjs --dry-run    # Preview (no writes)
 *   node scripts/backfill-statpack-pairid.cjs --force      # Apply writes
 *   node scripts/backfill-statpack-pairid.cjs --help       # Help
 *
 * Options:
 *   --dry-run         Preview changes without writing
 *   --force           Apply changes (required to write)
 *   --batch-size=N    Number of updates per Firestore batch (default 200)
 *   --userId=ID       Operator userId for migration logs (default: migration-script)
 */

const admin = require('firebase-admin');
const readline = require('readline');

try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} catch (e) {
  console.error('Failed to initialize Firebase Admin SDK:', e.message);
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS or use gcloud auth application-default login');
  process.exit(1);
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');
const showHelp = args.includes('--help');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const userIdArg = args.find((a) => a.startsWith('--userId='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 200;
const operatorUserId = userIdArg ? userIdArg.split('=')[1] : 'migration-script';

if (showHelp || (!isDryRun && !isForce)) {
  console.log(`
Backfill pairId for statpack_logs

Usage:
  node scripts/backfill-statpack-pairid.cjs --dry-run
  node scripts/backfill-statpack-pairid.cjs --force

Options:
  --dry-run         Preview only
  --force           Apply changes
  --batch-size=N    Firestore batch size (default: 200)
  --userId=ID       Operator user id
  --help            This help
`);
  process.exit(0);
}

function generatePairId(checkoutId, checkinId) {
  return `pair-${checkoutId}-${checkinId}`;
}

async function fetchAllStatpackIds() {
  // Query distinct statpackIds by scanning the collection and collecting set.
  const ids = new Set();
  const snap = await db.collection('statpack_logs').select('statpackId').get();
  snap.forEach((d) => {
    const data = d.data();
    if (data && data.statpackId) ids.add(String(data.statpackId));
  });
  return Array.from(ids);
}

async function processStatpack(statpackId) {
  // Fetch chronologically
  const snap = await db
    .collection('statpack_logs')
    .where('statpackId', '==', statpackId)
    .orderBy('timestamp', 'asc')
    .get();

  if (snap.empty) return { paired: 0, skipped: 0 };

  const docs = snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() }));

  const updates = [];
  const pendingCheckouts = [];
  let skipped = 0;
  let paired = 0;

  for (const doc of docs) {
    const a = doc.data || {};
    const action = String(a.action || '');
    if (a.pairId) {
      skipped++;
      // If there's a pending checkout and this pairId corresponds to a checkin for it,
      // we could try to reconcile, but safest is to skip any log that already has pairId.
      continue;
    }

    if (action === 'checkout') {
      pendingCheckouts.push(doc);
      continue;
    }

    if (action === 'checkin') {
      const checkoutDoc = pendingCheckouts.pop();
      if (checkoutDoc) {
        const pairId = generatePairId(checkoutDoc.id, doc.id);
        updates.push({ ref: checkoutDoc.ref, data: { pairId } });
        updates.push({ ref: doc.ref, data: { pairId } });
        paired++;
      } else {
        // No matching checkout; leave as-is
        continue;
      }
      continue;
    }

    // Non checkout/checkin actions ignored
  }

  return { paired, skipped, updates };
}

async function run() {
  console.log('\nBackfill statpack_logs pairId migration');
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'FORCE (will write)'}; Batch size: ${batchSize}`);

  const statpackIds = await fetchAllStatpackIds();
  console.log(`Found ${statpackIds.length} statpackId(s) to scan.`);

  let totalPaired = 0;
  let totalSkipped = 0;
  let totalUpdates = 0;
  const updatesQueue = [];

  for (const sid of statpackIds) {
    const res = await processStatpack(sid);
    totalPaired += res.paired || 0;
    totalSkipped += res.skipped || 0;
    if (res.updates && res.updates.length) {
      updatesQueue.push(...res.updates);
      totalUpdates += res.updates.length;
    }
    console.log(`  ${sid}: paired=${res.paired || 0}, skipped=${res.skipped || 0}, updatesToWrite=${(res.updates && res.updates.length) || 0}`);
  }

  console.log('\nSummary:');
  console.log(`  Total pairs found: ${totalPaired}`);
  console.log(`  Total existing pairId skipped: ${totalSkipped}`);
  console.log(`  Total doc updates to write: ${totalUpdates}`);

  if (totalUpdates === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (isDryRun) {
    console.log('\nDry run complete. No writes performed.');
    return;
  }

  // Confirm
  const confirmed = await confirm('Proceed to write pairId updates to Firestore?');
  if (!confirmed) {
    console.log('Aborting. No changes made.');
    return;
  }

  console.log('\nApplying updates in batches...');
  let applied = 0;
  let failed = 0;
  for (let i = 0; i < updatesQueue.length; i += batchSize) {
    const chunk = updatesQueue.slice(i, i + batchSize);
    const batch = db.batch();
    for (const u of chunk) {
      batch.update(u.ref, { ...u.data });
    }
    try {
      await batch.commit();
      applied += chunk.length;
      console.log(`  Committed ${applied}/${updatesQueue.length}`);
    } catch (e) {
      failed += chunk.length;
      console.error('  Batch commit failed:', e.message);
    }
  }

  console.log(`\nDone. Applied: ${applied}, Failed: ${failed}`);
  // Write migration log
  try {
    await db.collection('migrations').add({
      name: 'backfill-statpack-pairid',
      operator: operatorUserId,
      appliedAt: FieldValue.serverTimestamp(),
      summary: { paired: totalPaired, skipped: totalSkipped, updates: totalUpdates, applied, failed },
    });
    console.log('Migration recorded in `migrations` collection.');
  } catch (e) {
    console.warn('Failed to write migration record:', e.message);
  }
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

run()
  .then(() => {
    console.log('\nMigration complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nMigration failed:', err);
    process.exit(1);
  });
