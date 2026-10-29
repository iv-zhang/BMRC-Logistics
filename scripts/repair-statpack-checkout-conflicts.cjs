#!/usr/bin/env node
/**
 * repair-statpack-checkout-conflicts.cjs (2026-10-28)
 *
 * PURPOSE
 *   Reconcile stale checkout custody fields when a statpack is marked checked
 *   out but its status is not In Use. This can happen when an audit derives a
 *   Ready status without changing custody.
 *
 * FROM -> TO
 *   statpacks with isCheckedOut=true and status!='In Use': clear
 *   isCheckedOut/assignedToUserId/assignedToUserName/checkedOutAt/currentEventId/
 *   currentEvent; retain status. Add a paired-history checkin row to
 *   statpack_logs with the required admin actor. Event shifts are not changed.
 *
 * Dry-run is the default. Pass --apply to transact each repair with an auditable
 * checkin log. The script never ends event shifts; event IDs are reported for
 * an administrator to close manually.
 *
 * Usage:
 *   node scripts/repair-statpack-checkout-conflicts.cjs --actor '{"userId":"...","userName":"..."}'
 *   node scripts/repair-statpack-checkout-conflicts.cjs --actor '{"userId":"...","userName":"..."}' --apply
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const NOTES = 'Admin reconcile: stale checkout cleared (status/isCheckedOut conflict)';
const CLEARED_FIELDS = [
  'isCheckedOut',
  'assignedToUserId',
  'assignedToUserName',
  'checkedOutAt',
  'currentEventId',
  'currentEvent',
];

function parseArgs(argv) {
  const options = { apply: false, actor: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--actor') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--actor requires a JSON value with userId and userName');
      try { options.actor = JSON.parse(argv[++i]); }
      catch { throw new Error('--actor must be valid JSON, e.g. \'{"userId":"uid","userName":"Name"}\''); }
    } else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.help) {
    if (!options.actor || typeof options.actor !== 'object' || Array.isArray(options.actor) ||
        typeof options.actor.userId !== 'string' || !options.actor.userId.trim() ||
        typeof options.actor.userName !== 'string' || !options.actor.userName.trim()) {
      throw new Error('--actor is required and must include non-empty string userId and userName');
    }
    options.actor = { userId: options.actor.userId.trim(), userName: options.actor.userName.trim() };
  }
  return options;
}

function isConflict(pack) {
  return pack?.isCheckedOut === true && pack.status !== 'In Use';
}

function buildPatch() {
  return {
    isCheckedOut: false,
    assignedToUserId: null,
    assignedToUserName: null,
    checkedOutAt: null,
    currentEventId: null,
    currentEvent: null,
  };
}

function buildLog(pack, actor, timestamp, clientTimestamp) {
  const log = {
    statpackId: pack.id,
    statpackName: pack.name || '(unnamed statpack)',
    action: 'checkin',
    notes: NOTES,
    userId: actor.userId,
    userName: actor.userName,
    timestamp,
    clientTimestamp,
  };
  if (pack.currentEventId) log.eventId = pack.currentEventId;
  if (pack.currentEvent) log.eventName = pack.currentEvent;
  return log;
}

async function reconcileOne(db, packDoc, actor, apply) {
  const packRef = packDoc.ref;
  const logRef = db.collection('statpack_logs').doc();
  let outcome = { id: packDoc.id, changed: false, reason: 'no longer conflicts' };

  await db.runTransaction(async (tx) => {
    const liveSnap = await tx.get(packRef);
    if (!liveSnap.exists || !isConflict(liveSnap.data())) {
      outcome = { id: packDoc.id, changed: false, reason: 'no longer conflicts' };
      return;
    }

    const live = { ...liveSnap.data(), id: liveSnap.id };
    outcome = {
      id: packDoc.id,
      changed: true,
      status: live.status,
      currentEventId: live.currentEventId || null,
      patch: buildPatch(),
      before: Object.fromEntries(CLEARED_FIELDS.map((key) => [
        key,
        Object.hasOwn(live, key) ? live[key] : '<missing>',
      ])),
      log: buildLog(live, actor, 'SERVER_TIMESTAMP', new Date().toISOString()),
    };
    if (apply) {
      tx.update(packRef, buildPatch());
      tx.set(logRef, buildLog(
        live,
        actor,
        admin.firestore.FieldValue.serverTimestamp(),
        admin.firestore.Timestamp.now(),
      ));
    }
  });
  return outcome;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: node scripts/repair-statpack-checkout-conflicts.cjs --actor \'{"userId":"...","userName":"..."}\' [--apply]');
    console.log('Dry-run is the default. --apply writes statpack and statpack_logs documents transactionally.');
    return;
  }

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const isEmulator = Boolean(emulatorHost);
  let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId && !isEmulator) {
    try {
      const match = fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
      if (match) projectId = match[1].trim();
    } catch { /* .env.local is optional */ }
  }

  if (isEmulator) {
    projectId = projectId || 'demo-bmrc-logistics';
    admin.initializeApp({ projectId });
  } else {
    let credential;
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '../serviceAccountKey.json');
    try { credential = admin.credential.applicationDefault(); }
    catch {
      try {
        const serviceAccount = require(serviceAccountPath);
        credential = admin.credential.cert(serviceAccount);
        projectId = projectId || serviceAccount.project_id;
      } catch {
        console.error(`No credentials. Set GOOGLE_APPLICATION_CREDENTIALS or provide ${serviceAccountPath}`);
        process.exitCode = 1;
        return;
      }
    }
    admin.initializeApp({ credential, projectId });
  }

  const db = admin.firestore();
  console.log('='.repeat(72));
  console.log(`TARGET PROJECT : ${projectId || '(ADC default)'}`);
  console.log(`TARGET         : ${isEmulator ? `EMULATOR (${emulatorHost})` : 'LIVE FIRESTORE'}`);
  console.log(`MODE           : ${options.apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log(`ACTOR          : ${options.actor.userName} (${options.actor.userId})`);
  console.log('='.repeat(72));

  try {
    const snapshot = await db.collection('statpacks').get();
    const candidates = snapshot.docs.filter((doc) => isConflict(doc.data()));
    console.log(`Scanned ${snapshot.size} statpacks; ${candidates.length} checkout conflict(s) found.`);
    const counts = { planned: 0, applied: 0, skipped: 0 };

    for (const doc of candidates) {
      const result = await reconcileOne(db, doc, options.actor, options.apply);
      if (!result.changed) {
        console.log(`${result.id}: skipped (${result.reason}).`);
        counts.skipped += 1;
        continue;
      }
      if (options.apply) counts.applied += 1;
      else counts.planned += 1;
      console.log(`\n${result.id} (${result.log.statpackName}) status=${JSON.stringify(result.status)}; status will be kept.`);
      for (const field of CLEARED_FIELDS) {
        console.log(`  ${field}: ${JSON.stringify(result.before[field])} → ${JSON.stringify(result.patch[field])}`);
      }
      console.log(`  statpacks/${result.id} patch: ${JSON.stringify(result.patch, null, 2)}`);
      console.log(`  statpack_logs new row: ${JSON.stringify(result.log, null, 2)}`);
      if (result.currentEventId) {
        console.log(`  MANUAL SHIFT CLOSE: currentEventId=${result.currentEventId} (event shifts were not changed).`);
      }
      if (options.apply) console.log('  Applied transactionally.');
    }
    console.log(`\nSUMMARY: planned=${counts.planned} applied=${counts.applied} skipped=${counts.skipped}`);
  } catch (error) {
    console.error('Checkout conflict repair failed:', error);
    process.exitCode = 1;
  } finally {
    await admin.app().delete();
  }
}

module.exports = { NOTES, CLEARED_FIELDS, parseArgs, isConflict, buildPatch, buildLog, reconcileOne, main };
if (require.main === module) main();
