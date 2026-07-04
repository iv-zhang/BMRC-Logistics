/**
 * INV-3 — Receiving a new lot of an existing SKU creates a DISTINCT lot; it
 * never overwrites another lot's quantity or exp date.
 *
 * Exercises the REAL receive path: app/lib/audit-actions.ts → addShipment.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { addShipment } from '@/app/lib/audit-actions';

defineInvariant('INV-3', 'Second lot does not overwrite the first', async (t) => {
  const before = await getInventory(IDS.epi);
  const lotABefore = before.batches.find((b: any) => b.id === IDS.epiLotA);
  const lotAExp = new Date(lotABefore.expirationDate).getTime();
  const nBatchesBefore = before.batches.length;
  t.note(`epi starts with ${nBatchesBefore} lots; lot A exp = ${lotABefore.expirationDate}`);

  // Receive a THIRD Bound Tree epi lot with a different expiration date.
  await addShipment(
    before,
    { qty: 4, perUnit: 1, lotNumber: 'BT-EPI-C', expirationMonth: '2028-01', supplier: 'Bound Tree' },
    { uid: 'fto-1', name: 'Frankie FTO' },
  );

  const after = await getInventory(IDS.epi);
  const lotAAfter = after.batches.find((b: any) => b.id === IDS.epiLotA);
  const lotC = after.batches.find((b: any) => b.lotNumber === 'BT-EPI-C');

  t.ok(after.batches.length === nBatchesBefore + 1, 'a NEW distinct lot was appended (count +1)',
    `expected ${nBatchesBefore + 1}, got ${after.batches.length}`);
  t.ok(!!lotC, 'the new lot BT-EPI-C exists');
  t.ok(!!lotAAfter, 'lot A still exists after receiving lot C');
  t.ok(lotAAfter && new Date(lotAAfter.expirationDate).getTime() === lotAExp,
    "lot A's expiration date is UNCHANGED", `lot A exp changed to ${lotAAfter?.expirationDate}`);
  t.ok(lotAAfter && lotAAfter.stock === lotABefore.stock,
    "lot A's stock is UNCHANGED", `lot A stock changed to ${lotAAfter?.stock}`);
  t.ok(lotC && new Date(lotC.expirationDate).getTime() !== lotAExp,
    'the new lot carries its OWN (different) expiration date');
});
