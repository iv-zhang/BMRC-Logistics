/**
 * Consumption analytics for the /stats dashboard.
 *
 * Pure aggregation functions — no React, no Firestore reads. Every function
 * takes the full `StatsData` bundle plus the active `StatsFilterState` and
 * returns chart-ready rows. See `app/lib/stats/shared.ts` for the shared
 * contracts (`StatsData`, `StatsFilterState`, `DaysOfCoverRow`, etc.) and
 * CLAUDE.md's "Two-pool stock model" section for the reserve/shelf split
 * this file must respect.
 *
 * CRITICAL: this app tracks two separate stock pools — back-room RESERVE
 * (`computeBagStock().availableItems`) and front SHELF (`shelfQuantity`,
 * deliberately not event-tracked). Every "how much do we have" number in
 * this file is the RESERVE pool. `shelfQuantity` is never added into an
 * availability number — see the comment at `getItemStatus` in
 * `app/lib/item-status.ts`.
 *
 * Statpack usage math (checkout/checkin pairing, per-entry shortfall
 * totals) is NOT reimplemented here — `computeMostUsedItems` and
 * `computeStatpackStats` from `app/lib/statpack-stats.ts` are reused so
 * these numbers always agree with `/statpacks/stats`.
 */

import {
  toDate,
  inRange,
  bucketBy,
  pickGranularity,
  sum,
  median,
  histogram,
  passesCrossFilters,
  compareDaysOfCover,
  daysBetween,
  DAY_MS,
  type DaysOfCoverRow,
  type StatsData,
  type StatsFilterState,
  type DateRange,
} from '@/app/lib/stats/shared';
import { computeMostUsedItems, computeStatpackStats } from '@/app/lib/statpack-stats';
import { computeBagStock, batchHasStock } from '@/app/lib/item-status';

// ── 1. Consumption over time ──────────────────────────────────────────────

/** Per-entry shortfall: how many units a checkin found missing/used. */
function entryShortfall(e: { requiredQuantity?: number; countedQuantity?: number }): number {
  const required = typeof e?.requiredQuantity === 'number' ? e.requiredQuantity : 0;
  const counted = typeof e?.countedQuantity === 'number' ? e.countedQuantity : 0;
  return Math.max(0, required - counted);
}

/**
 * Units consumed per bucket, combining two sources:
 *  - statpack checkin shortfalls (`requiredQuantity - countedQuantity` per
 *    pocket item; same definition `computeMostUsedItems` uses, kept in sync
 *    intentionally rather than calling it here because that helper produces
 *    a single all-time total, not per-log dated events).
 *  - restock action quantities (`restock_actions` docs) — units pushed back
 *    onto the shelf, a second proxy for what was consumed and needed
 *    replenishing.
 */
export function consumptionOverTime(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; value: number }[] {
  const events: { date: Date | null; value: number }[] = [];

  for (const log of data.statpackLogs) {
    if ((log.action || '').toLowerCase() !== 'checkin') continue;
    const entries = Array.isArray(log.checkEntries) ? log.checkEntries : [];
    for (const e of entries) {
      const used = entryShortfall(e);
      if (used <= 0) continue;
      const itemName = e?.itemName || e?.itemId;
      if (!passesCrossFilters({ itemName, packName: log.statpackName }, filters.crossFilters, tileId)) continue;
      events.push({ date: log.timestamp, value: used });
    }
  }

  for (const action of data.restockActions) {
    const createdAt = toDate(action.createdAt);
    const items = Array.isArray(action.items) ? action.items : [];
    for (const it of items) {
      const qty = typeof it?.quantity === 'number' ? it.quantity : 0;
      if (qty <= 0) continue;
      if (!passesCrossFilters({ itemName: it?.name }, filters.crossFilters, tileId)) continue;
      events.push({ date: createdAt, value: qty });
    }
  }

  const buckets = bucketBy(events, (e) => e.date, filters.range, pickGranularity(filters.range));
  return buckets.map((b) => ({ label: b.label, value: sum(b.items.map((i) => i.value)) }));
}

// ── 2. Top consumed items ─────────────────────────────────────────────────

/** Top 12 items by total shortfall, reusing `computeMostUsedItems` as-is. */
export function topConsumedItems(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; value: number }[] {
  const filteredLogs = data.statpackLogs.filter(
    (log) =>
      inRange(log.timestamp, filters.range) &&
      passesCrossFilters({ packName: log.statpackName }, filters.crossFilters, tileId)
  );
  // computeMostUsedItems aggregates by itemName across a whole log set, so an
  // itemName cross-filter (emitted by a different tile) is applied to its
  // output afterward rather than threaded into the aggregation itself.
  const items = computeMostUsedItems(filteredLogs, 12).filter((row) =>
    passesCrossFilters({ itemName: row.itemName }, filters.crossFilters, tileId)
  );
  return items.map((r) => ({ label: r.itemName, value: r.usedCount }));
}

// ── 3. Days of cover ──────────────────────────────────────────────────────

const DEFAULT_BURN_WINDOW_DAYS = 90;

/**
 * Denominator for burn-per-day. When the filter range is fully bounded, use
 * its actual span. An unbounded range ("all time") still needs a finite
 * window to divide by — falling back to a trailing 90-day window ending at
 * `range.end ?? now` avoids diluting burn rate across an item's entire
 * history, which would understate current consumption.
 */
function burnWindowDays(range: DateRange, now: Date): number {
  const end = range.end ?? now;
  const start = range.start ?? new Date(end.getTime() - DEFAULT_BURN_WINDOW_DAYS * DAY_MS);
  return Math.max(1, daysBetween(start, end));
}

/**
 * Days-of-cover per inventory item: `reserveUnits / burnPerDay`, sorted
 * soonest-to-run-out first via `compareDaysOfCover`.
 *
 * `reserveUnits` comes from `computeBagStock().availableItems` — the
 * back-room RESERVE pool — never `shelfQuantity` (see file header / D-model
 * in CLAUDE.md). `burnPerDay` is total units consumed in range / days in
 * range; `daysOfCover` is `null` (not Infinity, not a sentinel) when burn is
 * zero, per `DaysOfCoverRow`'s own contract in shared.ts.
 */
export function daysOfCover(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): DaysOfCoverRow[] {
  const now = new Date();
  const days = burnWindowDays(filters.range, now);

  // Statpack shortfall totals, reusing computeMostUsedItems (uncapped) rather
  // than re-deriving the requiredQuantity/countedQuantity math by hand.
  const filteredLogs = data.statpackLogs.filter(
    (log) =>
      inRange(log.timestamp, filters.range) &&
      passesCrossFilters({ packName: log.statpackName }, filters.crossFilters, tileId)
  );
  const burnByItem = new Map<string, number>(
    computeMostUsedItems(filteredLogs, Number.MAX_SAFE_INTEGER).map((m) => [m.itemName, m.usedCount])
  );

  // Restock action quantities add to burn the same way consumptionOverTime
  // treats them — a second proxy for units consumed that needed replacing.
  for (const action of data.restockActions) {
    const createdAt = toDate(action.createdAt);
    if (!inRange(createdAt, filters.range)) continue;
    const items = Array.isArray(action.items) ? action.items : [];
    for (const it of items) {
      const qty = typeof it?.quantity === 'number' ? it.quantity : 0;
      if (qty <= 0 || !it?.name) continue;
      burnByItem.set(it.name, (burnByItem.get(it.name) ?? 0) + qty);
    }
  }

  const rows: DaysOfCoverRow[] = [];
  for (const item of data.inventory) {
    // Assets are status-tracked (Ready/In Use/...), not quantity-tracked —
    // days-of-cover has no meaning for them.
    if (item.isAsset) continue;
    if (!passesCrossFilters({ itemName: item.name, category: item.category }, filters.crossFilters, tileId)) continue;

    // RESERVE pool only — see file header. Deliberately never adds
    // item.shelfQuantity in.
    const reserveUnits = computeBagStock(item, now).availableItems;
    const burnTotal = burnByItem.get(item.name) ?? 0;
    const burnPerDay = burnTotal / days;
    const daysOfCoverValue = burnPerDay > 0 ? reserveUnits / burnPerDay : null;

    rows.push({
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      reserveUnits,
      burnPerDay,
      daysOfCover: daysOfCoverValue,
    });
  }

  return rows.sort(compareDaysOfCover);
}

// ── 4. Usage per deployment (per-pack) ────────────────────────────────────

export interface UsagePerDeploymentRow {
  label: string;
  itemsUsed: number;
  checkouts: number;
  /** itemsUsed / checkouts, or null when the pack had zero checkouts in range. */
  perCheckout: number | null;
}

/**
 * Items-used and checkout counts per pack, reusing `computeStatpackStats`'s
 * per-pack rollup (which itself reuses `pairStatpackLogs`/
 * `calculateEventDuration` from logs.ts) so this tile's numbers always agree
 * with a pack's own history tab.
 */
export function usagePerDeployment(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): UsagePerDeploymentRow[] {
  const filteredLogs = data.statpackLogs.filter(
    (log) =>
      inRange(log.timestamp, filters.range) &&
      passesCrossFilters({ packName: log.statpackName }, filters.crossFilters, tileId)
  );
  const { perPack } = computeStatpackStats(filteredLogs, data.statpacks);
  return perPack.map((p) => ({
    label: p.statpackName,
    itemsUsed: p.itemsUsed,
    checkouts: p.checkouts,
    perCheckout: p.checkouts > 0 ? p.itemsUsed / p.checkouts : null,
  }));
}

// ── 5. Shelf drift — INTENTIONALLY ABSENT ──────────────────────────────────
//
// There is no `shelfDrift` selector, and no tile for it, because the data it
// would need is not persisted. `refillShelf` (app/lib/restock-actions.ts) SETS
// `shelfQuantity` to `observedShelfQty + consumed` — an absolute overwrite —
// and the only trace of the previous count is interpolated into a free-text
// `note` on an `inventory_logs` row. There is no structured "expected" value
// to diff an observation against, and `inventory_logs` is not loaded into
// `StatsData` either.
//
// To make it real: persist a structured `previousShelfQuantity` on that write,
// then add `inventory_logs` to StatsData/useStatsData. Until then, shipping the
// tile would mean fabricating drift numbers. See decisions.md D-27.

// ── 6. Expiry waste ────────────────────────────────────────────────────────

export interface ExpiryWasteRow {
  label: string;
  units: number;
  estValue: number | null;
}

/**
 * Units lost to expiry, grouped by item, from batches whose `expirationDate`
 * has passed. Zero-stock tombstone batches (box-tracked SKUs carry a
 * lot/expiry paper-trail batch with no real units — see `batchHasStock`'s
 * doc comment in item-status.ts and the box-tracked-SKU gap in CLAUDE.md)
 * are ignored, matching `getItemStatus`'s own expiry check.
 *
 * `estValue` is `null` for a group unless at least one contributing batch has
 * a known `purchase.pricePerUnit` — an unpriced batch's units still count
 * toward `units`, but a fabricated $0 would misreport waste cost.
 */
export function expiryWaste(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): ExpiryWasteRow[] {
  const now = new Date();
  const totals = new Map<string, { units: number; valueSum: number; hasKnownPrice: boolean }>();

  for (const item of data.inventory) {
    if (!passesCrossFilters({ itemName: item.name, category: item.category }, filters.crossFilters, tileId)) continue;
    const batches = item.batches || [];
    for (const b of batches) {
      if (!batchHasStock(b)) continue;
      if (!b.expirationDate || !(b.expirationDate < now)) continue;
      if (!inRange(b.expirationDate, filters.range)) continue;

      // Mirrors computeBagStock's per-batch unit math (item-status.ts): a
      // bag-tracked batch's units are bagCount*itemsPerBag+looseItems; a
      // non-bag batch falls back to its raw `stock` field (box-tracked SKUs
      // normally pool real stock onto item.unopenedBoxes instead, with a
      // stock:0 tombstone batch here — already excluded above by
      // batchHasStock — so a nonzero `stock` on this path is legacy/rare).
      const bags = b.bagCount ?? 0;
      const perBag = b.itemsPerBag ?? 0;
      const loose = b.looseItems ?? 0;
      const units = bags > 0 || perBag > 0 ? bags * perBag + loose : (b.stock ?? 0);
      if (units <= 0) continue;

      const price = b.purchase?.pricePerUnit;
      const entry = totals.get(item.name) ?? { units: 0, valueSum: 0, hasKnownPrice: false };
      entry.units += units;
      if (typeof price === 'number') {
        entry.valueSum += units * price;
        entry.hasKnownPrice = true;
      }
      totals.set(item.name, entry);
    }
  }

  return Array.from(totals.entries()).map(([label, t]) => ({
    label,
    units: t.units,
    estValue: t.hasKnownPrice ? t.valueSum : null,
  }));
}

// ── 7. Restock latency histogram ──────────────────────────────────────────

/**
 * Resolved `restock_reports` turnaround times, in hours (createdAt →
 * resolvedAt), filtered by `filters.range` on `createdAt`.
 *
 * `RestockReportDoc` carries a list of items rather than a single
 * itemName/category, so the closed-union `passesCrossFilters` helper (which
 * expects one value per field) doesn't apply cleanly — an itemName filter is
 * matched by hand against the report's item list instead.
 */
function collectResolvedRestockHours(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): number[] {
  const hours: number[] = [];
  const itemFilters = filters.crossFilters.filter((f) => f.field === 'itemName' && f.sourceTileId !== tileId);

  for (const report of data.restockReports) {
    if (!report.resolved) continue;
    const createdAt = toDate(report.createdAt);
    const resolvedAt = toDate(report.resolvedAt);
    if (!createdAt || !resolvedAt) continue;
    if (!inRange(createdAt, filters.range)) continue;

    if (itemFilters.length > 0) {
      const names = new Set((report.items || []).map((i) => i.name).filter((n): n is string => !!n));
      if (!itemFilters.every((f) => names.has(f.value))) continue;
    }

    const ms = resolvedAt.getTime() - createdAt.getTime();
    if (ms < 0) continue;
    hours.push(ms / (60 * 60 * 1000));
  }
  return hours;
}

export function restockLatencyHistogram(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; from: number; to: number; value: number }[] {
  return histogram(collectResolvedRestockHours(data, filters, tileId), 12);
}

// ── 8. Medication activity ────────────────────────────────────────────────

export interface MedicationActivityRow {
  label: string;
  administered: number;
  wasted: number;
  received: number;
}

/** Administered/wasted/received units per bucket, from `MedicationLog.action`. */
export function medicationActivity(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): MedicationActivityRow[] {
  const relevant = data.medicationLogs.filter((log) => {
    const d = toDate(log.timestamp);
    if (!inRange(d, filters.range)) return false;
    return passesCrossFilters({ itemName: log.medicationName }, filters.crossFilters, tileId);
  });

  const buckets = bucketBy(relevant, (log) => toDate(log.timestamp), filters.range, pickGranularity(filters.range));
  return buckets.map((b) => {
    let administered = 0, wasted = 0, received = 0;
    for (const log of b.items) {
      const qty = typeof log.quantity === 'number' ? log.quantity : 0;
      if (log.action === 'administered') administered += qty;
      else if (log.action === 'wasted' || log.action === 'expired_disposal') wasted += qty;
      else if (log.action === 'received') received += qty;
    }
    return { label: b.label, administered, wasted, received };
  });
}

// ── 9. Consumption KPIs ───────────────────────────────────────────────────

export interface ConsumptionKpis {
  /** Sum of consumptionOverTime; null only when no source data is loaded at all. */
  totalUnitsUsed: number | null;
  /** Count of daysOfCover rows with daysOfCover < 14; null when no inventory is loaded. */
  itemsAtRisk: number | null;
  /** Median resolved-restock turnaround, in hours; null when no resolved reports fall in range. */
  medianRestockLatencyHours: number | null;
  /** Sum of expiryWaste units; null when no inventory is loaded. */
  expiredUnits: number | null;
}

export function consumptionKpis(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): ConsumptionKpis {
  const hasConsumptionSources = data.statpackLogs.length > 0 || data.restockActions.length > 0;
  const totalUnitsUsed = hasConsumptionSources
    ? sum(consumptionOverTime(data, filters, tileId).map((b) => b.value))
    : null;

  const hasInventory = data.inventory.length > 0;
  const itemsAtRisk = hasInventory
    ? daysOfCover(data, filters, tileId).filter((r) => r.daysOfCover !== null && r.daysOfCover < 14).length
    : null;

  const medianRestockLatencyHours = median(collectResolvedRestockHours(data, filters, tileId));

  const expiredUnits = hasInventory
    ? sum(expiryWaste(data, filters, tileId).map((w) => w.units))
    : null;

  return { totalUnitsUsed, itemsAtRisk, medianRestockLatencyHours, expiredUnits };
}
