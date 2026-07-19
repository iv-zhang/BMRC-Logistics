/**
 * Read-only analytics joining inventory items to the storage tree
 * (zone → shelf → container). Pure functions only — this module never writes
 * to Firestore and never touches `storageLocation` on any item. It exists so
 * the Sites & Storage settings tab can show per-location rollups (item
 * counts, restock needs, audit freshness) without duplicating the stock/
 * status math that already lives in `item-status.ts`.
 */

import type { InventoryItem, Shelf } from '@/app/types';
import { getItemStatus, computeBagStock, type ItemStatus } from '@/app/lib/item-status';

export interface RestockItemRef {
  id: string;
  name: string;
  available: number;
  par: number;
}

export interface LocationRollup {
  /** Items whose storageLocation resolves to this node. */
  itemCount: number;
  low: number;
  out: number;
  expiring: number;
  expired: number;
  /** Items with status 'low' or 'out', sorted worst (lowest available) first. */
  restockItems: RestockItemRef[];
  /** Earliest lastAuditDate among items here; null if none audited or no items. */
  oldestAudit: Date | null;
  neverAuditedCount: number;
}

export interface StorageRollups {
  byZone: Map<string, LocationRollup>;
  byShelf: Map<string, LocationRollup>;
  byContainer: Map<string, LocationRollup>;
}

export function emptyRollup(): LocationRollup {
  return {
    itemCount: 0,
    low: 0,
    out: 0,
    expiring: 0,
    expired: 0,
    restockItems: [],
    oldestAudit: null,
    neverAuditedCount: 0,
  };
}

function bucketFor(map: Map<string, LocationRollup>, id: string | undefined | null): LocationRollup | null {
  if (!id) return null;
  let r = map.get(id);
  if (!r) {
    r = emptyRollup();
    map.set(id, r);
  }
  return r;
}

function applyItem(rollup: LocationRollup, item: InventoryItem, status: ItemStatus, available: number, par: number) {
  rollup.itemCount++;
  if (status === 'low') rollup.low++;
  else if (status === 'out') rollup.out++;
  else if (status === 'expiring') rollup.expiring++;
  else if (status === 'expired') rollup.expired++;

  // Pure assets (asset-valued, no par/reorder concept) shouldn't clutter a
  // "restock needed" list even when they read 'out' — that status just means
  // "no deployable stock", not "needs reordering".
  const isPureAsset = item.assetValue !== undefined && par === 0;
  if ((status === 'low' || status === 'out') && !isPureAsset) {
    rollup.restockItems.push({ id: item.id, name: item.name, available, par });
  }

  if (item.lastAuditDate) {
    if (!rollup.oldestAudit || item.lastAuditDate < rollup.oldestAudit) rollup.oldestAudit = item.lastAuditDate;
  } else {
    rollup.neverAuditedCount++;
  }
}

/**
 * Scan every inventory item once and bucket it into whichever storage nodes
 * its `storageLocation` references (zone / shelf / container are computed
 * independently — a zone's rollup includes every item on any shelf/container
 * within it, not just items pinned directly to the zone).
 */
export function computeStorageRollups(items: InventoryItem[]): StorageRollups {
  const byZone = new Map<string, LocationRollup>();
  const byShelf = new Map<string, LocationRollup>();
  const byContainer = new Map<string, LocationRollup>();

  for (const item of items) {
    const loc = item.storageLocation;
    if (!loc) continue;

    const status = getItemStatus(item);
    const available = computeBagStock(item).availableItems;
    const par = item.reorderThreshold || 0;

    const zoneR = bucketFor(byZone, loc.zoneId);
    if (zoneR) applyItem(zoneR, item, status, available, par);

    const shelfR = bucketFor(byShelf, loc.shelfId);
    if (shelfR) applyItem(shelfR, item, status, available, par);

    const containerR = bucketFor(byContainer, loc.containerId);
    if (containerR) applyItem(containerR, item, status, available, par);
  }

  const worstFirst = (a: RestockItemRef, b: RestockItemRef) => a.available - b.available;
  for (const map of [byZone, byShelf, byContainer]) {
    for (const rollup of map.values()) rollup.restockItems.sort(worstFirst);
  }

  return { byZone, byShelf, byContainer };
}

/** Sum several node rollups into one (e.g. all zones under a site/room). */
export function aggregateRollups(rollups: (LocationRollup | undefined)[]): LocationRollup {
  const out = emptyRollup();
  for (const r of rollups) {
    if (!r) continue;
    out.itemCount += r.itemCount;
    out.low += r.low;
    out.out += r.out;
    out.expiring += r.expiring;
    out.expired += r.expired;
    out.restockItems.push(...r.restockItems);
    out.neverAuditedCount += r.neverAuditedCount;
    if (r.oldestAudit && (!out.oldestAudit || r.oldestAudit < out.oldestAudit)) out.oldestAudit = r.oldestAudit;
  }
  out.restockItems.sort((a, b) => a.available - b.available);
  return out;
}

/** Shelf capacity fill — assigned item count vs. declared capacity. */
export function shelfFill(shelf: Shelf, rollup?: LocationRollup): {
  assigned: number;
  capacity: number | null;
  pct: number | null;
} {
  const assigned = rollup?.itemCount ?? 0;
  const capacity = shelf.capacity ?? null;
  const pct = capacity && capacity > 0 ? Math.min(100, Math.round((assigned / capacity) * 100)) : null;
  return { assigned, capacity, pct };
}
