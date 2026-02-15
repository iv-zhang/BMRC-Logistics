#!/usr/bin/env node
/**
 * Normalize `action` field values in `statpack_logs` documents.
 *
 * Usage:
 *   node scripts/normalize-statpack-log-actions.cjs [--dry-run] [--force]
 */

const admin = require('firebase-admin');
const path = require('path');

let credential;
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
try {
  credential = admin.credential.applicationDefault();
  console.log('[✓] Using Application Default Credentials');
} catch (e) {
  try {
    const serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');
    const serviceAccount = require(serviceAccountPath);
    credential = admin.credential.cert(serviceAccount);
    projectId = projectId || serviceAccount.project_id;
    console.log(`[✓] Using service account from ${serviceAccountPath}`);
  } catch (err) {
    console.error('[✗] No credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or provide serviceAccountKey.json');
    process.exit(1);
  }
}

// Load project ID from .env.local if available
if (!projectId) {
  try {
    const envPath = path.join(__dirname, '../.env.local');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    const match = envContent.match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
    if (match) projectId = match[1].trim();
  } catch (e) { /* ignore */ }
}

admin.initializeApp({ credential, projectId });
const db = admin.firestore();

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');

if (isDryRun && isForce) {
  console.error('[✗] Cannot use both --dry-run and --force');
  process.exit(1);
}

const ACTION_MAP = new Map([
  ['checkin', 'checkin'],
  ['check-in', 'checkin'],
  ['check in', 'checkin'],
  ['check-out', 'checkout'],
  ['checkout', 'checkout'],
  ['check out', 'checkout'],
  ['maintenance', 'maintenance'],
  ['maint', 'maintenance'],
  ['restock', 'restock'],
]);

function canonicalAction(raw) {
  if (!raw) return raw;
  const s = String(raw).toLowerCase().trim();
  if (ACTION_MAP.has(s)) return ACTION_MAP.get(s);
  const cleaned = s.replace(/[^a-z]/g, '');
  if (ACTION_MAP.has(cleaned)) return ACTION_MAP.get(cleaned);
  return raw;
}

async function run() {
  console.log('[•] Scanning statpack_logs for action variants...');
  const snapshot = await db.collection('statpack_logs').get();
  console.log(`[•] Found ${snapshot.size} logs`);

  const updates = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    const orig = data.action;
    const canon = canonicalAction(orig);
    if (canon && canon !== orig) {
      updates.push({ ref: doc.ref, id: doc.id, from: orig, to: canon });
    }
  });

  console.log(`[•] Found ${updates.length} docs with non-canonical action values`);
  if (updates.length === 0) process.exit(0);

  if (isDryRun) {
    console.log('[DRY RUN] The following updates would be applied:');
    updates.slice(0, 200).forEach(u => console.log(`  - ${u.id}: ${u.from} -> ${u.to}`));
    console.log('[DRY RUN] Done. Re-run with --force to apply.');
    process.exit(0);
  }

  if (!isForce) {
    console.error('[✗] Run with --force to apply changes (or --dry-run to preview)');
    process.exit(1);
  }

  const batchSize = 500;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = db.batch();
    const chunk = updates.slice(i, i + batchSize);
    chunk.forEach(u => batch.update(u.ref, { action: u.to }));
    await batch.commit();
    console.log(`[✓] Applied ${Math.min(i + batchSize, updates.length)}/${updates.length}`);
  }

  console.log('[✓] Action normalization complete');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
