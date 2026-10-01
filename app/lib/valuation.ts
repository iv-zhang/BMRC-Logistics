/**
 * Valuation selectors: medical supplies on hand at cost, and the equipment
 * register. PURE: no Firestore, no React, no Firebase import of its own. Data and
 * config come in as arguments. (`item-status.ts` is imported for the shared stock
 * math and, like the other pure lib tests, its config getters load the Firebase
 * client module transitively; nothing connects.)
 *
 * Rules (platform-overhaul §3, Goal A):
 *   - Money is INTEGER CENTS. Unit costs may be fractional cents (a $0.083
 *     glove), so a unit cost is a plain number and every TOTAL is rounded to a
 *     whole cent once, at the end of its multiplication.
 *   - Unknown is `null`, never 0. An item with stock but no derivable cost
 *     contributes nothing to the dollar total and is COUNTED as "no cost", so
 *     the gap is visible ("$X valued, N items with no cost").
 *   - CONFIRMED items only (`getExistence`): unverified or retired records may
 *     be ghosts and must not inflate the books.
 *   - On-hand counts are not recomputed here: bag-tracked lots use the same
 *     `bags * itemsPerBag + loose` formula as `computeBagStock` (asserted equal
 *     in the tests); box-tracked items use `computeBagStock(...).totalItems`.
 *
 * Method:
 *   - RESERVE, bag-tracked: each lot's on-hand units x THAT lot's
 *     `purchase.pricePerUnit` (exact, per lot). A lot with no price contributes
 *     nothing and its units are reported as `unpricedUnits` (item is "partial").
 *   - RESERVE, box-tracked: quantity is pooled onto `unopenedBoxes` and lots are
 *     zero-stock tombstones (D-11/D-12, a deliberately open gap). There is no
 *     per-lot quantity to multiply, so on-hand units are valued at the LATEST
 *     known unit cost (latest priced lot, else `itemValue`) and flagged
 *     `estimated`. Not FIFO-exact; do not "fix".
 *   - SHELF (`shelfQuantity`): units x latest known unit cost, always
 *     `estimated` (the shelf is re-anchored by count, not tracked per lot).
 *   - Physical stock is valued, including expired / quarantined lots: they are
 *     still on hand (and on the books) until someone writes them off.
 */

import { computeBagStock, getExistence } from '@/app/lib/item-status';
import { getLifecycle } from '@/app/lib/asset-lifecycle-core';
import type { AssetLifecycle, InventoryBatch, InventoryItem } from '@/app/types';

// ── shared helpers ───────────────────────────────────────────────────────────

/** Coerce a Date / Firestore Timestamp / legacy {seconds} map to a valid Date, else undefined. */
export function toValidDate(v: unknown): Date | undefined {
  let d: Date | undefined;
  if (v instanceof Date) d = v;
  else if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try {
      d = (v as { toDate: () => Date }).toDate();
    } catch {
      d = undefined;
    }
  } else if (v && typeof (v as { seconds?: unknown }).seconds === 'number') {
    d = new Date((v as { seconds: number }).seconds * 1000);
  }
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** Dollars (as stored in `PurchaseInfo.pricePerUnit` / `itemValue` / `assetValue`) -> unit cents, or null when absent / non-positive. */
function dollarsToUnitCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 100 : null;
}

/** units x unit-cents, rounded to a whole cent. */
function totalCents(units: number, unitCents: number): number {
  return Math.round(units * unitCents);
}

/** Unit cost of one lot from its purchase record, or null if unpriced. */
export function lotUnitCents(b: InventoryBatch): number | null {
  return dollarsToUnitCents(b.purchase?.pricePerUnit);
}

/** On-hand units of one bag-tracked lot (same formula as `computeBagStock`). */
export function lotUnits(b: InventoryBatch): number {
  return (b.bagCount ?? 0) * (b.itemsPerBag ?? 0) + (b.looseItems ?? 0);
}

function lotReceivedMs(b: InventoryBatch): number {
  const d = toValidDate(b.purchase?.receivedAt) ?? toValidDate(b.receivedAt) ?? toValidDate(b.purchase?.orderDate);
  return d ? d.getTime() : Number.NEGATIVE_INFINITY;
}

export interface LatestUnitCost {
  /** Cost of one unit in cents (may be fractional). */
  unitCents: number;
  source: 'lot' | 'itemValue';
}

/**
 * Most recent known unit cost of a consumable: the priced lot received last
 * (any lot, including zero-stock tombstones, which keep their purchase record);
 * falls back to the stamped `itemValue` (dollars). Null when nothing is known.
 */
export function latestUnitCost(item: Pick<InventoryItem, 'batches' | 'itemValue'>): LatestUnitCost | null {
  let best: { ms: number; unitCents: number } | null = null;
  for (const b of item.batches ?? []) {
    const unitCents = lotUnitCents(b);
    if (unitCents === null) continue;
    const ms = lotReceivedMs(b);
    if (!best || ms >= best.ms) best = { ms, unitCents }; // ties: later array entry wins
  }
  if (best) return { unitCents: best.unitCents, source: 'lot' };
  const fromValue = dollarsToUnitCents(item.itemValue);
  return fromValue === null ? null : { unitCents: fromValue, source: 'itemValue' };
}

// ── medical supplies on hand at cost ─────────────────────────────────────────

export type ValuationMethod = 'lots' | 'latest_lot_estimate' | 'none';

export interface ItemValuation {
  itemId: string;
  name: string;
  /** Back-reserve units on hand (physical). */
  reserveUnits: number;
  /** Front-shelf units (`shelfQuantity`). */
  shelfUnits: number;
  /** Reserve value; null when no priced lot covers any reserve units. */
  reserveCents: number | null;
  /** Shelf value (always estimated); null when shelf is empty or no cost is known. */
  shelfCents: number | null;
  /** Reserve + shelf, counting only the parts that could be priced; null when neither could. */
  totalCents: number | null;
  /** On-hand units (reserve + shelf) that no cost could be found for. */
  unpricedUnits: number;
  /** True when any part of the total is an estimate (shelf, or box-tracked reserve). */
  estimated: boolean;
  method: ValuationMethod;
}

export interface SuppliesValuation {
  /** Sum of every item's known `totalCents`. Integer cents. */
  valuedCents: number;
  /** The part of `valuedCents` that is an estimate (shelf + box-tracked reserve). */
  estimatedCents: number;
  /** Confirmed consumables with stock on hand that were considered. */
  itemsConsidered: number;
  /** Of those, items with at least some value. */
  itemsValued: number;
  /** Items with stock but NO derivable cost: contribute null, not $0. Report as "N items with no cost". */
  itemsNoCost: number;
  /** Valued items that still have some units with no cost (value is a lower bound). */
  itemsPartial: number;
  /** Skipped: not `confirmed` (unverified or retired), or not a consumable. */
  itemsExcluded: number;
  items: ItemValuation[];
}

export interface ValuationOptions {
  /** Pass `determineIsAsset` (app/lib/inventory.ts). Assets are never "supplies". */
  isAsset: (item: InventoryItem) => boolean;
  now?: Date;
}

/** Value one consumable. Pure; exported for tests and per-item displays. */
export function valueItem(item: InventoryItem, now: Date = new Date()): ItemValuation {
  const stock = computeBagStock(item, now);
  const shelfUnits = Math.max(0, item.shelfQuantity ?? 0);
  const latest = latestUnitCost(item);

  let reserveCents: number | null = null;
  let reservePriced = 0;
  let estimated = false;
  let method: ValuationMethod = 'none';
  const reserveUnits = stock.totalItems;

  if (stock.hasBagTracking) {
    // Exact: every lot at its own price.
    let sum = 0;
    let any = false;
    for (const b of item.batches ?? []) {
      const units = lotUnits(b);
      if (units <= 0) continue;
      const unitCents = lotUnitCents(b);
      if (unitCents === null) continue;
      sum += totalCents(units, unitCents);
      reservePriced += units;
      any = true;
    }
    if (any) {
      reserveCents = sum;
      method = 'lots';
    }
  } else if (reserveUnits > 0) {
    // Box-tracked: pooled quantity, no per-lot count (D-11/D-12). Estimate every
    // on-hand unit at the latest known unit cost, and say so.
    if (latest) {
      reserveCents = totalCents(reserveUnits, latest.unitCents);
      reservePriced = reserveUnits;
      estimated = true;
      method = 'latest_lot_estimate';
    }
  }

  let shelfCents: number | null = null;
  let shelfPriced = 0;
  if (shelfUnits > 0 && latest) {
    shelfCents = totalCents(shelfUnits, latest.unitCents);
    shelfPriced = shelfUnits;
    estimated = true;
  }

  const total = reserveCents === null && shelfCents === null ? null : (reserveCents ?? 0) + (shelfCents ?? 0);
  return {
    itemId: item.id,
    name: item.name,
    reserveUnits,
    shelfUnits,
    reserveCents,
    shelfCents,
    totalCents: total,
    unpricedUnits: reserveUnits - reservePriced + (shelfUnits - shelfPriced),
    estimated,
    method,
  };
}

/**
 * Medical supplies on hand at cost: confirmed, non-asset items only. See the
 * file header for method and the box-tracked limitation. Items with nothing on
 * hand (reserve and shelf both 0) are not "missing a cost" and are not counted.
 */
export function valueSuppliesOnHand(items: readonly InventoryItem[], opts: ValuationOptions): SuppliesValuation {
  const now = opts.now ?? new Date();
  const out: ItemValuation[] = [];
  let valuedCents = 0;
  let estimatedCents = 0;
  let itemsNoCost = 0;
  let itemsPartial = 0;
  let itemsExcluded = 0;
  let itemsValued = 0;

  for (const item of items) {
    if (getExistence(item) !== 'confirmed' || opts.isAsset(item) || item.componentType || item.parentAssetId) {
      itemsExcluded++;
      continue;
    }
    const v = valueItem(item, now);
    if (v.reserveUnits <= 0 && v.shelfUnits <= 0) continue; // nothing on hand: no value, no gap
    out.push(v);
    if (v.totalCents === null) {
      itemsNoCost++;
      continue;
    }
    itemsValued++;
    valuedCents += v.totalCents;
    if (v.unpricedUnits > 0) itemsPartial++;
    // The estimated share: shelf is entirely estimated; reserve only when box-tracked.
    estimatedCents += (v.shelfCents ?? 0) + (v.method === 'latest_lot_estimate' ? (v.reserveCents ?? 0) : 0);
  }

  return {
    valuedCents,
    estimatedCents,
    itemsConsidered: out.length,
    itemsValued,
    itemsNoCost,
    itemsPartial,
    itemsExcluded,
    items: out,
  };
}

// ── equipment register (workbook Balances §3) ────────────────────────────────

export interface EquipmentRegisterRow {
  itemId: string;
  /** Workbook column order: Item · Category · Owner · Qty */
  item: string;
  category: string;
  /** Owner; null when not recorded (legacy docs), never assumed to be BMRC. */
  owner: string | null;
  qty: number;
  /** Original cost of ONE unit in cents; null when unknown. */
  unitCostCents: number | null;
  /** unit cost x qty; null when the unit cost is unknown. */
  totalCostCents: number | null;
  costSource: 'acquisition' | 'assetValue' | null;
  /**
   * BMRC-owned AND unit cost >= the asset value threshold. `false` when known
   * not capitalized (another owner, or under the threshold); `null` when it
   * cannot be decided (owner or cost unknown).
   */
  capitalized: boolean | null;
  lifecycle: AssetLifecycle;
}

export interface EquipmentRegisterOptions {
  /** Pass `determineIsAsset` (app/lib/inventory.ts). */
  isAsset: (item: InventoryItem) => boolean;
  /** `getThresholds().assetValueThreshold`, in DOLLARS (default config: 500). */
  assetValueThresholdDollars: number;
  /** The owner whose gear is capitalized (case-insensitive). Default 'BMRC'. */
  capitalizingOwner?: string;
}

function itemUnitCost(item: InventoryItem): { cents: number; source: 'acquisition' | 'assetValue' } | null {
  const a = item.acquisitionCostCents;
  if (typeof a === 'number' && Number.isInteger(a) && a > 0) return { cents: a, source: 'acquisition' };
  const v = item.assetValue; // legacy: dollars, per unit
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { cents: Math.round(v * 100), source: 'assetValue' };
  return null;
}

/**
 * Equipment register rows, sorted Category then Item. One row per asset doc;
 * Qty = serialized instances still on the books (lost / retired instances do
 * not count), or 1 for a single-unit doc. Excludes AED child components
 * (batteries / pads are consumables of their parent), existence-retired records,
 * and docs whose lifecycle is lost / retired. Owner and cost are read from the
 * doc (per-instance overrides are not split into separate rows).
 */
export function buildEquipmentRegister(
  items: readonly InventoryItem[],
  opts: EquipmentRegisterOptions,
): EquipmentRegisterRow[] {
  const owner0 = (opts.capitalizingOwner ?? 'BMRC').trim().toLowerCase();
  const thresholdCents = Math.round(opts.assetValueThresholdDollars * 100);
  const rows: EquipmentRegisterRow[] = [];

  for (const item of items) {
    if (!opts.isAsset(item) || item.componentType || item.parentAssetId) continue;
    if (getExistence(item) === 'retired') continue;
    const lifecycle = getLifecycle(item);
    if (lifecycle === 'lost' || lifecycle === 'retired') continue;

    const instances = item.assets ?? [];
    let qty = 1;
    if (instances.length > 0) {
      qty = instances.filter((a) => {
        const l = getLifecycle(a);
        return l !== 'lost' && l !== 'retired';
      }).length;
      if (qty === 0) continue;
    }

    const owner = item.owner?.trim() || null;
    const cost = itemUnitCost(item);
    let capitalized: boolean | null;
    if (owner === null) capitalized = null;
    else if (owner.toLowerCase() !== owner0) capitalized = false;
    else if (cost === null) capitalized = null;
    else capitalized = cost.cents >= thresholdCents;

    rows.push({
      itemId: item.id,
      item: item.name,
      category: item.assetCategory || item.category || '',
      owner,
      qty,
      unitCostCents: cost ? cost.cents : null,
      totalCostCents: cost ? cost.cents * qty : null,
      costSource: cost ? cost.source : null,
      capitalized,
      lifecycle,
    });
  }

  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
}
