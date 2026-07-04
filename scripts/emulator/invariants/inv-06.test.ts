/**
 * INV-6 — An expired lot is excluded from AVAILABLE quantity and cannot be
 * counted toward a Statpack in service.
 * Real path: app/lib/item-status.ts → getItemStatus / computeBagStock.
 * After the fix: expiry is still FLAGGED (getItemStatus → 'expired') AND the
 * expired lot is excluded from computeBagStock().availableItems, while
 * computeBagStock().totalItems keeps its PHYSICAL on-hand meaning.
 */
import { defineInvariant, getInventory, db, IDS } from '../harness';
import { doc, updateDoc } from 'firebase/firestore';
import { getItemStatus, computeBagStock } from '@/app/lib/item-status';

defineInvariant('INV-6', 'Expired lot excluded from available quantity', async (t) => {
  const before = await getInventory(IDS.epi);
  const freshAvail = computeBagStock(before).availableItems; // 16 (A:10 + B:6)

  // Expire lot B in place (stock stays 6).
  const batches = before.batches.map((b: any) =>
    b.id === IDS.epiLotB ? { ...b, expirationDate: new Date(Date.now() - 5 * 864e5) } : b);
  await updateDoc(doc(db, 'inventory', IDS.epi), { batches });

  const after = await getInventory(IDS.epi);
  t.equal(getItemStatus(after), 'expired', 'item is FLAGGED expired once a stocked lot is past date');

  const stock = computeBagStock(after);
  // Safety intent: expired units must drop OUT of availability (not merely flagged).
  t.ok(stock.availableItems === freshAvail - 6,
    'expired lot B (6 units) is EXCLUDED from available quantity',
    `availableItems is ${stock.availableItems}; expired stock still counted (expected ${freshAvail - 6})`);
  // totalItems keeps its physical meaning — the units are still on the shelf.
  t.ok(stock.totalItems === freshAvail,
    'totalItems still reflects PHYSICAL on-hand (expired units are still present)',
    `totalItems is ${stock.totalItems} (expected ${freshAvail})`);
});
