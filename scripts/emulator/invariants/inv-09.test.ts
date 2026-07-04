/**
 * INV-9 — A SKU below par appears on the buy list ONCE; re-triggering while
 * already on the list / on order does not create a duplicate.
 *
 * The dedup guard lives in app/lib/buy-list.ts (`addToBuyList`), which the UI's
 * add path now calls. We invoke it twice for the same linked SKU and assert a
 * single open order results. If the dedup guard regresses this MUST fail (two
 * open entries for the SKU).
 */
import { defineInvariant, db, IDS } from '../harness';
import { addToBuyList } from '@/app/lib/buy-list';
import { collection, getDocs, query, where } from 'firebase/firestore';

async function triggerReorder() {
  // Mirrors the UI's add path (addToBuyList) with a linked item below par.
  await addToBuyList(
    {
      itemName: '2x2 Gauze',
      linkedInventoryId: IDS.gauze,
      quantity: 2,
      unit: 'boxes',
      priority: 'medium',
    },
    { uid: 'system', name: 'System' },
  );
}

defineInvariant('INV-9', 'Below-par SKU appears on buy list only once', async (t) => {
  await triggerReorder();
  await triggerReorder(); // same SKU still below par → must NOT duplicate

  const snap = await getDocs(query(
    collection(db, 'buyList'),
    where('linkedInventoryId', '==', IDS.gauze),
    where('status', 'in', ['pending', 'ordered']),
  ));
  t.equal(snap.size, 1, 'exactly ONE open buy-list entry for the SKU after two triggers');
});
