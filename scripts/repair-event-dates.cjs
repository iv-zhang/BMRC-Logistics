#!/usr/bin/env node
/**
 * Repair `events` docs whose `date` was stored as a plain {seconds,nanoseconds}
 * map instead of a Firestore Timestamp. This happened for events created before
 * the deepRemoveUndefined Timestamp-preservation fix: deepRemoveUndefined
 * rebuilt the Timestamp into a plain object, so Firestore stored it as a map.
 * A map date breaks orderBy('date') and older date coercions.
 *
 * This rewrites each such `date` (and any `endTime`/`callTime` are untouched;
 * they are strings) back into a real Timestamp. Safe + idempotent: docs whose
 * `date` is already a Timestamp are skipped.
 *
 * Usage:
 *   node scripts/repair-event-dates.cjs [--dry-run] [--force]
 *   (also repairs shift_requests.eventDate maps with --requests)
 */

const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, '../serviceAccountKey.json');

let credential;
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
try {
  credential = admin.credential.applicationDefault();
  console.log('[✓] Using Application Default Credentials');
} catch (e) {
  try {
    const serviceAccount = require(serviceAccountPath);
    credential = admin.credential.cert(serviceAccount);
    projectId = projectId || serviceAccount.project_id;
    console.log(`[✓] Using service account from ${serviceAccountPath}`);
  } catch (err) {
    console.error(`[✗] No credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or provide ${serviceAccountPath}`);
    process.exit(1);
  }
}

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
const { Timestamp } = admin.firestore;

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || !args.includes('--force');
const alsoRequests = args.includes('--requests');

/** A value that is a plain {seconds} map (not already a Timestamp). */
function mapDateToTimestamp(value) {
  if (!value || typeof value !== 'object') return null;
  if (value instanceof Timestamp) return null; // already good
  const secs = typeof value.seconds === 'number' ? value.seconds
    : typeof value._seconds === 'number' ? value._seconds : undefined;
  if (typeof secs !== 'number') return null;
  const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
  return new Timestamp(secs, nanos);
}

async function repairCollection(coll, field) {
  const snap = await db.collection(coll).get();
  let broken = 0;
  let fixed = 0;
  for (const doc of snap.docs) {
    const ts = mapDateToTimestamp(doc.get(field));
    if (!ts) continue;
    broken += 1;
    console.log(`  ${coll}/${doc.id}: ${field} map → ${ts.toDate().toISOString()}`);
    if (!isDryRun) {
      await doc.ref.update({ [field]: ts });
      fixed += 1;
    }
  }
  console.log(`[${coll}] ${broken} broken ${field}${isDryRun ? '' : `, ${fixed} repaired`}`);
}

(async () => {
  console.log(isDryRun ? '── DRY RUN (no writes) ──' : '── LIVE RUN ──');
  await repairCollection('events', 'date');
  if (alsoRequests) await repairCollection('shift_requests', 'eventDate');
  if (isDryRun) console.log('\nRe-run with --force to apply.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
