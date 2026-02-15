#!/usr/bin/env node
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

// Load project ID from .env.local if available (matches backfill script behavior)
if (!projectId) {
  try {
    const envPath = path.join(__dirname, '../.env.local');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    const match = envContent.match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
    if (match) projectId = match[1].trim();
  } catch (ex) { /* ignore */ }
}

admin.initializeApp({ credential, projectId });
const db = admin.firestore();

(async () => {
  try {
    const snapshot = await db.collection('statpack_logs').get();
    console.log(`[•] Total logs: ${snapshot.size}`);

    const byStatpack = new Map();

    snapshot.forEach(doc => {
      const d = doc.data();
      const id = doc.id;
      const statpackId = d.statpackId || '__NO_STATPACK__';
      const list = byStatpack.get(statpackId) || [];
      list.push({ id, ...d });
      byStatpack.set(statpackId, list);
    });

    const entries = Array.from(byStatpack.entries()).sort((a,b) => b[1].length - a[1].length);
    console.log('[•] Top statpacks by log count:');
    for (const [statpackId, logs] of entries.slice(0, 12)) {
      const counts = logs.reduce((acc, l) => {
        acc[l.action] = (acc[l.action] || 0) + 1;
        return acc;
      }, {});
      console.log(`  - ${statpackId}: total=${logs.length} actions=${JSON.stringify(counts)}`);

      // show up to 4 sample logs with timestamp/clientTimestamp
      const sample = logs.slice(0, 6);
      sample.forEach(l => {
        const ts = l.timestamp && typeof l.timestamp.toDate === 'function' ? l.timestamp.toDate().toISOString() : String(l.timestamp || '');
        const ct = l.clientTimestamp && typeof l.clientTimestamp.toDate === 'function' ? l.clientTimestamp.toDate().toISOString() : String(l.clientTimestamp || '');
        console.log(`    * ${l.id} ${l.action} ts=${ts} clientTs=${ct} user=${l.userName || '—'} notes=${l.notes?`"${String(l.notes).slice(0,50)}"`:'—'}`);
      });
    }

    process.exit(0);
  } catch (err) {
    console.error('Error inspecting logs:', err);
    process.exit(1);
  }
})();
