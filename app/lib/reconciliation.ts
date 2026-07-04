/**
 * Reconciliation / exceptions engine.
 *
 * The dashboard shows stored data as truth even when members skipped steps, so
 * silent problems never surface (false green). This module derives a standing
 * list of exceptions from the *actual* item/pack state — orphaned locations,
 * dated SKUs with no expiration on file, stale audits, overdue packs, and
 * expired stock physically present. It answers Tier-2 HR-3 / HR-7 / HR-10:
 * "any step a member can skip needs a reconciliation surface that catches it."
 *
 * Pure functions only — no React, no Firestore. The page hydrates Firestore
 * Timestamps → Dates before calling `buildExceptions`; the small `toDate`
 * helper below is a defensive guard in case a raw Timestamp slips through.
 */

import {
  computeBagStock,
  getItemStatus,
  isAuditedThisMonth,
  isStatpackAuditCurrent,
  batchHasStock,
} from '@/app/lib/item-status';
import type { InventoryItem, Statpack } from '@/app/types';

export type ExceptionSeverity = 'high' | 'medium' | 'low';

export interface ReconciliationException {
  severity: ExceptionSeverity;
  /** Stable machine kind, e.g. 'orphaned_location'. */
  kind: string;
  itemId?: string;
  itemName: string;
  detail: string;
}

/**
 * Coerce a possibly-Timestamp value into a Date. Callers are expected to pass
 * already-hydrated Dates, but a Firestore `Timestamp` (or any `{ toDate() }`)
 * is handled so the engine never throws on a raw document field.
 */
function toDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return isNaN(val.getTime()) ? undefined : val;
  if (typeof val === 'object' && typeof (val as { toDate?: () => Date }).toDate === 'function') {
    try {
      const d = (val as { toDate: () => Date }).toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Does the item carry an expiration on any *stocked* batch, or item-level? */
function hasAnyExpiration(item: InventoryItem): boolean {
  if (toDate(item.expirationDate)) return true;
  const batches = item.batches || [];
  return batches.some(b => batchHasStock(b) && !!toDate(b.expirationDate));
}

/**
 * Build the standing exception list from live inventory + statpacks.
 * Sorted high → low severity (stable within a severity by scan order).
 */
export function buildExceptions(
  items: InventoryItem[],
  statpacks: Statpack[],
  now: Date = new Date(),
): ReconciliationException[] {
  const out: ReconciliationException[] = [];

  for (const item of items || []) {
    const name = item.name || 'Unnamed item';

    // ORPHANED LOCATION — residue of a skipped intake/move step. The structured
    // ref is truth; legacy location/room are denormalized mirrors. If none of
    // them exist, the item has effectively vanished from every location view.
    const hasLocation = !!item.storageLocation || !!item.location || !!item.room;
    if (!hasLocation) {
      out.push({
        severity: 'high',
        kind: 'orphaned_location',
        itemId: item.id,
        itemName: name,
        detail: 'No storage location on file — item is invisible to location views.',
      });
    }

    // MISSING EXPIRATION — a dated SKU with stock but no expiration date anywhere
    // reads as "never expires" and can sit in a Ready pack indefinitely.
    const isDated = !!item.tracksExpiration || !!item.requiresExpirationCheck;
    if (isDated) {
      const hasStock = computeBagStock(item, now).totalItems > 0;
      if (hasStock && !hasAnyExpiration(item)) {
        out.push({
          severity: 'high',
          kind: 'missing_expiration',
          itemId: item.id,
          itemName: name,
          detail: 'Dated item has stock but no expiration on file — silently reads as never-expiring.',
        });
      }
    }

    // EXPIRED PRESENT — expired stock is physically on hand right now.
    if (getItemStatus(item) === 'expired') {
      out.push({
        severity: 'high',
        kind: 'expired_present',
        itemId: item.id,
        itemName: name,
        detail: 'Expired stock is physically present and must be pulled.',
      });
    }

    // STALE AUDIT — last verified outside the current month; the on-hand figure
    // may not reflect reality (skipped post-event scan → drift).
    const lastAudit = toDate(item.lastAuditDate);
    if (!isAuditedThisMonth(lastAudit, now)) {
      out.push({
        severity: 'medium',
        kind: 'stale_audit',
        itemId: item.id,
        itemName: name,
        detail: lastAudit
          ? `Not verified this month — last audited ${lastAudit.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
          : 'Never audited — on-hand count is unverified.',
      });
    }
  }

  for (const pack of statpacks || []) {
    const name = pack.name || 'Unnamed pack';
    const lastAuditAt = toDate(pack.lastAuditAt);
    if (!isStatpackAuditCurrent(lastAuditAt, now)) {
      out.push({
        severity: 'medium',
        kind: 'overdue_statpack',
        itemId: pack.id,
        itemName: name,
        detail: lastAuditAt
          ? `Audit overdue — last audited ${lastAuditAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
          : 'Never audited — readiness is unverified.',
      });
    }
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return out;
}
