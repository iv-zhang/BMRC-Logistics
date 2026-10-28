/**
 * Rehearsal for scripts/normalize-expiration-months.cjs. EMULATOR ONLY.
 * Run: npx firebase emulators:exec --config firebase.emulator.json --only firestore \
 *        --project demo-bmrc-logistics "node scripts/emulator/rehearse-expiration-months.cjs"
 */
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-bmrc-logistics') {
  console.error('Refusing: must run under the emulator with project demo-bmrc-logistics.'); process.exit(1);
}
const admin = require('firebase-admin');
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
admin.initializeApp({ projectId: 'demo-bmrc-logistics' });
const db = admin.firestore();
const { Timestamp } = admin.firestore;
const T = (iso) => Timestamp.fromDate(new Date(iso));

// Instants (PDT = -7, PST = -8)
const A_JUN = T('2027-07-01T06:59:59.999Z');  // 2027-06-30 23:59:59.999 PDT -> Jun 1
const A_FEB_SEC = T('2027-03-01T07:59:59.000Z'); // 2027-02-28 23:59:59.000 PST -> Feb 1
const B_FIRST = T('2027-06-01T00:00:00.000Z');   // -> Jun 1 00:00 PDT
const B_MID = T('2027-12-15T00:00:00.000Z');     // -> Dec 15 00:00 PST
const OK_LA = T('2027-01-01T08:00:00.000Z');     // Jan 1 00:00 PST
const OK_LA_DST = T('2027-07-04T07:00:00.000Z'); // Jul 4 00:00 PDT
const REAL_TIME = T('2027-05-05T18:22:11.123Z');

const E = {
  A_JUN: T('2027-06-01T07:00:00.000Z'),
  A_FEB: T('2027-02-01T08:00:00.000Z'),
  B_FIRST: T('2027-06-01T07:00:00.000Z'),
  B_MID: T('2027-12-15T08:00:00.000Z'),
};

async function seed() {
  await db.doc('statpacks/p1').set({
    name: 'Pack 1', status: 'Ready', extra: { nested: [1, 2, { z: 'q' }] },
    contents: [
      { id: 'c1', name: 'Gauze', requiredQuantity: 2, currentQuantity: 2, expirationDate: A_JUN, note: 'keep' },
      { id: 'c2', name: 'Saline', requiredQuantity: 1, expirationDate: A_FEB_SEC },
      { id: 'c3', name: 'Tape', requiredQuantity: 1, expirationDate: OK_LA },
      { id: 'c4', name: 'NoExp', requiredQuantity: 1 },
      { id: 'c5', name: 'Strung', requiredQuantity: 1, expirationDate: '2027-06-30' },
      { id: 'c6', name: 'Nested', batches: [{ lot: 'L1', expirationDate: B_FIRST, stock: 3 }] },
    ],
  });
  await db.doc('statpacks/p2').set({ name: 'Untouched', contents: [{ id: 'x', expirationDate: OK_LA_DST }], flag: true });
  await db.doc('inventory/i1').set({
    name: 'Epi', totalStockQuantity: 9, unrelated: { a: 1 },
    batches: [
      { id: 'b1', lotNumber: 'X', stock: 4, expirationDate: B_FIRST, receivedAt: T('2026-01-01T10:00:00Z') },
      { id: 'b2', lotNumber: 'Y', stock: 5, expirationDate: B_MID },
      { id: 'b3', stock: 0, expirationDate: REAL_TIME },
      { id: 'b4', stock: 1, expirationDate: null },
    ],
    expirationDate: A_JUN,
  });
  await db.doc('inventory/i2').set({ name: 'Fine', batches: [{ id: 'k', stock: 1, expirationDate: OK_LA_DST }], padExpiration: B_FIRST });
}

function run(extra) {
  const r = spawnSync('node', [path.join(__dirname, '../normalize-expiration-months.cjs'), ...extra], { encoding: 'utf8', env: process.env });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const snapAll = async () => {
  const out = {};
  for (const c of ['statpacks', 'inventory']) for (const d of (await db.collection(c).get()).docs) out[`${c}/${d.id}`] = d.data();
  return out;
};
const eq = (a, b, m) => assert.ok(a.isEqual(b), `${m}: got ${a.toDate().toISOString()} want ${b.toDate().toISOString()}`);

(async () => {
  await seed();
  const before = await snapAll();

  console.log('--- DRY RUN ---');
  const dry = run([]);
  console.log(dry);
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /statpacks: docs=2 docsChanged=1 ruleA=2 ruleB=1 unchanged=2 unrecognized=0 otherShapes=1/);
  assert.match(dry, /inventory: docs=2 docsChanged=1 ruleA=1 ruleB=2 unchanged=1 unrecognized=1 otherShapes=0/);
  assert.match(dry, /TOTAL CHANGES: 6 \(dry-run/);
  assert.match(dry, /statpacks\/p1 contents\[4\]\.expirationDate: string/);
  assert.deepStrictEqual(await snapAll(), before, 'dry run wrote something');

  console.log('--- REFUSAL without emulator is covered by design; APPLY ---');
  const app = run(['--apply']);
  console.log(app);
  assert.match(app, /TOTAL CHANGES: 6 \(applied\)/);

  const after = await snapAll();
  const p1 = after['statpacks/p1'], i1 = after['inventory/i1'];
  eq(p1.contents[0].expirationDate, E.A_JUN, 'A Jun');
  eq(p1.contents[1].expirationDate, E.A_FEB, 'A Feb');
  eq(p1.contents[2].expirationDate, OK_LA, 'ok');
  assert.strictEqual(p1.contents[4].expirationDate, '2027-06-30');
  eq(p1.contents[5].batches[0].expirationDate, E.B_FIRST, 'B nested 1st');
  eq(i1.batches[0].expirationDate, E.B_FIRST, 'B 1st');
  eq(i1.batches[1].expirationDate, E.B_MID, 'B mid');
  eq(i1.batches[2].expirationDate, REAL_TIME, 'real time untouched');
  assert.strictEqual(i1.batches[3].expirationDate, null);
  eq(i1.expirationDate, E.A_JUN, 'inventory top-level A');

  // Everything other than the changed expirationDate values must be identical.
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'expirationDate' ? '<exp>' : v && v._seconds !== undefined ? { s: v._seconds, n: v._nanoseconds } : v));
  for (const k of Object.keys(before)) assert.strictEqual(strip(after[k]), strip(before[k]), `non-expiration fields changed in ${k}`);
  assert.deepStrictEqual(after['statpacks/p2'], before['statpacks/p2']);
  assert.deepStrictEqual(after['inventory/i2'], before['inventory/i2']);
  assert.strictEqual(Object.keys(after['statpacks/p1']).sort().join(), Object.keys(before['statpacks/p1']).sort().join(), 'keys changed');

  console.log('--- IDEMPOTENCY RERUN (apply) ---');
  const again = run(['--apply']);
  console.log(again);
  assert.match(again, /TOTAL CHANGES: 0 \(applied\)/);
  assert.deepStrictEqual(await snapAll(), after, 'second run modified data');

  console.log('REHEARSAL PASSED');
  process.exit(0);
})().catch((e) => { console.error('REHEARSAL FAILED', e); process.exit(1); });
