#!/usr/bin/env node
/**
 * normalize-expiration-months.cjs   (2026-10-27)
 *
 * PURPOSE
 *   Product decision 2026-10-27: an expiration MONTH means the FIRST day of that
 *   month, local org time (America/Los_Angeles). "Jun 2027" = 2027-06-01 00:00 LA.
 *   Historical data was written in inconsistent shapes; this normalizes them.
 *
 * FROM -> TO (instants, all Firestore Timestamps)
 *   Rule A  Statpack check-off wrote END of month: last day of month 23:59:59.999
 *           (or 23:59:59.000) LA   ->  1st of the same month 00:00:00.000 LA.
 *   Rule B  Receiving/intake wrote new Date('YYYY-MM-01') (and the old date-input
 *           bug generally): 00:00:00.000 UTC on calendar date D
 *                                  ->  00:00:00.000 LA on that same date D.
 *           (For the 1st this displays as the previous month's last day in LA
 *           today; afterwards it is the 1st of the intended month.)
 *   Else    LA-midnight on any day (already correct) or any other instant
 *           (e.g. serverTimestamp-like values with real times) is left untouched.
 *           Non-midnight, non-A/B Timestamps are logged as "unrecognized".
 *
 * FIELDS SCANNED
 *   statpacks/{id}.contents[].expirationDate (+ any expirationDate nested inside
 *       a content item, e.g. batches/lots arrays)
 *   inventory/{id}.batches[].expirationDate
 *   inventory/{id}.variants[].expirationDate (InventoryVariant carries one)
 *   inventory/{id}.expirationDate (top level)
 *   Only Firestore Timestamps and legacy {seconds,nanoseconds} maps are rewritten
 *   (written back as Timestamps). Strings / other shapes are only REPORTED.
 *   Not scanned (reported in notes): assetNextExpiration, batteryExpiration,
 *   padExpiration, expirationMonth, statpack_logs history, assets[] instances.
 *
 * TIMEZONE MATH
 *   Explicit, via Intl.DateTimeFormat parts for America/Los_Angeles (does NOT
 *   rely on process.env.TZ). Local midnight is found by testing the PST (-8) and
 *   PDT (-7) offsets against the formatter, so DST is handled by the tz database.
 *
 * SAFETY
 *   - Dry-run is the DEFAULT. Writes require --apply.
 *   - Against a non-emulator project, --apply additionally requires --yes-live.
 *   - Only the affected array/top-level field is written (entire array rewritten
 *     with only expirationDate entries changed). No updatedAt bump, no other
 *     fields, no history rows. Writes carry a lastUpdateTime precondition.
 *   - Idempotent: after a run, every changed value is LA-midnight, so a re-run
 *     reports 0 changes. Batches are <= 400 ops and committed incrementally.
 *
 * USAGE
 *   node scripts/normalize-expiration-months.cjs                 # dry run
 *   node scripts/normalize-expiration-months.cjs --apply         # emulator only
 *   node scripts/normalize-expiration-months.cjs --apply --yes-live   # LIVE
 *   Emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-bmrc-logistics
 *   Live creds: GOOGLE_APPLICATION_CREDENTIALS or ./serviceAccountKey.json.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const TZ = 'America/Los_Angeles';
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
const { Timestamp } = admin.firestore;

console.log('='.repeat(72));
console.log(`TARGET PROJECT : ${projectId}`);
console.log(`TARGET         : ${isEmulator ? `EMULATOR (${emulatorHost})` : '*** LIVE FIRESTORE ***'}`);
console.log(`MODE           : ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
console.log('='.repeat(72));
if (APPLY && !isEmulator && !YES_LIVE) {
  console.error('Refusing to --apply against a non-emulator project without --yes-live.');
  process.exit(2);
}

// ---- America/Los_Angeles math ---------------------------------------------
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
/** LA wall-clock parts of an epoch-ms instant (ms = ms-of-second, tz offsets are whole minutes). */
function laParts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  o.ms = ((ms % 1000) + 1000) % 1000;
  return o;
}
/** Epoch ms of 00:00:00.000 LA on y-m-d (m 1-based). Local midnight never falls in the DST gap (shift is at 02:00). */
function laMidnightMs(y, m, d) {
  for (const off of [7, 8]) { // PDT, PST
    const t = Date.UTC(y, m - 1, d) + off * 3600e3;
    const p = laParts(t);
    if (p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0 && p.second === 0) return t;
  }
  throw new Error(`no LA midnight for ${y}-${m}-${d}`);
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n, w = 2) => String(n).padStart(w, '0');
function showLA(ms) {
  const p = laParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.ms, 3)} LA / ${new Date(ms).toISOString()}`;
}

/** Classify an instant. Returns {rule:'A'|'B', targetMs} | {rule:null, kind:'ok'|'unrecognized'}. */
function classify(ms, subMsNanos) {
  if (subMsNanos !== 0) return { rule: null, kind: 'unrecognized' };
  const u = new Date(ms);
  // B: exactly 00:00:00.000 UTC -> LA midnight of the same UTC calendar date.
  if (ms % 86400000 === 0) {
    return { rule: 'B', targetMs: laMidnightMs(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()) };
  }
  const p = laParts(ms);
  if (p.hour === 0 && p.minute === 0 && p.second === 0 && p.ms === 0) return { rule: null, kind: 'ok' };
  // A: last day of month 23:59:59.000 / .999 LA -> 1st same month 00:00 LA.
  if (p.hour === 23 && p.minute === 59 && p.second === 59 && (p.ms === 999 || p.ms === 0) && p.day === daysInMonth(p.year, p.month)) {
    return { rule: 'A', targetMs: laMidnightMs(p.year, p.month, 1) };
  }
  return { rule: null, kind: 'unrecognized' };
}

// ---- value handling --------------------------------------------------------
function isTs(v) { return v instanceof Timestamp; }
function isSecMap(v) {
  return v && typeof v === 'object' && !isTs(v) && !(v instanceof Date) &&
    typeof (v.seconds ?? v._seconds) === 'number' && typeof (v.nanoseconds ?? v._nanoseconds) === 'number';
}
function tsParts(v) {
  if (isTs(v)) return { s: v.seconds, n: v.nanoseconds };
  return { s: v.seconds ?? v._seconds, n: v.nanoseconds ?? v._nanoseconds };
}

const stats = {};
const unrecognized = [];
const otherShapes = [];
function bucket(col) {
  return (stats[col] ||= { docsScanned: 0, docsChanged: 0, A: 0, B: 0, unchanged: 0, unrecognized: 0, otherShapes: 0 });
}

/** Returns the (possibly new) value for one expirationDate and logs. */
function handleExp(value, col, docId, fieldPath) {
  const st = bucket(col);
  if (value === null || value === undefined) return { value, changed: false };
  if (isTs(value) || isSecMap(value)) {
    const { s, n } = tsParts(value);
    const ms = s * 1000 + Math.floor(n / 1e6);
    const c = classify(ms, n % 1e6);
    if (c.rule) {
      st[c.rule]++;
      console.log(`${col}/${docId} ${fieldPath}: ${showLA(ms)} -> ${showLA(c.targetMs)} [rule ${c.rule}]`);
      return { value: Timestamp.fromMillis(c.targetMs), changed: true };
    }
    if (c.kind === 'unrecognized') {
      st.unrecognized++;
      unrecognized.push(`${col}/${docId} ${fieldPath}: ${showLA(ms)}`);
    } else st.unchanged++;
    return { value, changed: false };
  }
  st.otherShapes++;
  otherShapes.push(`${col}/${docId} ${fieldPath}: ${typeof value} ${value instanceof Date ? 'Date ' + value.toISOString() : JSON.stringify(value)}`);
  return { value, changed: false };
}

/** Deep-walk any value; normalize every key named expirationDate. Returns {value, changed}. */
function walk(node, col, docId, p) {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((x, i) => { const r = walk(x, col, docId, `${p}[${i}]`); changed ||= r.changed; return r.value; });
    return { value: changed ? out : node, changed };
  }
  if (node && typeof node === 'object' && !isTs(node) && !(node instanceof Date) && !isSecMap(node)) {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const r = k === 'expirationDate' ? handleExp(v, col, docId, `${p}.${k}`) : walk(v, col, docId, `${p}.${k}`);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: changed ? out : node, changed };
  }
  return { value: node, changed: false };
}

const TARGETS = {
  statpacks: ['contents'],
  inventory: ['batches', 'variants', 'expirationDate'],
};

async function main() {
  let batch = db.batch();
  let ops = 0;
  let pendingDocs = 0;
  async function flush() {
    if (ops === 0) return;
    await batch.commit();
    console.log(`  committed batch of ${ops} write(s)`);
    batch = db.batch(); ops = 0;
  }

  for (const [col, fields] of Object.entries(TARGETS)) {
    const snap = await db.collection(col).get();
    const st = bucket(col);
    for (const doc of snap.docs) {
      st.docsScanned++;
      const data = doc.data();
      const patch = {};
      for (const f of fields) {
        if (!(f in data)) continue;
        const r = f === 'expirationDate' ? handleExp(data[f], col, doc.id, f) : walk(data[f], col, doc.id, f);
        if (r.changed) patch[f] = r.value;
      }
      if (Object.keys(patch).length) {
        st.docsChanged++;
        if (APPLY) {
          batch.update(doc.ref, patch, { lastUpdateTime: doc.updateTime });
          if (++ops >= BATCH_LIMIT) await flush();
        }
      }
    }
  }
  if (APPLY) await flush();

  console.log('\n--- unrecognized Timestamp shapes (NOT changed) ---');
  unrecognized.slice(0, 50).forEach((l) => console.log('  ' + l));
  if (unrecognized.length > 50) console.log(`  ... and ${unrecognized.length - 50} more`);
  console.log('--- non-Timestamp expirationDate values (NOT changed) ---');
  otherShapes.slice(0, 50).forEach((l) => console.log('  ' + l));
  if (otherShapes.length > 50) console.log(`  ... and ${otherShapes.length - 50} more`);

  console.log('\n=== SUMMARY ===');
  let total = 0;
  for (const [col, s] of Object.entries(stats)) {
    total += s.A + s.B;
    console.log(`${col}: docs=${s.docsScanned} docsChanged=${s.docsChanged} ruleA=${s.A} ruleB=${s.B} unchanged=${s.unchanged} unrecognized=${s.unrecognized} otherShapes=${s.otherShapes}`);
  }
  console.log(`TOTAL CHANGES: ${total} (${APPLY ? 'applied' : 'dry-run, nothing written'})`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
