/**
 * INV-1 — On-hand ≥ 0; consuming more than on-hand is REFUSED, not underflowed.
 * Real path: app/lib/inventory.ts → consumeBox (guards insufficient stock).
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { consumeBox } from '@/app/lib/inventory';

defineInvariant('INV-1', 'Over-consumption is refused, never underflowed', async (t) => {
  const gauze = await getInventory(IDS.gauze); // box-tracked, 3 unopened boxes
  t.note(`gauze has ${gauze.unopenedBoxes} unopened boxes`);

  await t.rejects(
    consumeBox(IDS.gauze, 5, { userId: 'member-1', userName: 'Morgan' }),
    'opening 5 boxes when only 3 exist is refused',
  );

  const after = await getInventory(IDS.gauze);
  t.ok(after.unopenedBoxes >= 0, 'unopenedBoxes never went negative', `got ${after.unopenedBoxes}`);
  t.ok(after.unopenedBoxes === 3, 'stock unchanged after the refused over-consume', `got ${after.unopenedBoxes}`);
});
