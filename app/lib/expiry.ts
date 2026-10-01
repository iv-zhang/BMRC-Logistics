/**
 * Expiry selectors: bucket lots AND asset components (AED pads / batteries) into
 * expired / <=30 / <=60 / <=90 days, the reorder cost of what expires this
 * fiscal year, and asset shrinkage. PURE: no Firestore, no Firebase import of
 * its own; data and config (bucket days, FY start month, asset predicate) are
 * arguments. (`item-status.ts` is imported for the shared stock math; its config
 * getters load the Firebase client module transitively, nothing connects.)
 *
 * Where expirations live today:
 *   - LOTS: `InventoryItem.batches[].expirationDate`. Only lots that still hold
 *     stock count (`batchHasStock`), exactly like `getItemStatus`: a zero-stock
 *     tombstone must never read as expiring. (So a box-tracked SKU, whose lots
 *     are all tombstones, has no lot expiry here; that is the open D-11/D-12
 *     gap, not a bug.) An item with no stock-holding lot but a dated
 *     `expirationDate` and units on hand falls back to that single date.
 *   - COMPONENTS, in order of authority, per parent asset and per type:
 *       1. child inventory docs (`componentType` + `parentAssetId`, own
 *          `expirationDate`), see `asset-components.ts`
 *       2. serialized instances: `assets[].padExpiration` / `batteryExpiration`
 *       3. the parent doc's `padExpiration` / `batteryExpiration`
 *     The first source that has any entry for that (parent, type) wins, so a
 *     battery recorded both as a child doc and as a parent field is counted once.
 *
 * Buckets are EXCLUSIVE bands: an entry sits in the first band whose cutoff
 * (`now + days`) it falls within, so a 20-day lot appears only under <=30.
 * "Expired" is `expirationDate < now`, the same rule as `getItemStatus`.
 *
 * Lots are limited to CONFIRMED items by default (D-32: unverified / retired
 * records may be ghosts and must not drive alerts). Components skip that gate
 * (assets are not on the supply-audit cycle) but drop lost / retired assets.
 *
 * Money: integer cents; unknown is `null`, never 0.
 */

import { batchHasStock, computeBagStock, getExistence } from '@/app/lib/item-status';
import { sanitizeExpiryBuckets } from '@/app/config/org-config';
import { getLifecycle, LOSS_LIFECYCLES } from '@/app/lib/asset-lifecycle-core';
import { latestUnitCost, lotUnits, toValidDate } from '@/app/lib/valuation';
import { fyRange } from '@/app/lib/fiscal';
import type { AssetInstance, InventoryBatch, InventoryItem } from '@/app/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ComponentType = 'battery' | 'pads';

export interface ExpiryEntry {
  kind: 'lot' | 'component';
  itemId: string;
  itemName: string;
  expirationDate: Date;
  /** Whole days from `now` (rounded up); negative or 0 when expired. */
  daysLeft: number;
  /** Bucket key this entry fell into ('expired', 'd30', ...), or 'beyond'. */
  bucket: string;
  // lots
  lotId?: string;
  lotNumber?: string;
  /** Units on hand in the lot (lots only). */
  units?: number;
  // components
  parentItemId?: string;
  componentType?: ComponentType;
  serial?: string;
  /** Cost to replace ONE unit, cents (may be fractional); null = unknown. */
  replacementUnitCents: number | null;
}

export interface ExpiryBucket {
  key: string;
  label: string;
  /** Upper bound in days; null for the 'expired' bucket. */
  maxDays: number | null;
  entries: ExpiryEntry[];
}

export interface ExpiryReport {
  buckets: ExpiryBucket[];
  /** Dated entries further out than the last bucket. */
  beyond: number;
  entries: ExpiryEntry[];
}

export interface ExpiryOptions {
  /** `getExpiryBuckets()` (org-config-store). Sanitized again here. */
  buckets: readonly number[];
  /** Pass `determineIsAsset` (app/lib/inventory.ts). */
  isAsset: (item: InventoryItem) => boolean;
  now?: Date;
  /** Restrict lots to confirmed items (default true). */
  confirmedOnly?: boolean;
}

export function bucketKey(days: number): string {
  return `d${days}`;
}

function bucketOf(exp: Date, now: Date, days: readonly number[]): string {
  if (exp.getTime() < now.getTime()) return 'expired';
  for (const d of days) if (exp.getTime() <= now.getTime() + d * DAY_MS) return bucketKey(d);
  return 'beyond';
}

function daysLeftOf(exp: Date, now: Date): number {
  return Math.ceil((exp.getTime() - now.getTime()) / DAY_MS);
}

function childUnitCents(c: InventoryItem): number | null {
  if (typeof c.acquisitionCostCents === 'number' && c.acquisitionCostCents > 0) return c.acquisitionCostCents;
  const v = c.assetValue ?? c.itemValue;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 100 : null;
}

/** Instance field that holds the expiry for a component type. */
function instanceField(t: ComponentType): 'padExpiration' | 'batteryExpiration' {
  return t === 'pads' ? 'padExpiration' : 'batteryExpiration';
}

/**
 * Every dated lot and asset component in `items`, sorted soonest first, each
 * tagged with its bucket. `items` is the whole inventory (child component docs
 * and their parents together).
 */
export function collectExpiryEntries(items: readonly InventoryItem[], opts: ExpiryOptions): ExpiryEntry[] {
  const now = opts.now ?? new Date();
  const days = sanitizeExpiryBuckets(opts.buckets);
  const confirmedOnly = opts.confirmedOnly ?? true;
  const entries: ExpiryEntry[] = [];

  const push = (e: Omit<ExpiryEntry, 'daysLeft' | 'bucket'>) =>
    entries.push({ ...e, daysLeft: daysLeftOf(e.expirationDate, now), bucket: bucketOf(e.expirationDate, now, days) });

  // Child component docs grouped by parent id.
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const children = new Map<string, InventoryItem[]>();
  for (const it of items) {
    if (it.componentType && it.parentAssetId) {
      const list = children.get(it.parentAssetId) ?? [];
      list.push(it);
      children.set(it.parentAssetId, list);
    }
  }

  const pushChild = (c: InventoryItem, parent?: InventoryItem) => {
    const exp = toValidDate(c.expirationDate);
    if (!exp) return;
    push({
      kind: 'component',
      itemId: c.id,
      itemName: c.name || `${parent?.name ?? 'Asset'} ${c.componentType}`,
      expirationDate: exp,
      parentItemId: c.parentAssetId,
      componentType: c.componentType,
      serial: c.assetSerial,
      replacementUnitCents: childUnitCents(c),
    });
  };

  for (const item of items) {
    if (getExistence(item) === 'retired') continue;
    if (item.componentType) continue; // handled via its parent (or as an orphan below)

    if (opts.isAsset(item)) {
      const life = getLifecycle(item);
      if (life === 'lost' || life === 'retired') continue;
      for (const type of ['pads', 'battery'] as ComponentType[]) {
        const kids = (children.get(item.id) ?? []).filter((c) => c.componentType === type);
        if (kids.length > 0) {
          kids.forEach((c) => pushChild(c, item));
          continue;
        }
        const field = instanceField(type);
        const fromInstances = (item.assets ?? [])
          .map((a: AssetInstance) => ({ a, exp: toValidDate(a[field]) }))
          .filter((x) => x.exp && getLifecycle(x.a) !== 'lost' && getLifecycle(x.a) !== 'retired');
        if (fromInstances.length > 0) {
          for (const { a, exp } of fromInstances) {
            push({
              kind: 'component',
              itemId: item.id,
              itemName: item.name,
              expirationDate: exp as Date,
              parentItemId: item.id,
              componentType: type,
              serial: a.serial,
              replacementUnitCents: null,
            });
          }
          continue;
        }
        const own = toValidDate(item[field]);
        if (own) {
          push({
            kind: 'component',
            itemId: item.id,
            itemName: item.name,
            expirationDate: own,
            parentItemId: item.id,
            componentType: type,
            serial: item.assetSerial,
            replacementUnitCents: null,
          });
        }
      }
      continue;
    }

    // Consumable lots.
    if (confirmedOnly && getExistence(item) !== 'confirmed') continue;
    const unitCost = latestUnitCost(item);
    const replacementUnitCents = unitCost ? unitCost.unitCents : null;
    const stockLots = (item.batches ?? []).filter(batchHasStock);
    let sawLot = false;
    for (const b of stockLots as InventoryBatch[]) {
      const exp = toValidDate(b.expirationDate);
      if (!exp) continue;
      sawLot = true;
      push({
        kind: 'lot',
        itemId: item.id,
        itemName: item.name,
        expirationDate: exp,
        lotId: b.id,
        lotNumber: b.lotNumber,
        units: lotUnits(b) || b.stock || 0,
        replacementUnitCents,
      });
    }
    if (!sawLot && stockLots.length === 0) {
      const exp = toValidDate(item.expirationDate);
      const units = computeBagStock(item, now).totalItems;
      if (exp && units > 0) {
        push({ kind: 'lot', itemId: item.id, itemName: item.name, expirationDate: exp, units, replacementUnitCents });
      }
    }
  }

  // Orphan components: child docs whose parent is not in `items`.
  for (const [parentId, kids] of children) {
    if (byId.has(parentId)) continue;
    for (const c of kids) if (getExistence(c) !== 'retired') pushChild(c);
  }

  return entries.sort((a, b) => a.expirationDate.getTime() - b.expirationDate.getTime());
}

/** Group entries into expired + one band per configured day count. */
export function bucketExpiries(entries: readonly ExpiryEntry[], buckets: readonly number[]): ExpiryBucket[] {
  const days = sanitizeExpiryBuckets(buckets);
  const out: ExpiryBucket[] = [
    { key: 'expired', label: 'Expired', maxDays: null, entries: [] },
    ...days.map((d) => ({ key: bucketKey(d), label: `≤ ${d} days`, maxDays: d, entries: [] as ExpiryEntry[] })),
  ];
  for (const e of entries) {
    const b = out.find((x) => x.key === e.bucket);
    if (b) b.entries.push(e);
  }
  return out;
}

/** One call: collect + bucket. */
export function expiryReport(items: readonly InventoryItem[], opts: ExpiryOptions): ExpiryReport {
  const entries = collectExpiryEntries(items, opts);
  return {
    buckets: bucketExpiries(entries, opts.buckets),
    beyond: entries.filter((e) => e.bucket === 'beyond').length,
    entries,
  };
}

// ── reorder cost expiring this FY ────────────────────────────────────────────

export interface ReorderCostLine {
  entry: ExpiryEntry;
  /** Replacement cost for the entry (units x unit cost), whole cents; null = unknown. */
  cents: number | null;
}

export interface ReorderCostResult {
  /** Sum of the lines with a known cost. Integer cents. */
  cents: number;
  /** Lines whose replacement cost is unknown (counted, not priced at $0). */
  noCostCount: number;
  lines: ReorderCostLine[];
}

/**
 * Cost to replace everything whose expiration date falls inside fiscal year
 * `fy` (the ending year, 2027 = FY27): lots at the item's latest known unit
 * cost, components at their child doc's cost. Entries already expired BEFORE the
 * FY started are not "expiring this FY" (they show in the Expired bucket).
 * `startMonth` is the fiscal-year start month (`getFiscalYearStartMonthRuntime()`).
 */
export function reorderCostExpiringThisFY(
  entries: readonly ExpiryEntry[],
  fy: number,
  startMonth: number,
): ReorderCostResult {
  const { start, endExclusive } = fyRange(fy, startMonth);
  const lines: ReorderCostLine[] = [];
  let cents = 0;
  let noCostCount = 0;
  for (const entry of entries) {
    const t = entry.expirationDate.getTime();
    if (t < start.getTime() || t >= endExclusive.getTime()) continue;
    const units = entry.kind === 'lot' ? entry.units ?? 0 : 1;
    const line = entry.replacementUnitCents === null ? null : Math.round(units * entry.replacementUnitCents);
    lines.push({ entry, cents: line });
    if (line === null) noCostCount++;
    else cents += line;
  }
  return { cents, noCostCount, lines };
}

// ── shrinkage ────────────────────────────────────────────────────────────────

export interface ShrinkageEvent {
  itemId: string;
  itemName: string;
  serial?: string;
  /** The state it moved into when this loss began. */
  lifecycle: 'lost' | 'damaged' | 'retired';
  at: Date;
  /** Original cost, cents; null = unknown (counted in `noCostCount`, not $0). */
  costCents: number | null;
}

export interface ShrinkageResult {
  events: ShrinkageEvent[];
  /** Sum of the events with a known cost. Integer cents. */
  totalCents: number;
  noCostCount: number;
}

function originalCostCents(x: { acquisitionCostCents?: number; assetValue?: number }): number | null {
  if (typeof x.acquisitionCostCents === 'number' && Number.isInteger(x.acquisitionCostCents) && x.acquisitionCostCents > 0) {
    return x.acquisitionCostCents;
  }
  if (typeof x.assetValue === 'number' && Number.isFinite(x.assetValue) && x.assetValue > 0) {
    return Math.round(x.assetValue * 100);
  }
  return null;
}

/**
 * Start of the CURRENT loss run for one asset or instance: the dated history
 * entry where it last moved into lost / damaged / retired (walking back over
 * consecutive loss states, so damaged -> retired is one loss, dated when it was
 * first damaged). Null if it is not currently in a loss state (never lost, or
 * since recovered).
 */
function lossStart(t: { lifecycle?: InventoryItem['lifecycle']; lifecycleHistory?: InventoryItem['lifecycleHistory'] }) {
  const current = getLifecycle(t);
  if (!(LOSS_LIFECYCLES as readonly string[]).includes(current)) return null;
  const hist = [...(t.lifecycleHistory ?? [])]
    .map((e) => ({ e, at: toValidDate(e.at) }))
    .filter((x): x is { e: NonNullable<typeof t.lifecycleHistory>[number]; at: Date } => !!x.at)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  let i = hist.length - 1;
  if (i < 0 || hist[i].e.to !== current) return null;
  while (i > 0 && (LOSS_LIFECYCLES as readonly string[]).includes(hist[i - 1].e.to)) i--;
  return { to: hist[i].e.to as 'lost' | 'damaged' | 'retired', at: hist[i].at };
}

/**
 * Assets whose lifecycle moved into lost / damaged / retired within fiscal year
 * `fy`, valued at ORIGINAL cost (`acquisitionCostCents`, else legacy
 * `assetValue` dollars). Serialized instances with their own history are counted
 * per instance (the doc itself is then not double counted); otherwise per doc.
 * An asset that was lost and later recovered is not shrinkage.
 */
export function shrinkage(items: readonly InventoryItem[], fy: number, startMonth: number): ShrinkageResult {
  const { start, endExclusive } = fyRange(fy, startMonth);
  const events: ShrinkageEvent[] = [];

  const consider = (
    item: InventoryItem,
    target: { lifecycle?: InventoryItem['lifecycle']; lifecycleHistory?: InventoryItem['lifecycleHistory'] },
    costCents: number | null,
    serial?: string,
  ) => {
    const s = lossStart(target);
    if (!s || s.at.getTime() < start.getTime() || s.at.getTime() >= endExclusive.getTime()) return;
    events.push({ itemId: item.id, itemName: item.name, serial, lifecycle: s.to, at: s.at, costCents });
  };

  for (const item of items) {
    if (getExistence(item) === 'retired') continue;
    const instances = (item.assets ?? []).filter((a) => (a.lifecycleHistory?.length ?? 0) > 0);
    if (instances.length > 0) {
      const docCost = originalCostCents(item);
      for (const a of instances) consider(item, a, originalCostCents(a) ?? docCost, a.serial);
    } else {
      consider(item, item, originalCostCents(item));
    }
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  let totalCents = 0;
  let noCostCount = 0;
  for (const e of events) {
    if (e.costCents === null) noCostCount++;
    else totalCents += e.costCents;
  }
  return { events, totalCents, noCostCount };
}
