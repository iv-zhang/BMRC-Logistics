#!/usr/bin/env node

/**
 * Backfill denormalized fields on shift_requests docs (Phase 0, medops-signup-plan.md §2.1).
 *
 * Adds two fields to existing `shift_requests` docs:
 *
 *   1. `shiftStartAt` — a Firestore Timestamp for the shift start instant,
 *      derived from the parent event's date + callTime (or team startTime if set).
 *      Used by the external worker, cancellation policy, and reminders.
 *
 *   2. `eventType` — copied from the parent Event.eventType. Used by
 *      MemberShiftStats.shiftsByType and minShiftsByType tier criterion.
 *
 * Skips docs that already have BOTH fields. Never overwrites existing non-null
 * values. Reports per-doc what would change, then a summary (total scanned /
 * would-write / skipped / orphaned / unresolvable).
 *
 * Usage:
 *   node scripts/backfill-request-denorms.cjs               # dry run (default)
 *   node scripts/backfill-request-denorms.cjs --dry-run     # dry run (explicit)
 *   node scripts/backfill-request-denorms.cjs --force       # apply writes
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service account JSON
 * (or ADC available). Batches writes in chunks of 400 to stay under the
 * Firestore 500-op write-batch cap.
 */

const BATCH_CHUNK_SIZE = 400;

// ---------------------------------------------------------------------------
// Date/time helpers (mirrors app/components/events/event-utils.ts)
// ---------------------------------------------------------------------------

/**
 * Coerce a Firestore Timestamp / Date / FieldValue-ish value to a Date, or null.
 * Also handles plain `{seconds,nanoseconds}` maps — legacy event docs.
 */
function toJsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value;
  if (typeof maybe.toDate === 'function') {
    try {
      const d = maybe.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  const secs = typeof maybe.seconds === 'number' ? maybe.seconds
    : typeof maybe._seconds === 'number' ? maybe._seconds : undefined;
  if (typeof secs === 'number') {
    const nanos = maybe.nanoseconds ?? maybe._nanoseconds ?? 0;
    const d = new Date(secs * 1000 + Math.floor(nanos / 1e6));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Combine `event.date` (the day) with a time string ("HH:mm") into a Date.
 * Returns null if no callTime or if parsing fails.
 */
function timeStringToDate(dateValue, timeString) {
  if (!timeString) return null;
  const day = toJsDate(dateValue);
  if (!day) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeString.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Derive the shift start instant from the event. Use team startTime if
 * available, else event callTime. Combine with event.date to create a Date.
 * Returns null if the date or time cannot be resolved.
 */
function deriveShiftStartAt(event, eventTeams) {
  if (!event.date) return null;
  let timeString = event.callTime;
  // If a specific team is identified with a startTime, use that instead.
  // (For now, just use callTime; per-team startTime override is possible
  // but the event docs don't have a normalized team array to search.)
  if (!timeString) return null; // callTime is required per plan P12.
  const date = timeStringToDate(event.date, timeString);
  return date;
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const isForce = argv.includes('--force');
  const isDry = !isForce; // dry-run is the default; --force is required to write

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

  console.log(`\nShift request denorm backfill — mode: ${isDry ? 'DRY RUN (no writes)' : 'FORCE (will write)'}\n`);

  // Fetch all shift_requests and their parent events.
  const requestsSnap = await db.collection('shift_requests').get();
  console.log(`Found ${requestsSnap.size} shift_request docs.\n`);

  // Prefetch all events to avoid N+1 queries.
  const eventsSnap = await db.collection('events').get();
  const eventMap = new Map();
  eventsSnap.forEach((doc) => {
    eventMap.set(doc.id, doc.data());
  });

  const toWriteRows = [];
  const skippedRows = [];
  const orphanedRows = [];
  const unresolvedRows = [];
  const updates = [];

  requestsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const eventId = data.eventId;

    // Skip if already has both denormalized fields.
    if (data.shiftStartAt && data.eventType) {
      skippedRows.push({
        id: docSnap.id,
        reason: 'already has both shiftStartAt and eventType',
      });
      return;
    }

    // Lookup parent event.
    const event = eventMap.get(eventId);
    if (!event) {
      orphanedRows.push({
        id: docSnap.id,
        eventId,
        userId: data.userId || '',
        reason: 'parent event not found',
      });
      return;
    }

    // Derive the new values.
    const derivedShiftStartAt = deriveShiftStartAt(event);
    const derivedEventType = event.eventType || undefined;

    // Skip if we can't resolve a required field.
    if (!derivedShiftStartAt && !derivedEventType) {
      unresolvedRows.push({
        id: docSnap.id,
        eventId,
        reason: 'cannot resolve shiftStartAt (missing event.date or callTime)',
      });
      return;
    }

    // Build the update: never overwrite an existing non-null value.
    const patchData = {};
    if (!data.shiftStartAt && derivedShiftStartAt) {
      patchData.shiftStartAt = admin.firestore.Timestamp.fromDate(derivedShiftStartAt);
    }
    if (!data.eventType && derivedEventType) {
      patchData.eventType = derivedEventType;
    }

    if (Object.keys(patchData).length === 0) {
      skippedRows.push({
        id: docSnap.id,
        reason: 'both fields already present',
      });
      return;
    }

    toWriteRows.push({
      id: docSnap.id,
      eventId,
      userId: data.userId || '',
      willSet: Object.keys(patchData).join(', '),
    });

    updates.push({
      ref: docSnap.ref,
      data: patchData,
    });
  });

  console.log(`Will write ${updates.length} docs:\n`);
  if (toWriteRows.length > 0) console.table(toWriteRows);

  if (orphanedRows.length > 0) {
    console.log(`\nOrphaned requests (parent event not found): ${orphanedRows.length}`);
    console.table(orphanedRows);
  }

  if (unresolvedRows.length > 0) {
    console.log(`\nUnresolvable requests (event exists but no usable callTime): ${unresolvedRows.length}`);
    console.table(unresolvedRows);
    console.log('Run scripts/report-events-missing-calltime.cjs to find these events.');
  }

  const totalScanned = requestsSnap.size;
  const totalWrite = updates.length;
  const totalSkipped = skippedRows.length;
  const totalOrphaned = orphanedRows.length;
  const totalUnresolved = unresolvedRows.length;

  console.log(`\nSummary: ${totalScanned} scanned, ${totalWrite} would write, ${totalSkipped} skipped, ${totalOrphaned} orphaned, ${totalUnresolved} unresolvable.`);

  if (totalWrite === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (isDry) {
    console.log('\nDry run complete. No writes performed. Re-run with --force to apply.');
    return;
  }

  console.log(`\nApplying ${updates.length} updates in batches of ${BATCH_CHUNK_SIZE}...`);
  let applied = 0;
  for (let i = 0; i < updates.length; i += BATCH_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = db.batch();
    for (const u of chunk) batch.update(u.ref, u.data);
    await batch.commit();
    applied += chunk.length;
    console.log(`  Committed ${applied}/${updates.length}`);
  }

  console.log(`\nDone. Applied ${applied} updates.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
