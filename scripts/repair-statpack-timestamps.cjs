#!/usr/bin/env node
/**
 * 2026-10-28: Repair JSON-cloned timestamp maps in statpacks and statpack_logs.
 * Dry-run by default. Metadata-recovered sentinel values are approximate.
 * Production apply requires owner confirmation and a fresh scan after BMRC1-4
 * are checked in. --dry-run takes precedence over --apply.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const FORCE_DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply') && !FORCE_DRY_RUN;
const BATCH_LIMIT = 400;
const DATE_KEYS = new Set([
  'date', 'timestamp', 'at', 'expiration', 'expirationDate', 'effectiveExpiration',
  'effectiveDate', 'startDate', 'endDate', 'completedAt', 'createdAt', 'updatedAt',
  'contentsUpdatedAt', 'checkedOutAt', 'checkedInAt', 'lastCheckedAt', 'lastAuditAt',
  'maintenanceAt',
]);

function plain(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sentinel(value) {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.includes('_methodName') && keys.every(key => key.startsWith('_'));
}

function secMap(value) {
  return plain(value) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number' &&
    Object.keys(value).every(key => ['type', 'seconds', 'nanoseconds'].includes(key));
}

function makeTs(Timestamp, value) {
  if (!Number.isSafeInteger(value.seconds) || !Number.isInteger(value.nanoseconds) ||
      value.nanoseconds < 0 || value.nanoseconds >= 1e9) return null;
  try { return new Timestamp(value.seconds, value.nanoseconds); } catch { return null; }
}

function show(Timestamp, value) {
  return value instanceof Timestamp
    ? `Timestamp(${value.seconds}, ${value.nanoseconds})`
    : JSON.stringify(value);
}

/** Pure helper: plan repairs and unresolved sentinels without Firebase I/O. */
function planDocument(Timestamp, collection, data, metadata, latestContentEdit) {
  const changes = [];
  const unresolved = [];

  function visitValue(value, fieldPath) {
    if (value instanceof Timestamp || value instanceof Date) return value;
    if (!plain(value)) return value;

    if (secMap(value)) {
      const timestamp = makeTs(Timestamp, value);
      if (timestamp) changes.push({ path: fieldPath, before: value, after: timestamp, approximate: false });
      else unresolved.push({ path: fieldPath, reason: 'invalid seconds/nanoseconds map' });
      return timestamp || value;
    }

    if (sentinel(value)) {
      let timestamp;
      let source;
      if (collection === 'statpacks' && fieldPath === 'createdAt') {
        timestamp = metadata.createTime;
        source = 'doc.createTime';
      } else if (collection === 'statpacks' && fieldPath === 'updatedAt') {
        timestamp = metadata.updateTime;
        source = 'doc.updateTime';
      } else if (collection === 'statpacks' && fieldPath === 'contentsUpdatedAt') {
        timestamp = latestContentEdit;
        source = 'latest content_edit log createTime';
      } else if (collection === 'statpack_logs' && fieldPath === 'timestamp') {
        timestamp = metadata.createTime;
        source = 'log.createTime';
      }
      if (timestamp) {
        changes.push({ path: fieldPath, before: value, after: timestamp, approximate: true, source });
        return timestamp;
      }
      const reason = collection === 'statpacks' && fieldPath === 'contentsUpdatedAt'
        ? 'latest content_edit log createTime unavailable'
        : 'approved metadata recovery unavailable';
      unresolved.push({ path: fieldPath, reason });
      return value;
    }

    let changed = false;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = fieldPath ? `${fieldPath}.${key}` : key;
      const repaired = visitContainer(child, childPath);
      changed ||= repaired !== child;
      output[key] = repaired;
    }
    return changed ? output : value;
  }

  function visitContainer(value, fieldPath) {
    if (Array.isArray(value)) {
      let changed = false;
      const output = value.map((child, index) => {
        const repaired = visitContainer(child, `${fieldPath}[${index}]`);
        changed ||= repaired !== child;
        return repaired;
      });
      return changed ? output : value;
    }
    if (!plain(value) || value instanceof Timestamp || value instanceof Date) return value;
    if (secMap(value) || sentinel(value)) return visitValue(value, fieldPath);

    let changed = false;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = fieldPath ? `${fieldPath}.${key}` : key;
      const matchesDateField = DATE_KEYS.has(key) || key.endsWith('At') || key.endsWith('Date');
      const repaired = matchesDateField
        ? visitValue(child, childPath)
        : visitContainer(child, childPath);
      changed ||= repaired !== child;
      output[key] = repaired;
    }
    return changed ? output : value;
  }

  return { result: visitContainer(data, ''), changes, unresolved };
}

module.exports = { planDocument, secMap, sentinel };

async function main() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
  let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (APPLY && !emulatorHost && !process.argv.includes('--yes-live')) {
    throw new Error('Refusing live --apply without --yes-live.');
  }
  if (emulatorHost && !/^(127\.0\.0\.1|localhost):\d+$/.test(emulatorHost)) {
    throw new Error('Refusing non-local emulator host.');
  }
  if (emulatorHost) {
    if (projectId && projectId !== 'demo-bmrc-logistics') throw new Error('Refusing emulator project other than demo-bmrc-logistics.');
    projectId = 'demo-bmrc-logistics';
    admin.initializeApp({ projectId });
  } else {
    if (!projectId) {
      try {
        projectId = fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8')
          .match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/)?.[1].trim();
      } catch { /* env file is optional */ }
    }
    admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
  }

  const db = admin.firestore();
  const { Timestamp, FieldPath } = admin.firestore;
  console.log(`TARGET: ${emulatorHost ? `EMULATOR ${emulatorHost} (${projectId})` : `Firestore ${projectId || '(ADC project)'}`}`);
  console.log(`MODE: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`);

  const logSnapshot = await db.collection('statpack_logs').get();
  const latestByPack = new Map();
  for (const doc of logSnapshot.docs) {
    const log = doc.data();
    const statpackId = log.statpackId || log.packId;
    if (log.action !== 'content_edit' || !statpackId || !doc.createTime) continue;
    const previous = latestByPack.get(statpackId);
    if (!previous || doc.createTime.seconds > previous.seconds ||
        (doc.createTime.seconds === previous.seconds && doc.createTime.nanoseconds > previous.nanoseconds)) {
      latestByPack.set(statpackId, doc.createTime);
    }
  }

  let queue = [];
  let changedDocs = 0;
  let changes = 0;
  let unresolvedCount = 0;
  async function flush() {
    if (!queue.length) return;
    const batch = db.batch();
    for (const item of queue) {
      const args = [];
      for (const [key, value] of Object.entries(item.patch)) args.push(new FieldPath(key), value);
      args.push({ lastUpdateTime: item.doc.updateTime });
      batch.update(item.doc.ref, ...args);
    }
    await batch.commit();
    queue = [];
  }

  for (const collection of ['statpacks', 'statpack_logs']) {
    const snapshot = collection === 'statpacks' ? await db.collection(collection).get() : logSnapshot;
    for (const doc of snapshot.docs) {
      const latest = collection === 'statpacks' ? latestByPack.get(doc.id) : undefined;
      const plan = planDocument(Timestamp, collection, doc.data(), {
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      }, latest);
      const patch = {};
      for (const change of plan.changes) {
        console.log(`${collection}/${doc.id} ${change.path}: ${show(Timestamp, change.before)} -> ${show(Timestamp, change.after)}${change.approximate ? ` [APPROXIMATE; ${change.source}]` : ''}`);
        const topLevel = change.path.split(/[.[]/)[0];
        patch[topLevel] = plan.result[topLevel];
        changes++;
      }
      for (const item of plan.unresolved) {
        console.log(`${collection}/${doc.id} ${item.path}: UNRESOLVED (${item.reason})`);
        unresolvedCount++;
      }
      if (Object.keys(patch).length) {
        changedDocs++;
        if (APPLY) {
          queue.push({ doc, patch });
          if (queue.length >= BATCH_LIMIT) await flush();
        }
      }
    }
  }
  if (APPLY) await flush();
  console.log(`SUMMARY: changes=${changes} docs=${changedDocs} unresolved=${unresolvedCount} ${APPLY ? 'applied' : 'dry-run; nothing written'}`);
  await db.terminate();
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
