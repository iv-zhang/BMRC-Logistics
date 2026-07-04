/**
 * INV-8 — Statpack service-ready is DERIVED and CONSERVATIVE: true only if no
 * expired lot AND no recalled lot AND every SKU ≥ par AND AED battery+pads
 * current AND glucometer control test passed within interval. Any unknown input
 * → not ready.
 *
 * Real path: app/lib/inventory.ts → logStatpackCheckOff → deriveStatus (which
 * writes Statpack.status) + assessPackHazards (recall + asset currency, read from
 * the backing inventory). Each hazard is introduced in ISOLATION (resetClean
 * restores a genuinely clean baseline first) so each check proves exactly one
 * mechanism and still FAILS if the unsafe/optimistic behavior returns.
 */
import { defineInvariant, getPack, db, IDS } from '../harness';
import { doc, updateDoc } from 'firebase/firestore';
import { logStatpackCheckOff } from '@/app/lib/inventory';

const DAY = 864e5;
const PAST = new Date(Date.now() - 10 * DAY);
const LAPSED = new Date(Date.now() - 45 * DAY); // > 30d glucometer interval
const FUTURE = (n: number) => new Date(Date.now() + n * DAY);
const goodEntry = { itemId: IDS.gauze, requiredQuantity: 20, countedQuantity: 20, ok: true, pocket: 'main' as const };

async function audit(entries: any[], sharps?: { status: 'ok' | 'full' | 'na' }) {
  await logStatpackCheckOff({
    statpackId: IDS.packMRC1,
    statpackName: 'MRC1 Primary',
    action: 'audit',
    userId: 'admin-1',
    userName: 'Quinn',
    userRole: 'quartermaster',
    checkEntries: entries as any,
    sharpsCheck: sharps,
  });
  return (await getPack(IDS.packMRC1)).status as string;
}

/**
 * Restore a genuinely clean baseline: fresh glucometer control test, un-expired
 * AED pads, and two clean (sealed, future-dated) epi lots. The seed intentionally
 * ships the glucometer lapsed (for case 4), so the positive control must reset it.
 */
async function resetClean() {
  await updateDoc(doc(db, 'inventory', IDS.glucometer), {
    controlTest: { lastPassedAt: new Date(), intervalDays: 30, lastResult: 'pass' },
  });
  await updateDoc(doc(db, 'inventory', IDS.aed), { padExpiration: FUTURE(400) });
  await updateDoc(doc(db, 'inventory', IDS.epi), {
    batches: [
      { id: IDS.epiLotA, status: 'sealed', stock: 10, bagCount: 10, itemsPerBag: 1, lotNumber: 'BT-EPI-A', expirationDate: FUTURE(240) },
      { id: IDS.epiLotB, status: 'sealed', stock: 6, bagCount: 6, itemsPerBag: 1, lotNumber: 'BT-EPI-B', expirationDate: FUTURE(120) },
    ],
  });
}

defineInvariant('INV-8', 'Readiness is derived and conservative', async (t) => {
  // Positive control: a genuinely clean audit derives Ready.
  await resetClean();
  t.equal(await audit([goodEntry]), 'Ready', 'clean audit derives status = Ready');

  // (1) expired lot entered → not Ready
  await resetClean();
  const s1 = await audit([goodEntry,
    { itemId: IDS.epi, batchId: IDS.epiLotA, requiredQuantity: 2, countedQuantity: 2, ok: false, expirationDate: PAST }]);
  t.ok(s1 !== 'Ready', 'expired item flips readiness false', `status stayed '${s1}'`);

  // (2) below-par consumable → not Ready
  await resetClean();
  const s2 = await audit([{ itemId: IDS.gauze, requiredQuantity: 20, countedQuantity: 5, ok: false, pocket: 'main' }]);
  t.ok(s2 !== 'Ready', 'below-par (short) item flips readiness false', `status stayed '${s2}'`);

  // (3) sharps container full → not Ready
  await resetClean();
  const s3 = await audit([goodEntry], { status: 'full' });
  t.ok(s3 !== 'Ready', 'sharps-full flips readiness false', `status stayed '${s3}'`);

  // (4) glucometer control test lapsed (45d ago, 30d interval) → not Ready
  await resetClean();
  await updateDoc(doc(db, 'inventory', IDS.glucometer), {
    controlTest: { lastPassedAt: LAPSED, intervalDays: 30, lastResult: 'pass' },
  });
  const s4 = await audit([goodEntry]);
  t.ok(s4 !== 'Ready', 'lapsed glucometer control test flips readiness false',
    `status is '${s4}' — readiness must consult glucometer control-test currency`);

  // (5) AED pads expired in inventory → not Ready
  await resetClean();
  await updateDoc(doc(db, 'inventory', IDS.aed), { padExpiration: PAST });
  const s5 = await audit([goodEntry]); // no AED expiry entered by member
  t.ok(s5 !== 'Ready', 'expired AED pads flip readiness false',
    `status is '${s5}' — readiness must consult inventory-side AED component expiry`);

  // (6) recalled/quarantined lot present → not Ready
  await resetClean();
  await updateDoc(doc(db, 'inventory', IDS.epi), {
    batches: [{ id: IDS.epiLotA, status: 'quarantined', stock: 10, bagCount: 10, itemsPerBag: 1, lotNumber: 'BT-EPI-A', expirationDate: FUTURE(240) }],
  });
  const s6 = await audit([goodEntry]);
  t.ok(s6 !== 'Ready', 'recalled/quarantined lot flips readiness false',
    `status is '${s6}' — readiness must consult recall state`);

  // (7) unknown input (required consumable submitted uncounted) → not Ready
  await resetClean();
  const s7 = await audit([{ itemId: IDS.epi, requiredQuantity: 2, countedQuantity: null, ok: false, pocket: 'main' }]);
  t.ok(s7 !== 'Ready', 'unknown/uncounted input fails safe to not-ready',
    `status is '${s7}' — unknown input must force not-ready`);
});
