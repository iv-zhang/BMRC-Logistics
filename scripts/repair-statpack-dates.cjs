#!/usr/bin/env node
/**
 * repair-statpack-dates.cjs   (2026-10-27)
 *
 * PURPOSE
 *   Until 2026-10-27, app/lib/statpacks.ts had a local recursive `removeUndefined`
 *   that rebuilt EVERY object it touched. On each statpack editor save
 *   (saveStatpackContents), duplicate, and in the log rows it wrote, that turned:
 *     - Firestore Timestamps  into plain maps  { seconds: n, nanoseconds: n }
 *     - FieldValue sentinels (serverTimestamp()) into plain maps like
 *         { _methodName: 'serverTimestamp' }   (internal keys may vary)
 *   The code is fixed; this script repairs the documents already damaged.
 *
 * FROM -> TO
 *   R1  Anywhere inside a statpacks / statpack_logs doc (top-level fields, nested
 *       maps, inside arrays such as contents[] / checkEntries[], recursively):
 *         a plain map with EXACTLY the numeric keys {seconds, nanoseconds}
 *           -> Timestamp(seconds, nanoseconds)            (same instant)
 *   R2  statpacks: a broken sentinel map (plain map whose keys ALL start with '_'
 *       and include '_methodName') -> the document's updateTime (from the admin
 *       snapshot at scan time). Primarily top-level updatedAt / contentsUpdatedAt;
 *       a broken sentinel at ANY other path in a statpacks doc is reported by path
 *       and replaced with doc.updateTime too (still counted/logged as R2).
 *   R3  statpack_logs: `timestamp` is a broken sentinel map, or missing/null while
 *       `clientTimestamp` is absent (missing/null)  -> the log doc's createTime
 *       (exact server write time). createTime wins even when a valid
 *       clientTimestamp exists; both are printed. (A missing timestamp WITH a
 *       clientTimestamp is left alone.) Broken sentinels elsewhere in a
 *       statpack_logs doc are REPORTED only, not changed.
 *   Real Timestamps, Dates, strings, numbers, nulls, GeoPoints, refs are untouched.
 *   Maps that merely look similar (extra keys, non-numeric / non-integer values,
 *   out-of-range seconds) are NOT rewritten; out-of-range ones are reported.
 *
 *   Does NOT change expiration semantics. Run normalize-expiration-months.cjs
 *   AFTER this script: it only normalizes real Timestamps / {seconds,nanoseconds}
 *   maps, so repaired expirationDates must be real Timestamps first.
 *
 * SAFETY
 *   - Dry-run is the DEFAULT. Writes require --apply.
 *   - Against a non-emulator project, --apply additionally requires --yes-live.
 *   - Prints project id and EMULATOR / LIVE before doing anything.
 *   - Only the changed TOP-LEVEL fields are written; a field holding an array/map
 *     is rewritten wholesale only when something inside it changed, everything
 *     else in it preserved exactly. No updatedAt bump, no history rows.
 *   - Every write carries a lastUpdateTime precondition (a doc edited since the
 *     scan is skipped and reported as FAILED; re-run to pick it up). Batches are
 *     <= 400 ops, committed incrementally; if a batch fails it is retried per doc.
 *   - Idempotent: after a run no repairable shape remains, so a re-run = 0 changes.
 *
 * USAGE
 *   node scripts/repair-statpack-dates.cjs                       # dry run
 *   node scripts/repair-statpack-dates.cjs --apply               # emulator only
 *   node scripts/repair-statpack-dates.cjs --apply --yes-live    # LIVE
 *   Emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-bmrc-logistics
 *   Live creds: GOOGLE_APPLICATION_CREDENTIALS or ./serviceAccountKey.json.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const BATCH_LIMIT = 400;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES_LIVE = args.includes('--yes-live');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const isEmulator = !!emulatorHost;

// ---- project + credentials -------------------------------------------------
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
if (!projectId && !isEmulator) {
  try {
    const m = fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
    if (m) projectId = m[1].trim();
  } catch (e) { /* ignore */ }
}
if (isEmulator) {
  projectId = projectId || 'demo-bmrc-logistics';
  admin.initializeApp({ projectId });
} else {
  let credential;
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '../serviceAccountKey.json');
  try {
    credential = admin.credential.applicationDefault();
  } catch (e) {
    try {
      const sa = require(saPath);
      credential = admin.credential.cert(sa);
      projectId = projectId || sa.project_id;
    } catch (err) {
      console.error(`No credentials. Set GOOGLE_APPLICATION_CREDENTIALS or provide ${saPath}`);
      process.exit(1);
    }
  }
  admin.initializeApp({ credential, projectId });
}
const db = admin.firestore();
const { Timestamp, FieldPath } = admin.firestore;

console.log('='.repeat(72));
console.log(`TARGET PROJECT : ${projectId}`);
console.log(`TARGET         : ${isEmulator ? `EMULATOR (${emulatorHost})` : '*** LIVE FIRESTORE ***'}`);
console.log(`MODE           : ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
console.log('='.repeat(72));
if (APPLY && !isEmulator && !YES_LIVE) {
  console.error('Refusing to --apply against a non-emulator project without --yes-live.');
  process.exit(2);
}

// ---- shape detection -------------------------------------------------------
const isTs = (v) => v instanceof Timestamp;
function isPlainObj(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
/** Plain map with exactly numeric {seconds, nanoseconds}. */
function isSecMap(v) {
  if (!isPlainObj(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && keys.includes('seconds') && keys.includes('nanoseconds') &&
    typeof v.seconds === 'number' && typeof v.nanoseconds === 'number';
}
/** Broken serverTimestamp sentinel: all keys start with '_' and include '_methodName'. */
function isSentinel(v) {
  if (!isPlainObj(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.includes('_methodName') && keys.every((k) => k.startsWith('_'));
}
function toTimestamp(m) {
  const { seconds, nanoseconds } = m;
  if (!Number.isInteger(seconds) || !Number.isInteger(nanoseconds)) return null;
  try { return new Timestamp(seconds, nanoseconds); } catch (e) { return null; }
}
const showTs = (t) => `${t.toDate().toISOString()} (s=${t.seconds}, n=${t.nanoseconds})`;
const showMap = (v) => JSON.stringify(v);

// ---- stats -----------------------------------------------------------------
const stats = {};
const reported = [];
function bucket(col) {
  return (stats[col] ||= { docsScanned: 0, docsChanged: 0, R1: 0, R2: 0, R3: 0, reported: 0 });
}

/**
 * Deep-walk a value. Repairs R1 maps; delegates broken sentinels to onSentinel(path, node)
 * which returns a replacement Timestamp or undefined (= report only, leave as-is).
 * Only arrays and plain objects are descended; Timestamps/Dates/etc. are returned as-is.
 */
function walk(node, ctx, p) {
  const st = bucket(ctx.col);
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((x, i) => { const r = walk(x, ctx, `${p}[${i}]`); changed ||= r.changed; return r.value; });
    return { value: changed ? out : node, changed };
  }
  if (!isPlainObj(node)) return { value: node, changed: false };

  if (isSecMap(node)) {
    const t = toTimestamp(node);
    if (!t) {
      st.reported++;
      reported.push(`${ctx.col}/${ctx.docId} ${p}: seconds/nanoseconds map not a valid Timestamp ${showMap(node)}`);
      return { value: node, changed: false };
    }
    st.R1++;
    console.log(`${ctx.col}/${ctx.docId} ${p}: ${showMap(node)} → ${showTs(t)} [R1]`);
    return { value: t, changed: true };
  }
  if (isSentinel(node)) {
    const rep = ctx.onSentinel(p, node);
    if (rep) return { value: rep, changed: true };
    st.reported++;
    reported.push(`${ctx.col}/${ctx.docId} ${p}: broken sentinel ${showMap(node)} (left unchanged)`);
    return { value: node, changed: false };
  }
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const r = walk(v, ctx, p ? `${p}.${k}` : k);
    changed ||= r.changed;
    out[k] = r.value;
  }
  return { value: changed ? out : node, changed };
}

// ---- write queue -----------------------------------------------------------
let queue = [];
let failed = 0;
async function flush() {
  if (!queue.length) return;
  const b = db.batch();
  for (const q of queue) b.update(q.ref, ...q.args);
  try {
    await b.commit();
    console.log(`  committed batch of ${queue.length} write(s)`);
  } catch (e) {
    console.error(`  batch of ${queue.length} failed (${e.message}); retrying per document`);
    for (const q of queue) {
      try { await q.ref.update(...q.args); }
      catch (err) { failed++; console.error(`  FAILED ${q.ref.path}: ${err.message}`); }
    }
  }
  queue = [];
}
async function enqueue(doc, patch) {
  const args = [];
  for (const [k, v] of Object.entries(patch)) args.push(new FieldPath(k), v);
  args.push({ lastUpdateTime: doc.updateTime });
  queue.push({ ref: doc.ref, args });
  if (queue.length >= BATCH_LIMIT) await flush();
}

// ---- per-collection handlers ----------------------------------------------
function processStatpack(doc) {
  const data = doc.data();
  const ctx = {
    col: 'statpacks', docId: doc.id,
    onSentinel: (p, node) => {
      const t = doc.updateTime;
      bucket('statpacks').R2++;
      console.log(`${'statpacks'}/${doc.id} ${p}: ${showMap(node)} → ${showTs(t)} (doc.updateTime) [R2]${/^(updatedAt|contentsUpdatedAt)$/.test(p) ? '' : ' (non-standard path)'}`);
      return t;
    },
  };
  const patch = {};
  for (const [k, v] of Object.entries(data)) {
    const r = walk(v, ctx, k);
    if (r.changed) patch[k] = r.value;
  }
  return patch;
}

function processLog(doc) {
  const data = doc.data();
  const st = bucket('statpack_logs');
  const ctx = { col: 'statpack_logs', docId: doc.id, onSentinel: () => undefined };
  const patch = {};
  const clientTs = data.clientTimestamp;
  const clientShow = clientTs == null ? 'absent' : (isTs(clientTs) ? showTs(clientTs) : showMap(clientTs));
  for (const [k, v] of Object.entries(data)) {
    if (k === 'timestamp' && isSentinel(v)) {
      const t = doc.createTime;
      st.R3++;
      console.log(`statpack_logs/${doc.id} timestamp: ${showMap(v)} → ${showTs(t)} (doc.createTime) [R3] clientTimestamp=${clientShow}`);
      patch.timestamp = t;
      continue;
    }
    const r = walk(v, ctx, k);
    if (r.changed) patch[k] = r.value;
  }
  if ((data.timestamp === undefined || data.timestamp === null) && clientTs == null && !('timestamp' in patch)) {
    const t = doc.createTime;
    st.R3++;
    console.log(`statpack_logs/${doc.id} timestamp: ${data.timestamp === null ? 'null' : '<missing>'} → ${showTs(t)} (doc.createTime) [R3] clientTimestamp=${clientShow}`);
    patch.timestamp = t;
  }
  return patch;
}

const TARGETS = { statpacks: processStatpack, statpack_logs: processLog };

async function main() {
  for (const [col, fn] of Object.entries(TARGETS)) {
    const st = bucket(col);
    const snap = await db.collection(col).get();
    for (const doc of snap.docs) {
      st.docsScanned++;
      const patch = fn(doc);
      if (Object.keys(patch).length) {
        st.docsChanged++;
        if (APPLY) await enqueue(doc, patch);
      }
    }
  }
  if (APPLY) await flush();

  console.log('\n--- reported, NOT changed ---');
  reported.slice(0, 50).forEach((l) => console.log('  ' + l));
  if (reported.length > 50) console.log(`  ... and ${reported.length - 50} more`);

  console.log('\n=== SUMMARY ===');
  let total = 0;
  for (const [col, s] of Object.entries(stats)) {
    total += s.R1 + s.R2 + s.R3;
    console.log(`${col}: docs=${s.docsScanned} docsChanged=${s.docsChanged} R1=${s.R1} R2=${s.R2} R3=${s.R3} reported=${s.reported}`);
  }
  console.log(`TOTAL CHANGES: ${total} (${APPLY ? 'applied' : 'dry-run, nothing written'})`);
  if (failed) {
    console.error(`FAILED WRITES: ${failed} (doc changed since scan or write error) - re-run to retry`);
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
