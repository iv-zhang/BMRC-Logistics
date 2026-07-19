/**
 * Write helpers for the restock front-shelf pool.
 *
 * Refilling a shelf pulls units from the back-room RESERVE pool
 * (`computeBagStock(item).availableItems`, via `consumeReserveUnits`) and
 * stages them on the FRONT shelf pool (`InventoryItem.shelfQuantity`) —
 * "everything on shelves is considered used" until an audit reconciles it.
 * Mirrors the triple-write pattern from `app/lib/audit-actions.ts`: the
 * inventory change itself, an `inventory_logs` row, and (when a restock
 * category is known) the category's accountability stamp.
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
}

export interface RefillShelfResult {
  consumed: number;
}

/**
 * Refill the front restock shelf from back-room reserve. Computes how many
 * units reserve can actually supply (`consumeReserveUnits`), then in one
 * atomic batch: decrements reserve (the computed patch), increments
 * `shelfQuantity` by the same amount, writes an `inventory_logs` row, writes
 * a `restock_shelf_events` row, and — if a restock category is known —
 * stamps that category's per-item accountability record.
 *
 * Throws if reserve has nothing to give (`consumed <= 0`); never writes
 * anything in that case.
 */
export async function refillShelf(params: RefillShelfParams): Promise<RefillShelfResult> {
  const { item, qty, categoryId, shelfId, actor } = params;
  const { patch, consumed } = consumeReserveUnits(item, qty);

  if (consumed <= 0) {
    throw new Error('No reserve stock available to refill from');
  }

  const batch = writeBatch(db);

  batch.update(doc(db, 'inventory', item.id), {
    ...patch,
    shelfQuantity: increment(consumed),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(collection(db, 'inventory_logs')), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'refill_shelf',
    quantityChange: -consumed,
    source: 'restock',
    actor,
    note: 'Refilled front shelf from reserve',
    createdAt: serverTimestamp(),
  }));

  batch.set(doc(collection(db, 'restock_shelf_events')), {
    shelfId: shelfId ?? null,
    itemId: item.id,
    note: 'Refill (reserve→shelf)',
    qty: consumed,
    createdAt: serverTimestamp(),
  });

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
