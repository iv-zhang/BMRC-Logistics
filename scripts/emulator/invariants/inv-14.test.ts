/**
 * INV-14 — `refillShelf` CONSERVES units: it is a transfer between the two
 * stock pools, never a creation or destruction of stock. The reserve pool's
 * decrease must always equal the front shelf pool's increase.
 *
 * Real path: app/lib/restock-actions.ts → refillShelf (writes through the
 * real Firestore client), verified via the real reserveUnits/shelfUnits
 * readers (app/lib/stock-pools.ts) against actual seeded inventory (epi:
 * bag-tracked, two lots, reserve = 16 at seed time).
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { refillShelf } from '@/app/lib/restock-actions';
import { reserveUnits, shelfUnits } from '@/app/lib/stock-pools';

defineInvariant('INV-14', 'refillShelf conserves units — reserve decrease equals shelf increase', async (t) => {
  const before = await getInventory(IDS.epi);
  const reserveBefore = reserveUnits(before);
  const shelfBefore = shelfUnits(before);
  t.note(`reserve before ${reserveBefore}, shelf before ${shelfBefore}`);

  const { consumed } = await refillShelf({
    item: before,
    qty: 5,
    actor: { id: 'member-1', name: 'Morgan' },
  });
  t.ok(consumed === 5, 'reserve had enough to fully satisfy the requested transfer', `consumed was ${consumed}`);

  const after = await getInventory(IDS.epi);
  const reserveAfter = reserveUnits(after);
  const shelfAfter = shelfUnits(after);
  t.note(`reserve after ${reserveAfter}, shelf after ${shelfAfter}`);

  t.equal(reserveBefore - reserveAfter, shelfAfter - shelfBefore,
    'reserve decrease equals shelf increase — refillShelf never creates or destroys stock');
  t.equal(shelfAfter - shelfBefore, consumed,
    'shelf increase equals units actually consumed from reserve (the reported `consumed`)');

  // A second refill for more than remaining reserve can supply must still
  // conserve — it clamps to what's available rather than over-crediting the
  // shelf with phantom units.
  const remainingReserve = reserveAfter;
  const before2 = after;
  const { consumed: consumed2 } = await refillShelf({
    item: before2,
    qty: remainingReserve + 100,
    actor: { id: 'member-1', name: 'Morgan' },
  });
  t.equal(consumed2, remainingReserve, 'an over-request clamps to exactly what reserve had left');

  const after2 = await getInventory(IDS.epi);
  t.equal(reserveUnits(after2), 0, 'reserve is fully drained, never negative');
  t.equal(shelfUnits(after2) - shelfUnits(before2), consumed2,
    'conservation still holds on the clamped transfer');
});
