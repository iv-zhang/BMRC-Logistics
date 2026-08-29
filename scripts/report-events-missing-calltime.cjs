#!/usr/bin/env node

/**
 * Report: events with missing or null callTime.
 *
 * Scans the `events` collection and reports every event doc lacking a callTime
 * field. callTime is required for auto-promotion and other time-dependent logic;
 * this script is a read-only audit to identify legacy data that violates the
 * requirement (see the plan P12, medops-signup-plan.md §2.2).
 *
 * Usage:
 *   node scripts/report-events-missing-calltime.cjs
 *
 * Output: A count plus a table of id, event name, date, and status, so the
 * operator can fix them by hand in the UI.
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service account JSON
 * (or ADC available). No writes are ever performed.
 */

async function main() {
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    console.error('This script requires firebase-admin. Install with `npm i firebase-admin` and set GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run this script.');
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  console.log('\n=== Events Missing callTime — READ-ONLY AUDIT ===\n');

  const snap = await db.collection('events').get();
  console.log(`Found ${snap.size} event docs.\n`);

  const missingCallTime = [];

  snap.forEach((docSnap) => {
    const data = docSnap.data();
    const name = data.name || '(no name)';
    const date = data.date ? formatDate(data.date) : '(no date)';
    const status = data.status || '(no status)';
    const callTime = data.callTime;

    // Check for missing or null callTime.
    if (callTime === undefined || callTime === null || callTime === '') {
      missingCallTime.push({
        id: docSnap.id,
        name,
        date,
        status,
        callTime: callTime === undefined ? 'undefined' : callTime === null ? 'null' : '(empty string)',
      });
    }
  });

  console.log(`Events with missing/null callTime: ${missingCallTime.length}\n`);

  if (missingCallTime.length > 0) {
    console.table(missingCallTime);
  }

  console.log(`\nSummary: ${missingCallTime.length}/${snap.size} events need a callTime.`);
  console.log('Fix these in the event editor and try the backfill script again.');
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const maybe = value;
  if (typeof maybe.toDate === 'function') {
    try {
      const d = maybe.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
    } catch {
      return null;
    }
  }
  const secs = typeof maybe.seconds === 'number' ? maybe.seconds
    : typeof maybe._seconds === 'number' ? maybe._seconds : undefined;
  if (typeof secs === 'number') {
    const nanos = maybe.nanoseconds ?? maybe._nanoseconds ?? 0;
    const d = new Date(secs * 1000 + Math.floor(nanos / 1e6));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
