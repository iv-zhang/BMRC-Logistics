#!/usr/bin/env node
const admin = require('firebase-admin');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run this script.');
  process.exit(1);
}

try {
  admin.initializeApp();
} catch (e) {
  // ignore if already initialized
}

const db = admin.firestore();

async function run() {
  console.log('Listing up to 10 docs from auditEvents...');
  const snap = await db.collection('auditEvents').limit(10).get();
  console.log(`Found ${snap.size} documents.`);
  snap.docs.forEach((d) => {
    const data = d.data();
    console.log('---');
    console.log('id:', d.id);
    console.log('eventType:', data.eventType);
    console.log('actor:', data.actor);
    console.log('timestamp:', data.timestamp ? data.timestamp.toDate() : data.timestamp);
    console.log('targets:', data.targets);
    console.log('details sample:', JSON.stringify(data.details || data.delta || { before: data.before, after: data.after }, null, 2).slice(0, 400));
  });
}

run().catch((err) => {
  console.error('Error reading auditEvents:', err);
  process.exit(2);
});
