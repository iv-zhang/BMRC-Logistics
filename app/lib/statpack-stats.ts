/**
 * Statpack usage-analytics aggregation.
 *
 * Pure, read-only helpers that turn the raw `statpack_logs` collection into
 * the KPIs shown on `/statpacks/stats`. Checkout/checkin pairing (by
 * `pairId`, with a same-pack chronological fallback for legacy rows without
 * one) is delegated to `pairStatpackLogs`/`calculateEventDuration` in
 * `app/lib/logs.ts` — the same logic already used by the pack detail history
 * views — rather than re-implemented here, so a pack's average turnaround
 * always agrees with what its own history tab shows.
 *
 * Data is tolerated as messy: missing fields, non-Date timestamps, and
 * missing `checkEntries`/`summary` are all handled defensively.
 */

import type { StatpackLog } from '@/app/types';
import {
  normalizeTimestamp,
  pairStatpackLogs,
  calculateEventDuration,
  type StatpackLogWithId,
} from '@/app/lib/logs';

export type { StatpackLogWithId };

export interface StatpackSummaryDoc {
  id: string;
  name: string;
}

export interface StatpackStatsSummary {
  totalCheckouts: number;
  totalCheckins: number;
  /** Mean checkout→checkin duration across all paired events, in ms. */
  avgTurnaroundMs: number | null;
  /** Sum of max(0, requiredQuantity - countedQuantity) across all checkin entries. */
  totalItemsUsed: number;
  /** Count of check entries marked restockStatus === 'restocked'. */
  restockEvents: number;
  /** Count of check entries with an `issue`, or summary.reportedCount fallback. */
  reportedIssues: number;
  /** Count of check entries with issue.type === 'expired', or summary.expiredCount fallback. */
  expiredFindings: number;
}

export interface PackStats {
  statpackId: string;
  statpackName: string;
  checkouts: number;
  checkins: number;
  avgTurnaroundMs: number | null;
  itemsUsed: number;
  restocks: number;
  issues: number;
  lastActivity: Date | null;
}

export interface MostUsedItem {
  itemName: string;
  usedCount: number;
}

export interface UsageBucket {
  label: string;
  weekStart: Date;
  checkouts: number;
}

export interface StatpackStatsResult {
  summary: StatpackStatsSummary;
  perPack: PackStats[];
  mostUsedItems: MostUsedItem[];
  usageOverTime: UsageBucket[];
  hasData: boolean;
}

// ── Firestore doc → typed row ────────────────────────────────────────────────

/** Build a `StatpackLogWithId` from a raw Firestore doc, resolving its timestamp. */
export function toStatpackLogWithId(id: string, data: Record<string, unknown>): StatpackLogWithId {
  return {
    ...(data as unknown as StatpackLog),
    id,
    timestamp: normalizeTimestamp(data.timestamp, (data as { clientTimestamp?: unknown }).clientTimestamp),
  } as StatpackLogWithId;
}

/** Build a `StatpackSummaryDoc` (id + display name) from a raw `statpacks` doc. */
export function toStatpackSummary(id: string, data: Record<string, unknown>): StatpackSummaryDoc {
  const name = typeof data?.name === 'string' && data.name.trim() ? data.name : id;
  return { id, name };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeAction(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  return String(raw).toLowerCase().trim();
}

function itemsUsedFromEntries(entries?: StatpackLog['checkEntries']): number {
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const e of entries) {
    const required = typeof e?.requiredQuantity === 'number' ? e.requiredQuantity : 0;
    const counted = typeof e?.countedQuantity === 'number' ? e.countedQuantity : 0;
    total += Math.max(0, required - counted);
  }
  return total;
}

function findingsFromLog(log: StatpackLogWithId): { restocked: number; issues: number; expired: number } {
  const entries = Array.isArray(log.checkEntries) ? log.checkEntries : [];
  if (entries.length > 0) {
    let restocked = 0, issues = 0, expired = 0;
    for (const e of entries) {
      if (e?.restockStatus === 'restocked') restocked++;
      if (e?.issue) {
        issues++;
        if (e.issue.type === 'expired') expired++;
      }
    }
    return { restocked, issues, expired };
  }
  return {
    restocked: 0,
    issues: log.summary?.reportedCount ?? 0,
    expired: log.summary?.expiredCount ?? 0,
  };
}

function startOfWeek(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay(); // 0 = Sun .. 6 = Sat
  const diff = (day === 0 ? -6 : 1) - day; // move back to Monday
  date.setDate(date.getDate() + diff);
  return date;
}

// ── Aggregations ──────────────────────────────────────────────────────────────

/** Top N items by total shortfall (requiredQuantity - countedQuantity) across all checkins. */
export function computeMostUsedItems(logs: StatpackLogWithId[], top = 10): MostUsedItem[] {
  const totals = new Map<string, number>();
  for (const log of logs) {
    if (normalizeAction(log.action) !== 'checkin') continue;
    const entries = Array.isArray(log.checkEntries) ? log.checkEntries : [];
    for (const e of entries) {
      const required = typeof e?.requiredQuantity === 'number' ? e.requiredQuantity : 0;
      const counted = typeof e?.countedQuantity === 'number' ? e.countedQuantity : 0;
      const used = Math.max(0, required - counted);
      if (used <= 0) continue;
      const name = e?.itemName || e?.itemId || 'Unknown item';
      totals.set(name, (totals.get(name) ?? 0) + used);
    }
  }
  return Array.from(totals.entries())
    .map(([itemName, usedCount]) => ({ itemName, usedCount }))
    .sort((a, b) => b.usedCount - a.usedCount)
    .slice(0, top);
}

/** Checkouts bucketed by week (Monday start), last `weeks` weeks including the current one. */
export function computeUsageOverTime(logs: StatpackLogWithId[], weeks = 12, now = new Date()): UsageBucket[] {
  const currentWeekStart = startOfWeek(now);
  const buckets: UsageBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = new Date(currentWeekStart);
    ws.setDate(ws.getDate() - i * 7);
    buckets.push({
      weekStart: ws,
      label: ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      checkouts: 0,
    });
  }
  const byTime = new Map(buckets.map((b) => [b.weekStart.getTime(), b]));
  for (const log of logs) {
    if (normalizeAction(log.action) !== 'checkout' || !log.timestamp) continue;
    const bucket = byTime.get(startOfWeek(log.timestamp).getTime());
    if (bucket) bucket.checkouts++;
  }
  return buckets;
}

/**
 * Full statpack usage-analytics rollup: top-line KPIs, per-pack breakdown,
 * most-used items, and checkouts-per-week. `packs` is used only to resolve a
 * display name when a log's own `statpackName` is missing.
 */
export function computeStatpackStats(
  logs: StatpackLogWithId[],
  packs: StatpackSummaryDoc[] = [],
): StatpackStatsResult {
  const nameById = new Map(packs.map((p) => [p.id, p.name]));

  const byPack = new Map<string, StatpackLogWithId[]>();
  for (const log of logs) {
    const key = log.statpackId || 'unknown';
    const arr = byPack.get(key) ?? [];
    arr.push(log);
    byPack.set(key, arr);
  }

  const perPack: PackStats[] = [];
  const allDurations: number[] = [];
  let totalCheckouts = 0, totalCheckins = 0, totalItemsUsed = 0;
  let restockEvents = 0, reportedIssues = 0, expiredFindings = 0;

  for (const [statpackId, packLogs] of byPack) {
    const checkouts = packLogs.filter((l) => normalizeAction(l.action) === 'checkout').length;
    const checkins = packLogs.filter((l) => normalizeAction(l.action) === 'checkin').length;
    totalCheckouts += checkouts;
    totalCheckins += checkins;

    // Reuse the same pairing logic the per-pack history views use.
    const paired = pairStatpackLogs(packLogs);
    const durations: number[] = [];
    for (const item of paired) {
      if (item.kind !== 'pair') continue;
      const d = calculateEventDuration(item.checkout, item.checkin);
      if (d !== null) {
        durations.push(d);
        allDurations.push(d);
      }
    }
    const avgTurnaroundMs = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;

    let itemsUsed = 0, restocks = 0, issues = 0, expired = 0;
    let lastActivity: Date | null = null;
    for (const l of packLogs) {
      if (l.timestamp && (!lastActivity || l.timestamp > lastActivity)) lastActivity = l.timestamp;
      const f = findingsFromLog(l);
      restocks += f.restocked;
      issues += f.issues;
      expired += f.expired;
      if (normalizeAction(l.action) === 'checkin') itemsUsed += itemsUsedFromEntries(l.checkEntries);
    }
    totalItemsUsed += itemsUsed;
    restockEvents += restocks;
    reportedIssues += issues;
    expiredFindings += expired;

    const displayName =
      packLogs.find((l) => l.statpackName)?.statpackName || nameById.get(statpackId) || statpackId;

    perPack.push({
      statpackId,
      statpackName: displayName,
      checkouts,
      checkins,
      avgTurnaroundMs,
      itemsUsed,
      restocks,
      issues,
      lastActivity,
    });
  }

  perPack.sort((a, b) => b.itemsUsed - a.itemsUsed);

  const summary: StatpackStatsSummary = {
    totalCheckouts,
    totalCheckins,
    avgTurnaroundMs: allDurations.length
      ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length
      : null,
    totalItemsUsed,
    restockEvents,
    reportedIssues,
    expiredFindings,
  };

  return {
    summary,
    perPack,
    mostUsedItems: computeMostUsedItems(logs),
    usageOverTime: computeUsageOverTime(logs),
    hasData: logs.length > 0,
  };
}
