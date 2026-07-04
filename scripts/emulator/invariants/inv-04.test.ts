/**
 * INV-4 / HR-1 — Every lot of a dated SKU has a non-null exp date; receiving a
 * dated SKU with a blank expiration is blocked/flagged, never stored as
 * effectively never-expiring.
 * Real path: app/lib/audit-actions.ts → addShipment.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { addShipment } from '@/app/lib/audit-actions';

defineInvariant('INV-4', 'Dated SKU cannot receive a lot with no expiration', async (t) => {
  const epi = await getInventory(IDS.epi); // tracksExpiration + requiresExpirationCheck
  t.note(`epi.tracksExpiration=${epi.tracksExpiration}, requiresExpirationCheck=${epi.requiresExpirationCheck}`);

  // Attempt to receive a lot with NO expirationMonth.
  await t.rejects(
    addShipment(epi, { qty: 3, perUnit: 1, lotNumber: 'BT-EPI-NOEXP', supplier: 'Bound Tree' },
      { uid: 'fto-1', name: 'Frankie FTO' }),
    'receiving a dated SKU without an expiration date is refused',
  );

  const after = await getInventory(IDS.epi);
  const noExpLot = after.batches.find((b: any) => b.lotNumber === 'BT-EPI-NOEXP');
  t.ok(!noExpLot || noExpLot.expirationDate,
    'no dated lot was persisted with a missing expiration date',
    noExpLot ? 'a lot with NO expirationDate is now stored (silent never-expires)' : undefined);
});
