#!/usr/bin/env node
/**
 * Migration helper: normalize batch.locations from legacy { name, quantity }
 * to typed { location, quantity } and write back to Firestore.
 *
 * Usage:
 *   - Dry run (default):    node scripts/migrate-batch-locations.js
 *   - Apply changes:        node scripts/migrate-batch-locations.js --apply
 *
 * Requires a Firebase service account or application default credentials.
 * Set `GOOGLE_APPLICATION_CREDENTIALS` env var to the service account JSON file,
 * or ensure the environment has ADC available.
 */

import admin from 'firebase-admin';
import fs from 'fs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON');
    process.exit(1);
  }
}

if (!admin.apps.length) {
  if (cred) admin.initializeApp({ credential: admin.credential.cert(cred) });
  else admin.initializeApp();
}

const db = admin.firestore();

const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;

(async () => {
  console.log('Scanning inventory documents for batch location normalization...');
  const snap = await db.collection('inventory').get();
  let changed = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const batches = Array.isArray(data.batches) ? data.batches : [];
    let updated = false;
    const newBatches = batches.map((b) => {
      const locations = Array.isArray(b.locations) ? b.locations : [];
      const newLocations = locations.map((l) => {
        // ensure legacy `name` is populated (convert from `location` if present)
        const loc = {
          id: l.id ?? uniqueId(),
          name: l.name ?? l.location ?? 'Back Room',
          quantity: Number(l.quantity ?? 0)
        };
        if (!l.name || l.location) updated = true;
        return loc;
      });
      return { ...b, locations: newLocations };
    });

    if (updated) {
      changed++;
      console.log(`Doc ${doc.id} will be updated (${batches.length} batches)`);
      if (APPLY) {
        await db.collection('inventory').doc(doc.id).update({ batches: newBatches });
        console.log(`Updated ${doc.id}`);
      }
    }
  }

  console.log(`Scan complete. Documents with changes: ${changed}`);
  if (!APPLY) console.log('Dry-run complete. Re-run with --apply to write changes.');
  process.exit(0);
})();
