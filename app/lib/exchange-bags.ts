/**
 * Two-bin / exchange-cart "kanban" system.
 *
 * Pre-stocked multi-SKU Exchange Bags (e.g. a bandaid bag, glove kit, paper
 * PCR stack) are staged FULL on a shelf. A crew grabs a full bag and drops
 * the EMPTY. Empties get REFILLED from back-room reserve
 * (`consumeReserveUnits`, see `app/lib/stock-pools.ts`) and re-staged FULL.
 *
 * Collections: `exchange_bags` (one doc per bag design/slot) and
 * `exchange_bag_events` (append-only ledger of swap/refill actions).
 *
 * Mirrors the write style of `app/lib/restock-actions.ts`: `writeBatch`,
 * `increment`, `serverTimestamp`, and an `inventory_logs` row per refill.
 */

import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  increment,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { consumeReserveUnits } from '@/app/lib/stock-pools';
import type { ExchangeBag, InventoryItem } from '@/app/types';

export function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  const cleaned = { ...obj } as T;
  (Object.keys(cleaned) as Array<keyof T>).forEach((k) => {
    if (cleaned[k] === undefined) {
      delete (cleaned as Partial<T>)[k];
    }
  });
  return cleaned;
}

function toDateVal(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const anyV = v as { toDate?: () => Date };
  if (typeof anyV.toDate === 'function') return anyV.toDate();
  return undefined;
}

function hydrateBag(id: string, raw: Record<string, unknown>): ExchangeBag {
  return {
    id,
    name: (raw.name as string) || 'Untitled bag',
    categoryId: raw.categoryId as string | undefined,
    shelfId: raw.shelfId as string | undefined,
    lines: Array.isArray(raw.lines) ? (raw.lines as ExchangeBag['lines']) : [],
    fullCount: typeof raw.fullCount === 'number' ? raw.fullCount : 0,
    emptyCount: typeof raw.emptyCount === 'number' ? raw.emptyCount : 0,
    parBags: raw.parBags as number | undefined,
    createdAt: toDateVal(raw.createdAt),
    updatedAt: toDateVal(raw.updatedAt),
    updatedBy: raw.updatedBy as string | undefined,
  };
}

/** Live subscription to all exchange bags, ordered by name. */
export function subscribeExchangeBags(cb: (bags: ExchangeBag[]) => void): () => void {
  const q = query(collection(db, 'exchange_bags'), orderBy('name'));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => hydrateBag(d.id, d.data())));
  });
}

/** Create (no `id`) or update (with `id`) an exchange bag doc. Returns the id. */
export async function saveExchangeBag(
  patch: Partial<ExchangeBag> & { id?: string },
  actor: { id?: string; name?: string },
): Promise<string> {
  const { id, ...rest } = patch;
  const base = removeUndefined({
    ...rest,
    updatedAt: serverTimestamp(),
    updatedBy: actor.name ?? null,
  });

  if (id) {
    await updateDoc(doc(db, 'exchange_bags', id), base);
    return id;
  }

  const ref = await addDoc(collection(db, 'exchange_bags'), removeUndefined({
    name: rest.name ?? 'Untitled bag',
    categoryId: rest.categoryId,
    shelfId: rest.shelfId,
    lines: rest.lines ?? [],
    fullCount: rest.fullCount ?? 0,
    emptyCount: rest.emptyCount ?? 0,
    parBags: rest.parBags,
    createdAt: serverTimestamp(),
    ...base,
  }));
  return ref.id;
}

export async function deleteExchangeBag(id: string): Promise<void> {
  await deleteDoc(doc(db, 'exchange_bags', id));
}

/**
 * Grab a full bag / drop the empty: `fullCount` -1, `emptyCount` +1. No
 * reserve change — contents were pulled from reserve at fill time, not swap
 * time.
 */
export async function swapBag(bag: ExchangeBag, actor: { id?: string; name?: string }): Promise<void> {
  if (bag.fullCount <= 0) {
    throw new Error('No full bags available to swap');
  }

  const batch = writeBatch(db);

  batch.update(doc(db, 'exchange_bags', bag.id), {
    fullCount: increment(-1),
    emptyCount: increment(1),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(collection(db, 'exchange_bag_events')), removeUndefined({
    bagId: bag.id,
    bagName: bag.name,
    action: 'swap',
    actor,
    createdAt: serverTimestamp(),
  }));

  await batch.commit();
}

/**
 * Refill one empty bag from back-room reserve: validates every line has
 * enough reserve stock BEFORE writing anything, then in one atomic batch
 * decrements reserve for each line item, writes one `inventory_logs` row per
 * line, and flips one bag from empty→full.
 */
export async function refillBag(
  bag: ExchangeBag,
  itemsById: Record<string, InventoryItem>,
  actor: { id?: string; name?: string },
): Promise<void> {
  if (bag.emptyCount <= 0) {
    throw new Error('No empty bags to refill');
  }

  // Validate every line has enough reserve before writing anything.
  const consumedByLine: { itemId: string; itemName: string; patch: Record<string, unknown>; consumed: number }[] = [];
  for (const line of bag.lines) {
    const item = itemsById[line.itemId];
    if (!item) {
      throw new Error('Item not found: ' + line.itemName);
    }
    const { patch, consumed } = consumeReserveUnits(item, line.qtyPerBag);
    if (consumed < line.qtyPerBag) {
      throw new Error('Not enough reserve for ' + line.itemName);
    }
    consumedByLine.push({ itemId: line.itemId, itemName: line.itemName, patch, consumed });
  }

  const batch = writeBatch(db);

  for (const { itemId, itemName, patch, consumed } of consumedByLine) {
    batch.update(doc(db, 'inventory', itemId), {
      ...patch,
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(collection(db, 'inventory_logs')), removeUndefined({
      itemId,
      itemName,
      action: 'refill_bag',
      quantityChange: -consumed,
      source: 'exchange_bag',
      actor,
      note: 'Refilled exchange bag ' + bag.name,
      createdAt: serverTimestamp(),
    }));
  }

  batch.update(doc(db, 'exchange_bags', bag.id), {
    fullCount: increment(1),
    emptyCount: increment(-1),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(collection(db, 'exchange_bag_events')), removeUndefined({
    bagId: bag.id,
    bagName: bag.name,
    action: 'refill',
    actor,
    createdAt: serverTimestamp(),
  }));

  await batch.commit();
}
