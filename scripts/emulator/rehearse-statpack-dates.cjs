/**
 * Rehearsal for scripts/repair-statpack-dates.cjs. EMULATOR ONLY.
 * Run: npx firebase emulators:exec --config firebase.emulator.json --only firestore \
 *        --project demo-bmrc-logistics "node scripts/emulator/rehearse-statpack-dates.cjs"
 */
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || process.env.GCLOUD_PROJECT !== 'demo-bmrc-logistics') {
  console.error('Refusing: must run under the local emulator with project demo-bmrc-logistics.'); process.exit(1);
}
const admin = require('firebase-admin');
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
admin.initializeApp({ projectId: 'demo-bmrc-logistics' });
const db = admin.firestore();
const { Timestamp } = admin.firestore;
const T = (iso) => Timestamp.fromDate(new Date(iso));
const SENT = () => ({ _methodName: 'serverTimestamp' });

const SEC_A = { seconds: 1790000000, nanoseconds: 0 };
const SEC_B = { seconds: 1790100000, nanoseconds: 500000000 };
const SEC_C = { seconds: 1800000000, nanoseconds: 123000000 };
const SEC_D = { seconds: 1810000000, nanoseconds: 7000 };
const SEC_E = { seconds: 1820000000, nanoseconds: 0 };

async function seed() {
  await db.doc('statpacks/p1').set({
    name: 'Broken', status: 'Ready',
    lastAuditAt: { ...SEC_A },                       // R1 top-level
    checkedOutAt: T('2027-01-02T03:04:05Z'),         // real, untouched
    readyOverride: { by: 'u1', at: { ...SEC_B } },   // R1 nested
    updatedAt: SENT(), contentsUpdatedAt: SENT(),    // R2 x2
    meta: { note: 'x', stamp: SENT() },              // R2 non-standard path
    lookalikes: { a: { seconds: 1, nanoseconds: 2, extra: 3 }, b: { seconds: '1', nanoseconds: 0 } }, // untouched
    contents: [
      { id: 'c1', name: 'Gauze', requiredQuantity: 2, expirationDate: { ...SEC_C }, note: 'keep' }, // R1
      { id: 'c2', name: 'Saline', expirationDate: T('2027-03-01T08:00:00Z') },
      { id: 'c3', name: 'NoExp' },
      { id: 'c4', name: 'Str', expirationDate: '2027-06-30' },
      { id: 'c5', name: 'Nested', batches: [{ lot: 'L1', expirationDate: { ...SEC_D }, stock: 3 }] }, // R1
    ],
  });
  await db.doc('statpacks/p2').set({
    name: 'Clean', updatedAt: T('2026-10-01T00:00:00Z'), contentsUpdatedAt: T('2026-10-01T00:00:00Z'),
    contents: [{ id: 'x', expirationDate: T('2027-07-04T07:00:00Z') }], flag: true,
  });
  await db.doc('statpacks/p3').set({ name: 'DupOnly', updatedAt: SENT(), contents: [] }); // R2 x1

  await db.doc('statpack_logs/l1').set({ packId: 'p1', action: 'content_edit', timestamp: SENT(), user: 'u' });  // R3
  await db.doc('statpack_logs/l2').set({ packId: 'p1', action: 'audit', timestamp: T('2026-09-01T10:00:00Z'),
    checkEntries: [{ id: 'a', expirationDate: T('2027-01-01T08:00:00Z') }] });                                  // clean
  await db.doc('statpack_logs/l3').set({ packId: 'p1', action: 'checkin', timestamp: T('2026-09-02T10:00:00Z'),
    checkEntries: [{ id: 'a', expirationDate: { ...SEC_E } }, { id: 'b', expirationDate: null }] });            // R1
  await db.doc('statpack_logs/l4').set({ packId: 'p1', action: 'content_edit', timestamp: SENT(),
    clientTimestamp: T('2026-08-08T08:08:08Z') });                                                              // R3, createTime wins
  await db.doc('statpack_logs/l5').set({ packId: 'p1', action: 'content_edit' });                               // R3 (missing)
  await db.doc('statpack_logs/l6').set({ packId: 'p1', action: 'x', clientTimestamp: T('2026-08-09T00:00:00Z') }); // untouched
  await db.doc('statpack_logs/l7').set({ packId: 'p1', action: 'y', timestamp: T('2026-09-03T10:00:00Z'),
    meta: { x: SENT() } });                                                                                     // reported only
}

function run(extra) {
  const r = spawnSync('node', [path.join(__dirname, '../repair-statpack-dates.cjs'), ...extra], { encoding: 'utf8', env: process.env });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
async function snapAll() {
  const out = {};
  for (const c of ['statpacks', 'statpack_logs']) {
    for (const d of (await db.collection(c).get()).docs) {
      out[`${c}/${d.id}`] = { data: d.data(), updateTime: d.updateTime, createTime: d.createTime };
    }
  }
  return out;
}
const eq = (a, b, m) => {
  assert.ok(a instanceof Timestamp, `${m}: not a Timestamp (${JSON.stringify(a)})`);
  assert.ok(a.isEqual(b), `${m}: got ${a.toDate().toISOString()} want ${b.toDate().toISOString()}`);
};
const isSec = (v) => v && typeof v === 'object' && !(v instanceof Timestamp) && Object.keys(v).length === 2 && 'seconds' in v && 'nanoseconds' in v && typeof v.seconds === 'number';
const isSent = (v) => v && typeof v === 'object' && !(v instanceof Timestamp) && '_methodName' in v;
/** Deep compare before/after; where before was a repairable map/sentinel, after must be a Timestamp (checked elsewhere). */
function same(b, a, p) {
  if (isSent(b)) return assert.ok(a instanceof Timestamp, `${p}: sentinel not repaired`);
  if (isSec(b)) { eq(a, new Timestamp(b.seconds, b.nanoseconds), p); return; }
  if (b instanceof Timestamp) { eq(a, b, p); return; }
  if (Array.isArray(b)) {
    assert.ok(Array.isArray(a) && a.length === b.length, `${p}: array shape`);
    b.forEach((x, i) => same(x, a[i], `${p}[${i}]`)); return;
  }
  if (b && typeof b === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${p}: keys changed`);
    for (const k of Object.keys(b)) same(b[k], a[k], `${p}.${k}`); return;
  }
  assert.deepStrictEqual(a, b, p);
}

(async () => {
  await seed();
  const before = await snapAll();
  // sanity: the seed really stored maps, not Timestamps
  assert.ok(!(before['statpacks/p1'].data.lastAuditAt instanceof Timestamp), 'seed stored a Timestamp, not a map');
  assert.deepStrictEqual(before['statpacks/p1'].data.updatedAt, { _methodName: 'serverTimestamp' });

  console.log('--- DRY RUN ---');
  const dry = run([]);
  console.log(dry);
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /EMULATOR/);
  assert.match(dry, /statpacks: docs=3 docsChanged=2 R1=4 R2=4 R3=0 reported=0/);
  assert.match(dry, /statpack_logs: docs=7 docsChanged=4 R1=1 R2=0 R3=3 reported=1/);
  assert.match(dry, /TOTAL CHANGES: 12 \(dry-run/);
  assert.match(dry, /statpacks\/p1 meta\.stamp: .*\[R2\] \(non-standard path\)/);
  assert.match(dry, /statpack_logs\/l7 meta\.x: broken sentinel/);
  const afterDry = await snapAll();
  for (const k of Object.keys(before)) {
    assert.deepStrictEqual(afterDry[k].data, before[k].data, `dry run changed ${k}`);
    assert.ok(afterDry[k].updateTime.isEqual(before[k].updateTime), `dry run wrote ${k}`);
  }

  console.log('--- APPLY ---');
  const app = run(['--apply']);
  console.log(app);
  assert.match(app, /TOTAL CHANGES: 12 \(applied\)/);
  assert.match(app, /committed batch of 6 write\(s\)/);

  const after = await snapAll();
  const p1 = after['statpacks/p1'].data;
  const ut = (k) => before[k].updateTime;
  const ct = (k) => before[k].createTime;

  // R1 same instant
  eq(p1.lastAuditAt, new Timestamp(SEC_A.seconds, SEC_A.nanoseconds), 'R1 lastAuditAt');
  eq(p1.readyOverride.at, new Timestamp(SEC_B.seconds, SEC_B.nanoseconds), 'R1 readyOverride.at');
  eq(p1.contents[0].expirationDate, new Timestamp(SEC_C.seconds, SEC_C.nanoseconds), 'R1 contents[0]');
  eq(p1.contents[4].batches[0].expirationDate, new Timestamp(SEC_D.seconds, SEC_D.nanoseconds), 'R1 nested batch');
  eq(after['statpack_logs/l3'].data.checkEntries[0].expirationDate, new Timestamp(SEC_E.seconds, SEC_E.nanoseconds), 'R1 log checkEntries');
  // R2 == updateTime at scan (before == scan time: dry run wrote nothing)
  eq(p1.updatedAt, ut('statpacks/p1'), 'R2 updatedAt');
  eq(p1.contentsUpdatedAt, ut('statpacks/p1'), 'R2 contentsUpdatedAt');
  eq(p1.meta.stamp, ut('statpacks/p1'), 'R2 meta.stamp');
  eq(after['statpacks/p3'].data.updatedAt, ut('statpacks/p3'), 'R2 p3');
  // R3 == createTime
  for (const l of ['l1', 'l4', 'l5']) eq(after[`statpack_logs/${l}`].data.timestamp, ct(`statpack_logs/${l}`), `R3 ${l}`);
  assert.ok(after['statpack_logs/l4'].data.clientTimestamp.isEqual(T('2026-08-08T08:08:08Z')), 'clientTimestamp preserved');
  // untouched shapes
  assert.deepStrictEqual(p1.lookalikes, before['statpacks/p1'].data.lookalikes);
  assert.deepStrictEqual(after['statpack_logs/l7'].data.meta, { x: { _methodName: 'serverTimestamp' } });
  assert.ok(!('timestamp' in after['statpack_logs/l6'].data), 'l6 got a timestamp');
  // everything else identical, and untouched docs not written at all
  for (const k of Object.keys(before)) {
    const a = { ...after[k].data };
    if (k === 'statpack_logs/l5') delete a.timestamp; // the only key the script adds (R3 on a missing timestamp)
    if (k === 'statpack_logs/l7') assert.deepStrictEqual(a, before[k].data, 'l7 changed'); // report-only sentinel stays
    else same(before[k].data, a, k);
  }
  for (const k of ['statpacks/p2', 'statpack_logs/l2', 'statpack_logs/l6', 'statpack_logs/l7']) {
    assert.ok(after[k].updateTime.isEqual(before[k].updateTime), `${k} was written but should not be`);
  }

  console.log('--- IDEMPOTENCY RERUN (apply) ---');
  const again = run(['--apply']);
  console.log(again);
  assert.match(again, /TOTAL CHANGES: 0 \(applied\)/);
  const finalSnap = await snapAll();
  for (const k of Object.keys(after)) {
    assert.deepStrictEqual(finalSnap[k].data, after[k].data, `second run modified ${k}`);
    assert.ok(finalSnap[k].updateTime.isEqual(after[k].updateTime), `second run wrote ${k}`);
  }

  console.log('REHEARSAL PASSED');
  process.exit(0);
})().catch((e) => { console.error('REHEARSAL FAILED', e); process.exit(1); });
