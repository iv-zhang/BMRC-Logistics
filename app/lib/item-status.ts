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

import { THRESHOLDS } from '@/app/config/org-config';
import { formatStorageLocation } from '@/app/utils/storage-location';
import type { InventoryItem } from '@/app/types';

export type ItemStatus = 'ok' | 'low' | 'out' | 'expired' | 'expiring';

export interface BagStock {
  totalBags: number;
  totalLoose: number;
  totalItems: number;
  hasBagTracking: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date after which a batch counts as "expiring soon" (org-config driven). */
export function expiringCutoff(now = new Date()): Date {
  return new Date(now.getTime() + THRESHOLDS.expirationWarningDays * DAY_MS);
}

/**
 * Compute on-hand stock for an item. Batch-level bag tracking (bagCount /
 * itemsPerBag / looseItems) is the source of truth when present; otherwise
 * fall back to item-level box counts.
 */
export function computeBagStock(item: InventoryItem): BagStock {
  const batches = item.batches || [];
  const hasBagTracking = batches.some(
    b => (b.bagCount !== undefined && b.bagCount > 0) ||
         (b.itemsPerBag !== undefined && (b.itemsPerBag ?? 0) > 0),
  );
  if (hasBagTracking) {
    let totalBags = 0, totalLoose = 0, totalItems = 0;
    for (const b of batches) {
      const bags = b.bagCount ?? 0, perBag = b.itemsPerBag ?? 0, loose = b.looseItems ?? 0;
      totalBags += bags; totalLoose += loose; totalItems += bags * perBag + loose;
    }
    return { totalBags, totalLoose, totalItems, hasBagTracking: true };
  }
  const boxes = item.unopenedBoxes ?? 0, perBox = item.itemsPerBox ?? 0, loose = item.looseUnits ?? 0;
  return {
    totalBags: boxes, totalLoose: loose,
    totalItems: perBox > 0 ? boxes * perBox + loose : boxes,
    hasBagTracking: false,
  };
}

/** Human-readable location path for an item (structured ref preferred). */
export function displayLocation(item: InventoryItem): string {
  if (item.storageLocation) return formatStorageLocation(item.storageLocation);
  const parts = [item.location || '', item.room || ''];
  if (item.shelf) parts.push(`Shelf ${item.shelf}`);
  if (item.backLevel) parts.push(`L${item.backLevel}`);
  return parts.filter(Boolean).join(' › ');
}

/** Overall status for an item: expired > out > low > expiring > ok. */
export function getItemStatus(item: InventoryItem): ItemStatus {
  const bag = computeBagStock(item);
  const now = new Date();
  const cutoff = expiringCutoff(now);
  const batches = item.batches || [];
  if (batches.some(b => b.expirationDate && b.expirationDate < now)) return 'expired';
  if (item.isOxygen) return 'ok';
  if (bag.totalItems === 0) return 'out';
  if (item.reorderThreshold > 0 && bag.totalItems <= item.reorderThreshold) return 'low';
  if (batches.some(b => b.expirationDate && b.expirationDate >= now && b.expirationDate <= cutoff))
    return 'expiring';
  return 'ok';
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

// ── Monthly audit cycle ───────────────────────────────────────────────────────

/**
 * Supplies are audited on a monthly cycle. An item counts as "verified" only
 * if its last audit happened in the current calendar month — the sticky
 * `auditVerified` boolean alone is meaningless across months.
 */
export function isAuditedThisMonth(lastAuditDate?: Date, now = new Date()): boolean {
  if (!lastAuditDate) return false;
  return lastAuditDate.getFullYear() === now.getFullYear() &&
         lastAuditDate.getMonth() === now.getMonth();
}

/** Label like "July 2026" for the current audit cycle. */
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
  return ageDays <= THRESHOLDS.statpackAuditIntervalDays;
}

/** Days until a statpack audit is due (negative = overdue by that many days). */
export function statpackAuditDueInDays(lastAuditDate?: Date, now = new Date()): number | undefined {
  if (!lastAuditDate) return undefined;
  const ageDays = (now.getTime() - lastAuditDate.getTime()) / DAY_MS;
  return Math.round(THRESHOLDS.statpackAuditIntervalDays - ageDays);
}
