/**
 * Purchasing-dashboard selectors: pure functions that turn `StatsData` +
 * `StatsFilterState` into chart-ready rows for the Purchasing tab of /stats.
 *
 * No React, no Firestore reads — everything here operates on the already-
 * loaded `StatsData` bundle from `useStatsData` (see shared.ts). Every
 * function respects `filters.range` on whichever date is actually relevant
 * to that metric, and applies `passesCrossFilters` so tiles can cross-filter
 * each other Tableau-style.
 *
 * Money-missing handling follows the CLAUDE.md rule for this dashboard:
 * an unknown cost is `null`, never a silently-fabricated `0`, EXCEPT where a
 * spec below explicitly calls for 0 (e.g. `spendByCategory` allocating a
 * costless line as $0 spend — that's a true statement, "no cost was
 * recorded for this line", not a guessed price).
 */

import type { Purchase, PurchaseLine, BuyListItem } from '@/app/types';
import { purchaseTotal } from '@/app/lib/purchases';
import {
  toDate,
  inRange,
  bucketBy,
  bucketLabel,
  groupBy,
  sum,
  mean,
  median,
  percentile,
  topNWithOther,
  passesCrossFilters,
  type StatsData,
  type StatsFilterState,
} from './shared';

// ── Shared line-level helpers ────────────────────────────────────────────────

/**
 * Unit price actually paid for one line, from the receipt (not the order):
 * lineCost / (receivedQty * unitsPerPackage). `unitsPerPackage` defaults to 1
 * when absent (a package of 1 is the common case — most consumables aren't
 * sold in multi-packs), but `lineCost` and `receivedQty` must be real,
 * non-zero numbers or we return null rather than divide by zero or invent a
 * price for a line that was never priced.
 */
function computeUnitPrice(line: PurchaseLine): number | null {
  if (!line.lineCost || !line.receivedQty) return null;
  const perPackage = line.unitsPerPackage ?? 1;
  if (!perPackage) return null;
  return line.lineCost / (line.receivedQty * perPackage);
}

// ── 1. Spend over time ───────────────────────────────────────────────────────

export interface SpendOverTimeRow {
  label: string;
  total: number;
  subtotal: number;
  shipping: number;
  tax: number;
}

/**
 * Spend bucketed by `Purchase.orderDate`. Sums (not averages) legitimately
 * treat a missing subtotal/shipping/tax as "$0 of that component" — this
 * mirrors `purchaseTotal()` itself, which already does the same `|| 0`
 * fallback; a sum of known values is not a fabricated aggregate the way an
 * average or unit price would be.
 */
export function spendOverTime(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): SpendOverTimeRow[] {
  const relevant = data.purchases.filter((p) =>
    passesCrossFilters({ vendor: p.vendor }, filters.crossFilters, tileId)
  );
  const buckets = bucketBy(relevant, (p) => toDate(p.orderDate), filters.range);
  return buckets.map((b) => ({
    label: b.label,
    total: sum(b.items.map((p) => purchaseTotal(p))),
    subtotal: sum(b.items.map((p) => p.subtotal || 0)),
    shipping: sum(b.items.map((p) => p.shipping || 0)),
    tax: sum(b.items.map((p) => p.tax || 0)),
  }));
}

// ── 2. Spend by vendor ───────────────────────────────────────────────────────

export interface SpendByLabelRow {
  label: string;
  value: number;
}

/** Total spend per vendor, top 8 with the remainder rolled into "Other". */
export function spendByVendor(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): SpendByLabelRow[] {
  const relevant = data.purchases.filter((p) => {
    const d = toDate(p.orderDate);
    if (!d || !inRange(d, filters.range)) return false;
    return passesCrossFilters({ vendor: p.vendor }, filters.crossFilters, tileId);
  });
  const groups = groupBy(relevant, (p) => p.vendor || 'Unknown vendor');
  const rows: SpendByLabelRow[] = [...groups.entries()].map(([vendor, purchases]) => ({
    label: vendor,
    value: sum(purchases.map((p) => purchaseTotal(p))),
  }));
  return topNWithOther(rows, 8);
}

// ── 3. Spend by category ─────────────────────────────────────────────────────

/**
 * Spend by `PurchaseLine.category`, allocating each line's own `lineCost`.
 * Deliberately NOT allocating shipping/tax down to the line level — those
 * are order-level charges with no honest per-line split (a $12 shipping fee
 * doesn't belong to one category over another), so category totals are
 * goods-only and won't sum to the order `total` shown elsewhere. Lines with
 * no `lineCost` contribute exactly $0 (a true "no cost recorded" statement,
 * not a guessed price) so every line is still represented.
 */
export function spendByCategory(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): SpendByLabelRow[] {
  const priced: { category: string; lineCost: number }[] = [];
  for (const purchase of data.purchases) {
    const d = toDate(purchase.orderDate);
    if (!d || !inRange(d, filters.range)) continue;
    for (const line of purchase.lines) {
      if (
        !passesCrossFilters(
          { vendor: purchase.vendor, category: line.category, itemName: line.itemName },
          filters.crossFilters,
          tileId
        )
      ) {
        continue;
      }
      priced.push({ category: line.category || 'Uncategorized', lineCost: line.lineCost || 0 });
    }
  }
  const groups = groupBy(priced, (r) => r.category);
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, value: sum(rows.map((r) => r.lineCost)) }))
    .sort((a, b) => b.value - a.value);
}

// ── 4/5. Unit price trend ────────────────────────────────────────────────────

export interface UnitPriceTrendRow {
  label: string;
  unitPrice: number;
  vendor: string;
}

/**
 * Per-receipt unit price history for one item name, across vendors and time.
 * Points, not buckets — averaging price into weekly/monthly buckets would
 * hide exactly the vendor-to-vendor or order-to-order variance this tile
 * exists to show. Dated by `receivedAt` (when the price was actually paid),
 * falling back to `orderDate` only if a received line is somehow missing its
 * own receipt timestamp.
 *
 * Signature intentionally omits `tileId` (per spec) — `itemName` is a hard
 * argument from the item picker, not a cross-filter this tile emits, so
 * there's no "own tile" self-filter to skip.
 */
export function unitPriceTrend(
  data: StatsData,
  filters: StatsFilterState,
  itemName: string
): UnitPriceTrendRow[] {
  const rows: (UnitPriceTrendRow & { date: Date })[] = [];
  for (const purchase of data.purchases) {
    for (const line of purchase.lines) {
      if (line.itemName !== itemName) continue;
      const unitPrice = computeUnitPrice(line);
      if (unitPrice === null) continue;
      const date = toDate(line.receivedAt) ?? toDate(purchase.orderDate);
      if (!date || !inRange(date, filters.range)) continue;
      if (!passesCrossFilters({ vendor: purchase.vendor, itemName: line.itemName }, filters.crossFilters)) {
        continue;
      }
      rows.push({ label: bucketLabel(date, 'day'), unitPrice, vendor: purchase.vendor, date });
    }
  }
  return rows
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map(({ label, unitPrice, vendor }) => ({ label, unitPrice, vendor }));
}

/**
 * Item names with >= 2 priced receipts — the only ones for which a unit
 * price *trend* means anything (a single data point has no trend). Feeds the
 * item picker for `unitPriceTrend`. Data-only per spec: this is a catalog
 * query, not a filtered/cross-filtered view, so it ignores `filters`.
 */
export function unitPriceItems(data: StatsData): string[] {
  const counts = new Map<string, number>();
  for (const purchase of data.purchases) {
    for (const line of purchase.lines) {
      if (computeUnitPrice(line) === null) continue;
      counts.set(line.itemName, (counts.get(line.itemName) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

// ── 6. Buy-list latency ──────────────────────────────────────────────────────

export type BuyListLatencyStage = 'request→order' | 'order→receive' | 'request→receive';

export interface BuyListLatencyRow {
  stage: BuyListLatencyStage;
  medianDays: number | null;
  p90Days: number | null;
  n: number;
}

/**
 * How long each stage of the buy-list pipeline takes, in days, from
 * `BuyListItem.addedAt/orderedAt/receivedAt`. Range-gated on `addedAt` (the
 * request date) since that's the one timestamp every row has, regardless of
 * how far it's progressed. A row only contributes to a stage when BOTH of
 * that stage's timestamps are present — an item still `pending` has no
 * `orderedAt`/`receivedAt` yet and correctly contributes to none of the
 * three stages rather than being counted as "0 days".
 */
export function buyListLatency(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): BuyListLatencyRow[] {
  const reqToOrder: number[] = [];
  const orderToReceive: number[] = [];
  const reqToReceive: number[] = [];

  for (const item of data.buyList) {
    if (!passesCrossFilters({ category: item.category, itemName: item.itemName }, filters.crossFilters, tileId)) {
      continue;
    }
    const added = toDate(item.addedAt);
    if (!added || !inRange(added, filters.range)) continue;
    const ordered = toDate(item.orderedAt);
    const received = toDate(item.receivedAt);
    if (ordered) reqToOrder.push((ordered.getTime() - added.getTime()) / 86_400_000);
    if (ordered && received) orderToReceive.push((received.getTime() - ordered.getTime()) / 86_400_000);
    if (received) reqToReceive.push((received.getTime() - added.getTime()) / 86_400_000);
  }

  const toRow = (stage: BuyListLatencyStage, values: number[]): BuyListLatencyRow => ({
    stage,
    medianDays: median(values),
    p90Days: percentile(values, 90),
    n: values.length,
  });

  return [
    toRow('request→order', reqToOrder),
    toRow('order→receive', orderToReceive),
    toRow('request→receive', reqToReceive),
  ];
}

// ── 7. Open orders aging ─────────────────────────────────────────────────────

export interface OpenOrderAgingRow {
  label: string;
  vendor: string;
  daysOpen: number;
  total: number;
  status: Purchase['status'];
}

/** Orders still open (not `received`/`cancelled`), oldest (most days open) first. */
export function openOrdersAging(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): OpenOrderAgingRow[] {
  const now = new Date();
  const rows: OpenOrderAgingRow[] = [];
  for (const p of data.purchases) {
    if (p.status === 'received' || p.status === 'cancelled') continue;
    const orderDate = toDate(p.orderDate);
    if (!orderDate || !inRange(orderDate, filters.range)) continue;
    if (!passesCrossFilters({ vendor: p.vendor }, filters.crossFilters, tileId)) continue;
    rows.push({
      label: p.poNumber || p.vendor,
      vendor: p.vendor,
      daysOpen: Math.round((now.getTime() - orderDate.getTime()) / 86_400_000),
      total: purchaseTotal(p),
      status: p.status,
    });
  }
  return rows.sort((a, b) => b.daysOpen - a.daysOpen);
}

// ── 8. Order fill rate ───────────────────────────────────────────────────────

export interface OrderFillRateLine {
  label: string;
  ordered: number;
  received: number;
  shortBy: number;
}

export interface OrderFillRateResult {
  overall: number | null;
  lines: OrderFillRateLine[];
}

/**
 * Received-vs-ordered fill rate. Only counts lines on orders that have
 * actually progressed to `received`/`partially_received` — a purely
 * `ordered` order hasn't been fulfilled OR failed to fulfill yet, so
 * including its lines would count "not yet received" as "short" when it's
 * really just "not due yet". `shortBy` is clamped at 0 so an over-receipt
 * doesn't show as negative shortage.
 */
export function orderFillRate(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): OrderFillRateResult {
  const lines: OrderFillRateLine[] = [];
  let orderedTotal = 0;
  let receivedTotal = 0;

  for (const purchase of data.purchases) {
    if (purchase.status !== 'received' && purchase.status !== 'partially_received') continue;
    const orderDate = toDate(purchase.orderDate);
    if (!orderDate || !inRange(orderDate, filters.range)) continue;
    for (const line of purchase.lines) {
      if (
        !passesCrossFilters(
          { vendor: purchase.vendor, category: line.category, itemName: line.itemName },
          filters.crossFilters,
          tileId
        )
      ) {
        continue;
      }
      const ordered = line.orderedQty || 0;
      const received = line.received ? line.receivedQty ?? 0 : 0;
      orderedTotal += ordered;
      receivedTotal += received;
      lines.push({ label: line.itemName, ordered, received, shortBy: Math.max(0, ordered - received) });
    }
  }

  return { overall: orderedTotal > 0 ? receivedTotal / orderedTotal : null, lines };
}

// ── 9. Procurement KPIs ──────────────────────────────────────────────────────

export interface ProcurementKpis {
  totalSpend: number;
  orderCount: number;
  avgOrderValue: number | null;
  overheadPct: number | null;
  openOrderCount: number;
  medianRequestToShelfDays: number | null;
}

/**
 * Headline procurement numbers for the KPI strip. `totalSpend`/`orderCount`
 * are legitimately 0 when no purchases fall in range (that's a real "no
 * spend" state, not missing data). `overheadPct` and
 * `medianRequestToShelfDays` are `null` when there's nothing to compute from
 * — never a fabricated 0%/0-day placeholder.
 */
export function procurementKpis(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): ProcurementKpis {
  const purchases = data.purchases.filter((p) => {
    const d = toDate(p.orderDate);
    if (!d || !inRange(d, filters.range)) return false;
    return passesCrossFilters({ vendor: p.vendor }, filters.crossFilters, tileId);
  });

  const totalSpend = sum(purchases.map((p) => purchaseTotal(p)));
  const orderCount = purchases.length;
  const avgOrderValue = mean(purchases.map((p) => purchaseTotal(p)));

  // Overhead is computed only from orders that actually recorded a subtotal
  // — an order with no subtotal entered isn't "0% overhead", it's unknown,
  // and folding a missing subtotal in as 0 would silently dilute the ratio.
  const withSubtotal = purchases.filter((p): p is Purchase & { subtotal: number } => (p.subtotal ?? 0) > 0);
  const subtotalSum = sum(withSubtotal.map((p) => p.subtotal));
  const overheadSum = sum(withSubtotal.map((p) => (p.shipping || 0) + (p.tax || 0)));
  const overheadPct = subtotalSum > 0 ? overheadSum / subtotalSum : null;

  const openOrderCount = purchases.filter((p) => p.status !== 'received' && p.status !== 'cancelled').length;

  // "Request to shelf" = buy-list request through actual receipt. Computed
  // independently rather than reusing `buyListLatency`'s request→receive
  // stage because `BuyListItem` carries no vendor field, so it can't share
  // the vendor-filtered `purchases` list above — only category/itemName
  // cross-filters apply to it.
  const requestToShelf: number[] = [];
  for (const item of data.buyList as BuyListItem[]) {
    if (!passesCrossFilters({ category: item.category, itemName: item.itemName }, filters.crossFilters, tileId)) {
      continue;
    }
    const added = toDate(item.addedAt);
    if (!added || !inRange(added, filters.range)) continue;
    const received = toDate(item.receivedAt);
    if (received) requestToShelf.push((received.getTime() - added.getTime()) / 86_400_000);
  }

  return {
    totalSpend,
    orderCount,
    avgOrderValue,
    overheadPct,
    openOrderCount,
    medianRequestToShelfDays: median(requestToShelf),
  };
}
