/**
 * INV-10 — Class-consumable draws and field/event draws decrement their own
 * pools; neither silently depletes the other.
 *
 * The app has no pool axis (BLOCKER B-2). The seed models field vs class as two
 * SEPARATE inventory docs, so a class draw cannot touch field stock — but only
 * because an admin manually split them, not because the model enforces pools.
 * Real path: consumeBox on the class-glove doc.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { consumeBox } from '@/app/lib/inventory';

defineInvariant('INV-10', 'Class draws do not deplete the field pool', async (t) => {
  const fieldBefore = (await getInventory(IDS.glovesField)).unopenedBoxes;

  // Draw 2 boxes of gloves for a class from the class pool.
  // (notes must be non-undefined: consumeBox writes it straight to a log doc and
  //  the Firestore SDK rejects undefined — see FINDINGS.)
  await consumeBox(IDS.glovesClass, 2, { userId: 'fto-1', userName: 'Frankie', notes: 'class draw' });

  const fieldAfter = (await getInventory(IDS.glovesField)).unopenedBoxes;
  t.equal(fieldAfter, fieldBefore, 'field/event glove stock is unchanged by a class draw');

  // The concept the invariant actually requires: pools of ONE sku, enforced.
  const field = await getInventory(IDS.glovesField);
  const cls = await getInventory(IDS.glovesClass);
  t.ok(field.name === cls.name && field.pool !== cls.pool,
    'field and class are enforced pools of the SAME SKU',
    'ABSENT: modeled as two separate docs with different names; no pool axis on a single SKU (B-2)');
});
