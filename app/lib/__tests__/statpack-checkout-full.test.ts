/**
 * Integration test (Firestore emulator): D-8 amendment 2026-11-03.
 * Checkout requires a full, in-date pack (Acknowledge can't wave it through),
 * check-in still only flags, acknowledgements file issue reports, the crew's
 * AED check counts as the device check, and an overdue glucometer control
 * test blocks checkout until logistics records a pass.
 * Run:  npm run test:checkout-full
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs, query, setDoc, terminate, where, Timestamp } from 'firebase/firestore';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('../../../scripts/emulator/guard');
const { db } = await import('../../../firebase');
const { logStatpackCheckOff } = await import('../inventory');
const { recordControlTest } = await import('../asset-checks');

const run = `${Date.now()}`;
let seq = 0;
const member = { uid: 'member-1', name: 'Test Member' };
const DAY = 86_400_000;

async function seedPack(contents: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const id = `checkout-full-${run}-${++seq}`;
  await setDoc(doc(db, 'statpacks', id), {
    name: `Pack ${seq}`, type: 'Primary', status: 'Ready', isCheckedOut: false, contents, ...extra,
  });
  return id;
}

type Entry = Parameters<typeof logStatpackCheckOff>[0]['checkEntries'][number];
const entry = (itemId: string, required: number, counted: number, extra: Partial<Entry> = {}): Entry => ({
  itemId, itemName: itemId, requiredQuantity: required, countedQuantity: counted, ok: counted >= required, ...extra,
});

function checkOff(id: string, action: 'checkout' | 'checkin', checkEntries: Entry[], extra: Record<string, unknown> = {}) {
  return logStatpackCheckOff({
    statpackId: id, statpackName: `Pack ${id}`, action,
    userId: member.uid, userName: member.name, userRole: 'member',
    checkEntries, ...extra,
  } as Parameters<typeof logStatpackCheckOff>[0]);
}

async function packOf(id: string) {
  return (await getDoc(doc(db, 'statpacks', id))).data()!;
}

async function reportsFor(id: string) {
  const snap = await getDocs(query(collection(db, 'issue_reports'), where('target.docId', '==', id)));
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

after(async () => { await terminate(db); });

describe('checkout requires a full, in-date pack', () => {
  it('a short consumable blocks checkout and the pack stays home', async () => {
    const gauze = `gauze-${run}-a`;
    const id = await seedPack([{ itemId: gauze, requiredQuantity: 2, currentQuantity: 1 }]);
    await assert.rejects(checkOff(id, 'checkout', [entry(gauze, 2, 1)]), /to par/);
    const saved = await packOf(id);
    assert.equal(saved.isCheckedOut, false);
    assert.equal(saved.status, 'Ready');
  });

  it('acknowledging a shortage does not wave it through at checkout', async () => {
    const gauze = `gauze-${run}-b`;
    const id = await seedPack([{ itemId: gauze, requiredQuantity: 2, currentQuantity: 0 }]);
    await assert.rejects(
      checkOff(id, 'checkout', [entry(gauze, 2, 0, { acknowledged: true, acknowledgeReason: 'none on shelf' })]),
      /to par/,
    );
    assert.equal((await packOf(id)).isCheckedOut, false);
  });

  it('an expired item blocks checkout', async () => {
    const epi = `epi-${run}-c`;
    const id = await seedPack([{ itemId: epi, requiredQuantity: 1, currentQuantity: 1 }]);
    await assert.rejects(
      checkOff(id, 'checkout', [entry(epi, 1, 1, { expirationDate: new Date(Date.now() - 30 * DAY) })]),
      /expired/i,
    );
  });

  it('a full pack checks out', async () => {
    const gauze = `gauze-${run}-d`;
    const id = await seedPack([{ itemId: gauze, requiredQuantity: 2, currentQuantity: 2 }]);
    await checkOff(id, 'checkout', [entry(gauze, 2, 2)]);
    const saved = await packOf(id);
    assert.equal(saved.isCheckedOut, true);
    assert.equal(saved.status, 'In Use');
  });
});

describe('check-in still flags, and acknowledgements become reports', () => {
  it('a short check-in succeeds and the acknowledgement files an issue report', async () => {
    const gauze = `gauze-${run}-e`;
    const id = await seedPack([{ itemId: gauze, requiredQuantity: 2, currentQuantity: 2 }], {
      status: 'In Use', isCheckedOut: true, assignedToUserId: member.uid,
    });
    const res = await checkOff(id, 'checkin', [entry(gauze, 2, 1, { acknowledged: true, acknowledgeReason: 'used on a call' })]);
    assert.equal(res.reportFailures, 0);
    const saved = await packOf(id);
    assert.equal(saved.isCheckedOut, false);
    const reports = await reportsFor(id);
    assert.equal(reports.length, 1);
    assert.match(String(reports[0].title), /^Acknowledged: /);
    assert.match(String(reports[0].description), /used on a call/);
  });
});

describe('device currency', () => {
  it("the crew's AED check clears a stale inventory check and is written back", async () => {
    const aed = `aed-${run}`;
    await setDoc(doc(db, 'inventory', aed), {
      name: 'AED', isAsset: true, assetCategory: 'AED',
      assetLastChecked: Timestamp.fromMillis(Date.now() - 90 * DAY),
    });
    const contents = [{ itemId: aed, requiredQuantity: 1, currentQuantity: 1, serialNumber: 'AED-1' }];
    const inUse = { status: 'In Use', isCheckedOut: true, assignedToUserId: member.uid };

    // Without a fresh check the stale stamp still marks the pack not ready.
    const stale = await seedPack(contents, inUse);
    await checkOff(stale, 'checkin', [entry(aed, 1, 1, { serialNumber: 'AED-1' })]);
    assert.equal((await packOf(stale)).status, 'Restock Needed');

    // With this pass's completed AED check it is current, and the stamp is refreshed.
    const pads = new Date(Date.now() + 365 * DAY);
    const fresh = await seedPack(contents, inUse);
    await checkOff(fresh, 'checkin', [entry(aed, 1, 1, { serialNumber: 'AED-1' })], {
      freshDeviceChecks: [{ itemId: aed, padExpiration: pads }],
    });
    assert.equal((await packOf(fresh)).status, 'Ready');
    const inv = (await getDoc(doc(db, 'inventory', aed))).data()!;
    assert.ok((inv.assetLastChecked as Timestamp).toMillis() > Date.now() - DAY);
    assert.equal((inv.padExpiration as Timestamp).toMillis(), pads.getTime());
  });

  it('an overdue glucometer control test blocks checkout until a pass is recorded', async () => {
    const gluco = `glucometer-${run}`;
    await setDoc(doc(db, 'inventory', gluco), {
      name: 'Glucometer', isAsset: true, controlTest: { intervalDays: 30 },
    });
    const id = await seedPack([{ itemId: gluco, requiredQuantity: 1, currentQuantity: 1, serialNumber: 'G-1' }]);
    const entries = [entry(gluco, 1, 1, { serialNumber: 'G-1' })];
    await assert.rejects(checkOff(id, 'checkout', entries), /Glucometer control test is overdue/);

    await recordControlTest({ id: gluco, name: 'Glucometer' }, 'pass', { uid: 'qm-1', name: 'Test QM' });
    await checkOff(id, 'checkout', entries);
    assert.equal((await packOf(id)).status, 'In Use');
  });
});
