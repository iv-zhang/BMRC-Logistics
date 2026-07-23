/**
 * INV-15 — A weekly shelf CHECK (`observedShelfQty` provided, `qty: 0`, no
 * transfer requested) re-anchors `shelfQuantity` to the observed count and
 * NEVER touches the reserve pool — even when the observed count is lower
 * than what was on record (i.e. more was used off the shelf than any refill
 * event captured, which is exactly the untracked-consumption case this
 * model exists to reconcile).
 *
 * Real path: app/lib/restock-actions.ts → refillShelf with observedShelfQty.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { refillShelf } from '@/app/lib/restock-actions';
import { reserveUnits, shelfUnits } from '@/app/lib/stock-pools';

defineInvariant('INV-15', 'A shelf check with a lower observed count re-anchors the shelf without touching reserve', async (t) => {
  const item0 = await getInventory(IDS.epi);

  // Stage 5 units on the shelf first via a normal refill.
  await refillShelf({ item: item0, qty: 5, actor: { id: 'member-1', name: 'Morgan' } });
  const staged = await getInventory(IDS.epi);
  t.ok(shelfUnits(staged) === 5, 'shelf staged to 5 units before the check', `shelf is ${shelfUnits(staged)}`);
  const reserveBeforeCheck = reserveUnits(staged);

  // Weekly check: only 2 are actually observed on the shelf (someone used 3
  // without logging it) — no reserve transfer requested.
  const { consumed } = await refillShelf({
    item: staged,
    qty: 0,
    observedShelfQty: 2,
    actor: { id: 'member-2', name: 'Casey' },
  });
  t.ok(consumed === 0, 'a check-only re-anchor (qty:0) does not throw and consumes nothing', `consumed was ${consumed}`);

  const after = await getInventory(IDS.epi);
  t.equal(reserveUnits(after), reserveBeforeCheck, 'reserve pool is completely untouched by the check');
  t.equal(shelfUnits(after), 2, 'shelfQuantity is re-anchored DOWN to the observed (lower) count, not left at the stale 5');
  t.ok(!!after.lastShelfCheckAt, 'lastShelfCheckAt is stamped by the check', `lastShelfCheckAt: ${after.lastShelfCheckAt}`);
  t.equal(after.lastShelfCheckBy, 'Casey', 'lastShelfCheckBy records who performed the check');

  // A check-only call with qty:0 and NO observedShelfQty must still behave
  // like today's plain (non-reanchoring) refill request and reject, since
  // there is nothing to consume and no observed count to record.
  await t.rejects(
    refillShelf({ item: after, qty: 0, actor: { id: 'member-2', name: 'Casey' } }),
    'qty:0 with no observedShelfQty is refused (not a valid check, not a valid transfer)',
  );
});
