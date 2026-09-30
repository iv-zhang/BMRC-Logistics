/**
 * Shared inventory item status logic.
 *
 * Single source of truth for "how much stock does this item have?", "where is
 * it?", and "what status chip does it get?". The inventory page, audit page,
 * and dashboard must all agree on these answers — import from here instead of
 * re-implementing.
 *
 * Expiration windows come from THRESHOLDS in org-config; do not hardcode day
 * counts in pages.
 */

import { getThresholds, getSemesterStartRuntime } from '@/app/lib/org-config-store';
import { AUDIT_CADENCES, type AuditCadence } from '@/app/config/org-config';
import {
  formatStorageLocation,
  formatLevelLabel,
  LOCATION_SEPARATOR,
} from '@/app/utils/storage-location';
import type { InventoryBatch, InventoryItem, ItemExistence } from '@/app/types';

export type ItemStatus = 'ok' | 'low' | 'out' | 'expired' | 'expiring';

export interface BagStock {
  totalBags: number;
  totalLoose: number;
  /**
   * PHYSICAL on-hand count — every unit sitting on the shelf, INCLUDING expired
   * and quarantined lots. Inventory/audit UIs rely on this to show what is
   * physically present; do NOT narrow its meaning.
   */
  totalItems: number;
  /**
   * DEPLOYABLE count — units that may actually be used/counted toward a pack:
   * has stock AND not past expiration AND not `status==='quarantined'`. This is
   * the number readiness/availability decisions must consult (never `totalItems`).
   */
  availableItems: number;
  hasBagTracking: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date after which a batch counts as "expiring soon" (org-config driven). */
export function expiringCutoff(now = new Date()): Date {
  return new Date(now.getTime() + getThresholds().expirationWarningDays * DAY_MS);
}

/**
 * Compute on-hand stock for an item. Batch-level bag tracking (bagCount /
 * itemsPerBag / looseItems) is the source of truth when present; otherwise
 * fall back to item-level box counts.
 *
 * Two-pool model: this total = back-room RESERVE pool (front-shelf stock is
 * tracked separately in `InventoryItem.shelfQuantity`).
 */
export function computeBagStock(item: InventoryItem, now = new Date()): BagStock {
  const batches = item.batches || [];
  const hasBagTracking = batches.some(
    b => (b.bagCount !== undefined && b.bagCount > 0) ||
         (b.itemsPerBag !== undefined && (b.itemsPerBag ?? 0) > 0),
  );
  if (hasBagTracking) {
    let totalBags = 0, totalLoose = 0, totalItems = 0, availableItems = 0;
    for (const b of batches) {
      const bags = b.bagCount ?? 0, perBag = b.itemsPerBag ?? 0, loose = b.looseItems ?? 0;
      const units = bags * perBag + loose;
      totalBags += bags; totalLoose += loose; totalItems += units;
      // A lot is deployable only if it is not past its expiration and not
      // quarantined/recalled. Expired-or-recalled stock is still PHYSICALLY on
      // hand (counts toward totalItems) but must never be treated as available.
      const expired = b.expirationDate ? b.expirationDate < now : false;
      const quarantined = b.status === 'quarantined';
      if (!expired && !quarantined) availableItems += units;
    }
    return { totalBags, totalLoose, totalItems, availableItems, hasBagTracking: true };
  }
  const boxes = item.unopenedBoxes ?? 0, perBox = item.itemsPerBox ?? 0, loose = item.looseUnits ?? 0;
  const totalItems = perBox > 0 ? boxes * perBox + loose : boxes;
  // Box-tracked stock has no per-lot quantity (quantity pools onto unopenedBoxes
  // and lots are stock:0 tombstones — see B-5), so availability equals physical.
  return {
    totalBags: boxes, totalLoose: loose,
    totalItems, availableItems: totalItems,
    hasBagTracking: false,
  };
}

/**
 * A batch only counts toward expiry/expiring status if it actually has stock on
 * hand. Zero-stock traceability "tombstone" batches (written by `addShipment`
 * for box-tracked items to keep a lot/expiry paper trail) carry an
 * `expirationDate` but no units, so they must never flag the item expired.
 */
export function batchHasStock(b: InventoryBatch): boolean {
  return ((b.stock ?? 0) > 0) ||
         ((b.bagCount ?? 0) > 0) ||
         ((b.looseItems ?? 0) > 0);
}

/**
 * Human-readable location path for an item (structured ref preferred).
 * Both the structured and legacy branches use the same canonical separator and
 * `L#` level style (UX-5) so an item reads identically however it's stored.
 */
export function displayLocation(item: InventoryItem): string {
  if (item.storageLocation) return formatStorageLocation(item.storageLocation);
  const parts = [item.location || '', item.room || ''];
  if (item.shelf) parts.push(`Shelf ${item.shelf}`);
  if (item.backLevel) parts.push(formatLevelLabel(item.backLevel));
  return parts.filter(Boolean).join(LOCATION_SEPARATOR);
}

/** Overall status for an item: expired > out > low > expiring > ok. */
export function getItemStatus(item: InventoryItem): ItemStatus {
  const now = new Date();
  const bag = computeBagStock(item, now);
  const cutoff = expiringCutoff(now);
  const batches = item.batches || [];
  // DATA-7: only batches that still have stock on hand can flag expiry — a
  // zero-stock tombstone batch must not mark the item expired forever.
  if (batches.some(b => batchHasStock(b) && b.expirationDate && b.expirationDate < now))
    return 'expired';
  if (item.isOxygen) return 'ok';
  // Deliberately keyed on the RESERVE pool only, never the front shelf: an
  // item with a full front shelf but an empty back room must still read
  // 'out' for reordering purposes — the shelf is not a substitute for
  // reserve stock. Do not fold `shelfQuantity` into this decision.
  // Availability, not physical count, drives out/low: an item whose only stock is
  // expired or quarantined has zero deployable units and must read 'out', never 'ok'.
  if (bag.availableItems === 0) return 'out';
  if (item.reorderThreshold > 0 && bag.availableItems <= item.reorderThreshold) return 'low';
  if (batches.some(b => b.expirationDate && b.expirationDate >= now && b.expirationDate <= cutoff))
    return 'expiring';
  return 'ok';
}

// ── Existence (confirmed / unverified / retired) ─────────────────────────────

/**
 * Baseline cutoff for "confirmed" stock: an item counts as confirmed only if an
 * audit on/after this date saw it (local midnight, 2026-06-01). Earlier audits
 * predate the hygiene pass and are not trusted. Month index 5 = June.
 */
export const EXISTENCE_BASELINE_CUTOFF = new Date(2026, 5, 1);

function asDate(v: unknown): Date | undefined {
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v;
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try {
      const d = (v as { toDate: () => Date }).toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Does this record physically exist, as far as we can prove?
 *   - `retired`     stored `existence === 'retired'` (terminal, wins over everything).
 *   - `confirmed`   not retired AND `lastAuditDate >= EXISTENCE_BASELINE_CUTOFF`.
 *   - `unverified`  everything else (including items with no audit date).
 * Derived, not asserted: a stored 'confirmed'/'unverified' is ignored so a flag
 * set once can never stay true forever (see D-6 for the same reasoning).
 */
export function getExistence(
  item: Pick<InventoryItem, 'existence' | 'lastAuditDate'>,
): ItemExistence {
  if (item.existence === 'retired') return 'retired';
  const audited = asDate(item.lastAuditDate);
  if (audited && audited.getTime() >= EXISTENCE_BASELINE_CUTOFF.getTime()) return 'confirmed';
  return 'unverified';
}

/**
 * True for items that may drive alerts, restock decisions, and exception
 * lists. Unverified and retired items must not (they may not exist).
 */
export function isConfirmedItem(item: Pick<InventoryItem, 'existence' | 'lastAuditDate'>): boolean {
  return getExistence(item) === 'confirmed';
}

// ── Procurement: on-the-way display (Log Purchase → Receive) ─────────────────
// Display-only — on-order is NOT on-hand, so these never feed computeBagStock
// or getItemStatus. A placeholder row (0 stock) shows "On the way"; a stocked
// item shows its real status plus a "+N incoming" chip.

/** True when this item has one or more pending purchase-order lines. */
export function isOnTheWay(item: InventoryItem): boolean {
  return (item.incomingOrders?.length ?? 0) > 0;
}

/** Total incoming units across all pending purchase-order lines for this item. */
export function incomingQty(item: InventoryItem): number {
  return (item.incomingOrders || []).reduce(
    (sum, o) => sum + o.qty * (o.unitsPerPackage || 1),
    0,
  );
}

/** "Mar 2027" or "Expired Mar 2025". */
export function formatExp(date?: Date): string {
  if (!date) return '—';
  const now = new Date();
  const label = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return date < now ? `Expired ${label}` : label;
}

export function expTextColor(date?: Date): string {
  if (!date) return 'text-foreground-400';
  const now = new Date();
  if (date < now) return 'text-danger';
  if (date <= expiringCutoff(now)) return 'text-warning';
  return 'text-success';
}

export function statusQtyColor(s: ItemStatus): string {
  if (s === 'ok' || s === 'expiring') return 'text-success';
  if (s === 'low') return 'text-warning';
  return 'text-danger';
}

export function statusBarColor(s: ItemStatus): string {
  if (s === 'ok' || s === 'expiring') return 'bg-success';
  if (s === 'low') return 'bg-warning';
  return 'bg-danger';
}

// ── Audit cycle ───────────────────────────────────────────────────────────────

/**
 * Supplies are audited on a cycle (monthly by default; see `AuditCadence`). An
 * item counts as "verified" only if its last audit falls in the current cycle —
 * the sticky `auditVerified` boolean alone is meaningless across cycles.
 *
 * `isAuditedThisMonth` is the original monthly check and is unchanged. New code
 * should call `isAuditCurrent`, which follows the org's configured cadence.
 */
export function isAuditedThisMonth(lastAuditDate?: Date, now = new Date()): boolean {
  if (!lastAuditDate) return false;
  return lastAuditDate.getFullYear() === now.getFullYear() &&
         lastAuditDate.getMonth() === now.getMonth();
}

/** The configured cadence, falling back to monthly for a missing/corrupt value. */
export function getAuditCadence(): AuditCadence {
  const v = getThresholds().auditCadence;
  return (AUDIT_CADENCES as readonly string[]).includes(v) ? v : 'monthly';
}

/** Calendar half-year start (Jan 1 or Jul 1) for `now`. */
function halfYearStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() < 6 ? 0 : 6, 1);
}

/**
 * Start of the current semester window: the configured semester start, but never
 * earlier than the calendar half-year start (a forgotten, stale
 * `semesterStartDate` must not silently stretch the window — fail toward
 * stricter) and never in the future.
 */
function semesterWindowStart(now: Date, semesterStart?: Date): Date {
  const half = halfYearStart(now);
  let cfg = semesterStart;
  if (!cfg) {
    const iso = getSemesterStartRuntime();
    const d = iso ? new Date(`${iso}T00:00:00`) : undefined;
    cfg = d && !isNaN(d.getTime()) ? d : undefined;
  }
  if (!cfg || cfg.getTime() > now.getTime()) return half;
  return cfg.getTime() > half.getTime() ? cfg : half;
}

/**
 * Cadence-aware "is this item's audit current?". With `cadence === 'monthly'`
 * (the default) it is exactly `isAuditedThisMonth`.
 *   - monthly    same calendar year + month
 *   - quarterly  same calendar year + quarter (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec)
 *   - semester   on/after the semester window start (see `semesterWindowStart`)
 *   - yearly     same calendar year
 * Never audited (`undefined`) is always not current.
 */
export function isAuditCurrent(
  lastAuditDate?: Date,
  now = new Date(),
  cadence: AuditCadence = getAuditCadence(),
  semesterStart?: Date,
): boolean {
  if (!lastAuditDate) return false;
  switch (cadence) {
    case 'quarterly':
      return lastAuditDate.getFullYear() === now.getFullYear() &&
             Math.floor(lastAuditDate.getMonth() / 3) === Math.floor(now.getMonth() / 3);
    case 'semester':
      return lastAuditDate.getTime() >= semesterWindowStart(now, semesterStart).getTime() &&
             lastAuditDate.getTime() <= now.getTime() + DAY_MS;
    case 'yearly':
      return lastAuditDate.getFullYear() === now.getFullYear();
    case 'monthly':
    default:
      return isAuditedThisMonth(lastAuditDate, now);
  }
}

/** Short period word for messages: "this month" / "this quarter" / "this semester" / "this year". */
export function auditCyclePeriod(cadence: AuditCadence = getAuditCadence()): string {
  switch (cadence) {
    case 'quarterly': return 'this quarter';
    case 'semester': return 'this semester';
    case 'yearly': return 'this year';
    default: return 'this month';
  }
}

/** Cadence-aware cycle label: "July 2026" / "Q3 2026" / "Semester from Aug 25, 2026" / "2026". */
export function auditCycleLabel(now = new Date(), cadence: AuditCadence = getAuditCadence(), semesterStart?: Date): string {
  switch (cadence) {
    case 'quarterly': return `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
    case 'semester':
      return `Semester from ${semesterWindowStart(now, semesterStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    case 'yearly': return String(now.getFullYear());
    default: return currentAuditCycleLabel(now);
  }
}

/** Label like "July 2026" for the current (monthly) audit cycle. */
export function currentAuditCycleLabel(now = new Date()): string {
  return now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Biweekly statpack audit cycle ─────────────────────────────────────────────

/**
 * Statpacks are audited on a biweekly cadence (THRESHOLDS.statpackAuditIntervalDays).
 * A pack is "current" only if its last audit is within the interval.
 */
export function isStatpackAuditCurrent(lastAuditDate?: Date, now = new Date()): boolean {
  if (!lastAuditDate) return false;
  const ageDays = (now.getTime() - lastAuditDate.getTime()) / DAY_MS;
  return ageDays <= getThresholds().statpackAuditIntervalDays;
}

/** Days until a statpack audit is due (negative = overdue by that many days). */
export function statpackAuditDueInDays(lastAuditDate?: Date, now = new Date()): number | undefined {
  if (!lastAuditDate) return undefined;
  const ageDays = (now.getTime() - lastAuditDate.getTime()) / DAY_MS;
  return Math.round(getThresholds().statpackAuditIntervalDays - ageDays);
}

// ── Weekly front-shelf check cadence ──────────────────────────────────────────

/**
 * The front restock shelf (`InventoryItem.shelfQuantity`) is deliberately not
 * event-tracked (see `app/lib/restock-actions.ts`); instead it's re-anchored
 * by a physical weekly check. An item's shelf count is "current" only if
 * `lastShelfCheckAt` falls within `THRESHOLDS.shelfCheckIntervalDays` of now.
 */
export function isShelfCheckCurrent(item: InventoryItem, now = new Date()): boolean {
  if (!item.lastShelfCheckAt) return false;
  const ageDays = (now.getTime() - item.lastShelfCheckAt.getTime()) / DAY_MS;
  return ageDays <= getThresholds().shelfCheckIntervalDays;
}
