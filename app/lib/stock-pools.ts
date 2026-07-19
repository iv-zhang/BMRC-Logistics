/**
 * Two-pool stock model — pure helpers, no React, no Firestore writes.
 *
 * Mental model: `computeBagStock(item).availableItems` (see `item-status.ts`)
 * is the back-room RESERVE pool — everything not yet staged for use. The
 * restock shelf is a separate FRONT pool tracked on `InventoryItem.shelfQuantity`.
 * Refilling the shelf pulls units from reserve and decrements reserve —
 * "everything on shelves is considered used" until an audit reconciles it.
 *
 * This module only computes the Firestore *patch* a refill would need; the
 * actual write (and its log/ledger rows) lives in `app/lib/restock-actions.ts`.
 */

import { computeBagStock } from '@/app/lib/item-status';
import type { InventoryBatch, InventoryItem } from '@/app/types';

/** Back-room reserve pool: deployable on-hand stock (never `totalItems`). */
export function reserveUnits(item: InventoryItem): number {
  return computeBagStock(item).availableItems;
}

/** Front restock-shelf pool: units already staged for use. */
export function shelfUnits(item: InventoryItem): number {
  return item.shelfQuantity ?? 0;
}

export interface ConsumeReserveResult {
  /** Firestore field patch that removes `consumed` units from the reserve pool. */
  patch: Record<string, unknown>;
  /** Units actually removed (never more than the item's available reserve). */
  consumed: number;
}

function isBagTracked(item: InventoryItem): boolean {
  const batches = item.batches || [];
  return batches.some(
    (b) => (b.bagCount !== undefined && b.bagCount > 0) ||
           (b.itemsPerBag !== undefined && (b.itemsPerBag ?? 0) > 0),
  );
}

function isBatchAvailable(b: InventoryBatch, now: Date): boolean {
  const expired = b.expirationDate ? b.expirationDate < now : false;
  const quarantined = b.status === 'quarantined';
  return !expired && !quarantined;
}

/**
 * Compute a patch that consumes up to `qty` units from an item's RESERVE pool.
 * Never writes to Firestore itself — see `refillShelf` in `restock-actions.ts`
 * for the actual write. Never removes more than the item currently has
 * available; if `qty` exceeds reserve, consumes all of it and reports the
 * lesser `consumed` amount.
 *
 * Bag-tracked items draw FEFO (oldest-expiry-first, undefined-expiry last),
 * consuming loose units before breaking whole bags — opening one bag yields
 * `itemsPerBag` loose units, of which only what's needed is taken and the
 * rest stays loose on the SAME batch. Expired/quarantined batches are
 * skipped entirely (mirrors `computeBagStock` availability).
 *
 * Box/loose items draw from `looseUnits` first, then break `unopenedBoxes`
 * (each box yields `itemsPerBox` loose units, leftover stays loose). If the
 * item has no `itemsPerBox`, `unopenedBoxes` is treated as raw units and
 * decremented directly.
 *
 * Sanity checks (illustrative):
 *   consumeReserveUnits({ unopenedBoxes: 0, looseUnits: 3, ... }, 5)
 *     => consumed 3 (clamped — only 3 available), looseUnits -> 0
 *   consumeReserveUnits({ unopenedBoxes: 2, itemsPerBox: 10, looseUnits: 3, ... }, 5)
 *     => consumed 5: 3 loose units used first, then one box broken for the
 *        remaining 2 (8 left over from that box go back to looseUnits) ->
 *        looseUnits: 8, unopenedBoxes: 1
 *   consumeReserveUnits(bagTrackedItem, qty) never mutates the original
 *     `batches` array or its objects — always returns a new array/objects.
 */
export function consumeReserveUnits(item: InventoryItem, qty: number): ConsumeReserveResult {
  const now = new Date();
  const need = Math.max(0, Math.floor(qty));
  if (need === 0) return { patch: {}, consumed: 0 };

  if (isBagTracked(item)) {
    const batches = item.batches || [];
    // FEFO: oldest expiry first, undefined expiry sorts last.
    const order = batches
      .map((b, idx) => ({ b, idx }))
      .sort((a, b) => {
        const ea = a.b.expirationDate ? a.b.expirationDate.getTime() : Infinity;
        const eb = b.b.expirationDate ? b.b.expirationDate.getTime() : Infinity;
        return ea - eb;
      });

    const newBatches = batches.map((b) => ({ ...b }));
    let remaining = need;

    for (const { idx } of order) {
      if (remaining <= 0) break;
      const original = batches[idx];
      if (!isBatchAvailable(original, now)) continue;

      const loose0 = original.looseItems ?? 0;
      const takeLoose = Math.min(loose0, remaining);
      remaining -= takeLoose;
      let loose = loose0 - takeLoose;
      let bagCount = original.bagCount ?? 0;
      const perBag = original.itemsPerBag ?? 0;

      while (remaining > 0 && bagCount > 0 && perBag > 0) {
        bagCount -= 1;
        const takeFromBag = Math.min(perBag, remaining);
        remaining -= takeFromBag;
        loose += perBag - takeFromBag; // leftover from the broken bag stays loose
      }

      newBatches[idx] = {
        ...original,
        looseItems: Math.max(0, loose),
        bagCount: Math.max(0, bagCount),
      };
    }

    const consumed = need - Math.max(0, remaining);
    return { patch: { batches: newBatches }, consumed };
  }

  // Box/loose tracking.
  const perBox = item.itemsPerBox ?? 0;
  const loose0 = item.looseUnits ?? 0;
  const boxes0 = item.unopenedBoxes ?? 0;

  if (perBox > 0) {
    let remaining = need;
    const takeLoose = Math.min(loose0, remaining);
    remaining -= takeLoose;
    let loose = loose0 - takeLoose;
    let boxes = boxes0;

    while (remaining > 0 && boxes > 0) {
      boxes -= 1;
      const takeFromBox = Math.min(perBox, remaining);
      remaining -= takeFromBox;
      loose += perBox - takeFromBox; // leftover from the broken box stays loose
    }

    const consumed = need - Math.max(0, remaining);
    return {
      patch: { looseUnits: Math.max(0, loose), unopenedBoxes: Math.max(0, boxes) },
      consumed,
    };
  }

  // No itemsPerBox: unopenedBoxes are raw units, decrement directly.
  const takeBoxes = Math.min(boxes0, need);
  return {
    patch: { unopenedBoxes: Math.max(0, boxes0 - takeBoxes) },
    consumed: takeBoxes,
  };
}
