#!/usr/bin/env node
// Read-only: full collection reads avoid composite indexes and missing-name omissions.
const admin = require('firebase-admin');
const path = require('path');

// Credential/project bootstrap matches inspect-statpack-logs.cjs.
let credential;
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
try {
  credential = admin.credential.applicationDefault();
  console.log('[✓] Using Application Default Credentials');
} catch {
  try {
    const serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');
    const serviceAccount = require(serviceAccountPath);
    credential = admin.credential.cert(serviceAccount);
    projectId = projectId || serviceAccount.project_id;
    console.log(`[✓] Using service account from ${serviceAccountPath}`);
  } catch {
    console.error('[✗] No credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or provide serviceAccountKey.json');
    process.exit(1);
  }
}

if (!projectId) {
  try {
    const envPath = path.join(__dirname, '../.env.local');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    const match = envContent.match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
    if (match) projectId = match[1].trim();
  } catch { /* ignore */ }
}

admin.initializeApp({ credential, projectId });
const db = admin.firestore();

function display(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested.toDate === 'function') return nested.toDate().toISOString();
    return nested;
  });
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

(async () => {
  try {
    console.log(`[•] Project: ${projectId || '(ADC default)'}; emulator: ${process.env.FIRESTORE_EMULATOR_HOST || '(none — live Firestore)'}`);
    const [packs, logs] = await Promise.all([
      db.collection('statpacks').get(),
      db.collection('statpack_logs').get(),
    ]);
    console.log(`[•] Total statpacks: ${packs.size}; total statpack_logs: ${logs.size}`);
    console.log('[•] Last 3 logs per pack sorted by timestamp descending; missing/invalid timestamps sort last.');

    const byPack = new Map();
    for (const doc of logs.docs) {
      const data = doc.data();
      const rows = byPack.get(data.statpackId) || [];
      rows.push({ ...data, id: doc.id });
      byPack.set(data.statpackId, rows);
    }

    for (const doc of [...packs.docs].sort((a, b) => a.id.localeCompare(b.id))) {
      const pack = doc.data();
      console.log(`\nstatpack ${doc.id}`);
      console.log(`  name=${JSON.stringify(pack.name)} status=${JSON.stringify(pack.status)} hasName=${Object.hasOwn(pack, 'name')}`);
      for (const key of ['isCheckedOut', 'assignedToUserId', 'assignedToUserName', 'checkedOutAt', 'currentEventId', 'currentEvent', 'readyOverride']) {
        console.log(`  ${key}=${display(pack[key])}`);
      }
      const rows = byPack.get(doc.id) || [];
      rows.sort((a, b) => (timestampMillis(b.timestamp) - timestampMillis(a.timestamp)) || a.id.localeCompare(b.id));
      console.log(`  logs (${rows.length} total):`);
      for (const row of rows.slice(0, 3)) {
        console.log(`    ${row.id}: action=${display(row.action)} statusChange=${display(row.statusChange)} timestamp=${display(row.timestamp)}`);
      }
    }
  } catch (err) {
    console.error('Error inspecting statpack availability:', err);
    process.exitCode = 1;
  } finally {
    await admin.app().delete();
  }
})();
