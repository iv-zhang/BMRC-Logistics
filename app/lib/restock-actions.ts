/**
 * Write helpers for the restock front-shelf pool.
 *
 * Refilling a shelf pulls units from the back-room RESERVE pool
 * (`computeBagStock(item).availableItems`, via `consumeReserveUnits`) and
 * stages them on the FRONT shelf pool (`InventoryItem.shelfQuantity`).
 *
 * Weekly re-anchor model: front-shelf consumption is deliberately NOT
 * event-tracked — general members won't reliably log every unit they take
 * off the shelf. Instead, roughly weekly someone physically counts what's on
 * the shelf and passes that count as `observedShelfQty`. When present, the
 * write RE-ANCHORS `shelfQuantity` to the observed count (plus whatever was
 * just transferred from reserve) instead of blindly incrementing, and stamps
 * `lastShelfCheckAt`/`lastShelfCheckBy` so `isShelfCheckCurrent()`
 * (`app/lib/item-status.ts`) can tell staleness. A check can also happen with
 * no transfer at all (`qty: 0` + `observedShelfQty` set) to record the count
 * without pulling from reserve. Mirrors the triple-write pattern from
 * `app/lib/audit-actions.ts`: the inventory change itself, an
 * `inventory_logs` row, and (when a restock category is known) the
 * category's accountability stamp.
 */

import {
  collection,
  doc,
  increment,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { consumeReserveUnits } from '@/app/lib/stock-pools';
import type { InventoryItem } from '@/app/types';

export function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  const cleaned = { ...obj } as T;
  (Object.keys(cleaned) as Array<keyof T>).forEach((k) => {
    if (cleaned[k] === undefined) {
      delete (cleaned as Partial<T>)[k];
    }
  });
  return cleaned;
}

export interface RefillShelfParams {
  item: InventoryItem;
  qty: number;
  categoryId?: string;
  shelfId?: string;
  actor: { id?: string; name?: string };
  /**
   * Physical count observed on the shelf during a weekly check. When
   * provided, the write RE-ANCHORS `shelfQuantity` to
   * `observedShelfQty + consumed` (an absolute set, not `increment`) and
   * stamps `lastShelfCheckAt`/`lastShelfCheckBy`, correcting for drift from
   * un-tracked front-shelf consumption. Pass `qty: 0` alongside this to
   * record a check with no transfer at all.
   */
  observedShelfQty?: number;
}

export interface RefillShelfResult {
  consumed: number;
}

/**
 * Refill the front restock shelf from back-room reserve, and/or re-anchor
 * `shelfQuantity` to a physically observed count.
 *
 * - Normal refill (`observedShelfQty` omitted): computes how many units
 *   reserve can actually supply (`consumeReserveUnits`), then in one atomic
 *   batch decrements reserve (the computed patch) and increments
 *   `shelfQuantity` by the amount consumed — unchanged from before.
 * - Weekly re-anchor (`observedShelfQty` provided): same reserve transfer,
 *   but `shelfQuantity` is SET to `observedShelfQty + consumed` instead of
 *   incremented, and `lastShelfCheckAt`/`lastShelfCheckBy` are stamped. The
 *   `inventory_logs` row records the observed count and the implied
 *   consumption since the last check (`previousShelfQuantity -
 *   observedShelfQty`, floored at 0) so front-shelf usage stays derivable
 *   from the ledger even though it isn't event-tracked.
 * - Check with no transfer (`qty: 0` + `observedShelfQty` provided): records
 *   the count and stamps the check fields without touching reserve, and does
 *   NOT throw even though nothing was consumed.
 *
 * Throws `'No reserve stock available to refill from'` when an actual
 * refill was requested (`qty > 0`) but reserve had nothing to give
 * (`consumed <= 0`); never writes anything in that case.
 */
export async function refillShelf(params: RefillShelfParams): Promise<RefillShelfResult> {
  const { item, qty, categoryId, shelfId, actor, observedShelfQty } = params;
  const isReanchor = observedShelfQty !== undefined;
  const isCheckOnly = qty === 0 && isReanchor;

  let patch: Record<string, unknown> = {};
  let consumed = 0;
  if (!isCheckOnly) {
    const result = consumeReserveUnits(item, qty);
    patch = result.patch;
    consumed = result.consumed;
    if (consumed <= 0) {
      throw new Error('No reserve stock available to refill from');
    }
  }

  const batch = writeBatch(db);

  const inventoryUpdate: Record<string, unknown> = {
    ...patch,
    updatedAt: serverTimestamp(),
  };
  if (isReanchor) {
    inventoryUpdate.shelfQuantity = (observedShelfQty as number) + consumed;
    inventoryUpdate.lastShelfCheckAt = serverTimestamp();
    inventoryUpdate.lastShelfCheckBy = actor.name ?? null;
  } else {
    inventoryUpdate.shelfQuantity = increment(consumed);
  }
  batch.update(doc(db, 'inventory', item.id), inventoryUpdate);

  let note = isCheckOnly ? 'Weekly shelf check (no transfer)' : 'Refilled front shelf from reserve';
  if (isReanchor) {
    const previousShelfQuantity = item.shelfQuantity ?? 0;
    const impliedConsumption = Math.max(0, previousShelfQuantity - (observedShelfQty as number));
    note += `; observed ${observedShelfQty} on shelf (implied use since last check: ${impliedConsumption})`;
  }

  batch.set(doc(collection(db, 'inventory_logs')), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'refill_shelf',
    quantityChange: -consumed,
    source: 'restock',
    actor,
    note,
    observedShelfQty,
    createdAt: serverTimestamp(),
  }));

  if (!isCheckOnly) {
    batch.set(doc(collection(db, 'restock_shelf_events')), {
      shelfId: shelfId ?? null,
      itemId: item.id,
      note: 'Refill (reserve→shelf)',
      qty: consumed,
      createdAt: serverTimestamp(),
    });
  }

  if (categoryId) {
    batch.update(doc(db, 'restock_categories', categoryId), {
      [`itemRestocks.${item.id}.at`]: serverTimestamp(),
      [`itemRestocks.${item.id}.byName`]: actor.name ?? null,
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();

  return { consumed };
}
