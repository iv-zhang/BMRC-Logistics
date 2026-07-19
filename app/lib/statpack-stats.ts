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

// ── Time-range filtering ──────────────────────────────────────────────────────

/** An inclusive date range; `null` on either side means unbounded. */
export interface DateRange {
  start: Date | null;
  end: Date | null;
}

export function isWithinRange(d: Date | null, range: DateRange): boolean {
  if (!d) return false;
  if (range.start && d < range.start) return false;
  if (range.end && d > range.end) return false;
  return true;
}

export function filterLogsByRange(logs: StatpackLogWithId[], range: DateRange): StatpackLogWithId[] {
  if (!range.start && !range.end) return logs;
  return logs.filter((l) => isWithinRange(l.timestamp, range));
}

// ── Item usage drill-down ─────────────────────────────────────────────────────

export interface ItemUsageEvent {
  /** The check-in timestamp. */
  date: Date | null;
  packName: string;
  /** Shortfall (requiredQuantity - countedQuantity) on this entry. */
  usedQty: number;
  /** Who checked the pack back in. */
  checkinUser: string;
  /** Who checked the pack out (paired checkout log's userName), or null if unpaired. */
  checkoutUser: string | null;
}

export interface ItemUsageDetail {
  itemName: string;
  totalUsed: number;
  eventCount: number;
  /** Rolled up by whoever used the pack in the field (checkout user, falling back to check-in user); sorted desc by used. */
  byMember: { name: string; used: number; times: number }[];
  /** Rolled up by pack; sorted desc by used. */
  byPack: { name: string; used: number; times: number }[];
  /** Newest first. */
  events: ItemUsageEvent[];
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

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 60;

export interface TimeBucket {
  label: string;
  bucketStart: Date;
  count: number;
}

/**
 * Generic date bucketer shared by `computeUsageOverTime` (statpack checkouts)
 * and the restock trend chart on `/stats`. Granularity is chosen from the
 * span between `range.start`/`range.end` (falling back to the earliest of
 * `spanDates` → `now`, or the last 12 weeks if `spanDates` is empty and no
 * range is given): <=14 days → daily, <=120 days → weekly (Monday start),
 * otherwise monthly. Bucket count is capped at `MAX_BUCKETS` by widening
 * granularity if needed.
 *
 * `spanDates` only influences which date span the buckets cover (pass every
 * candidate timestamp, regardless of whether it should be counted).
 * `countDates` is what actually increments bucket counts — pass a filtered
 * subset (e.g. only `checkout` logs) when the two differ; defaults to
 * `spanDates` when omitted. `null` dates are ignored in both.
 */
export function bucketDatesByRange(
  spanDates: (Date | null)[],
  range?: DateRange,
  now: Date = new Date(),
  countDates: (Date | null)[] = spanDates,
): TimeBucket[] {
  const earliestOf = (): Date | null =>
    spanDates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);

  let start: Date;
  let end: Date;

  if (range?.start || range?.end) {
    end = range.end ?? now;
    start = range.start ?? earliestOf() ?? new Date(end.getTime() - 12 * 7 * MS_PER_DAY);
  } else {
    end = now;
    start = earliestOf() ?? new Date(end.getTime() - 12 * 7 * MS_PER_DAY);
  }

  const spanMs = Math.max(0, end.getTime() - start.getTime());
  const spanDays = spanMs / MS_PER_DAY;

  type Granularity = 'day' | 'week' | 'month';
  let granularity: Granularity = spanDays <= 14 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  const bucketStartFor = (d: Date, g: Granularity): Date => {
    if (g === 'day') return startOfDay(d);
    if (g === 'week') return startOfWeek(d);
    return startOfMonth(d);
  };

  const nextBucketStart = (d: Date, g: Granularity): Date => {
    const nd = new Date(d);
    if (g === 'day') nd.setDate(nd.getDate() + 1);
    else if (g === 'week') nd.setDate(nd.getDate() + 7);
    else nd.setMonth(nd.getMonth() + 1);
    return nd;
  };

  const countBuckets = (g: Granularity): number => {
    let count = 0;
    let cursor = bucketStartFor(start, g);
    const last = bucketStartFor(end, g);
    while (cursor.getTime() <= last.getTime() && count < MAX_BUCKETS + 1) {
      count++;
      cursor = nextBucketStart(cursor, g);
    }
    return count;
  };

  // Widen granularity if it would produce too many buckets.
  const order: Granularity[] = ['day', 'week', 'month'];
  let idx = order.indexOf(granularity);
  while (countBuckets(granularity) > MAX_BUCKETS && idx < order.length - 1) {
    idx++;
    granularity = order[idx];
  }

  const labelFor = (d: Date, g: Granularity): string => {
    if (g === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const buckets: TimeBucket[] = [];
  let cursor = bucketStartFor(start, granularity);
  const last = bucketStartFor(end, granularity);
  while (cursor.getTime() <= last.getTime()) {
    buckets.push({ bucketStart: new Date(cursor), label: labelFor(cursor, granularity), count: 0 });
    cursor = nextBucketStart(cursor, granularity);
  }
  if (buckets.length === 0) {
    buckets.push({ bucketStart: new Date(cursor), label: labelFor(cursor, granularity), count: 0 });
  }

  const byTime = new Map(buckets.map((b) => [b.bucketStart.getTime(), b]));
  for (const d of countDates) {
    if (!d) continue;
    const bucketStart = bucketStartFor(d, granularity);
    const bucket = byTime.get(bucketStart.getTime());
    if (bucket) bucket.count++;
  }
  return buckets;
}

/**
 * Checkouts bucketed over time (see `bucketDatesByRange` for the granularity
 * rules). Only `action === 'checkout'` logs are counted; the span is derived
 * from every log's timestamp regardless of action.
 */
export function computeUsageOverTime(
  logs: StatpackLogWithId[],
  range?: DateRange,
  now: Date = new Date(),
): UsageBucket[] {
  const spanDates = logs.map((l) => l.timestamp);
  const countDates = logs
    .filter((l) => normalizeAction(l.action) === 'checkout')
    .map((l) => l.timestamp);
  const buckets = bucketDatesByRange(spanDates, range, now, countDates);
  return buckets.map((b) => ({ label: b.label, weekStart: b.bucketStart, checkouts: b.count }));
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

/**
 * Drill-down for a single item name: every check-in event where the item ran
 * short, rolled up by who used it (checkout user, falling back to check-in
 * user when the checkout couldn't be paired) and by pack.
 */
export function computeItemUsageDetail(
  logs: StatpackLogWithId[],
  packs: StatpackSummaryDoc[] = [],
  itemName: string,
): ItemUsageDetail {
  const nameById = new Map(packs.map((p) => [p.id, p.name]));

  const byPack = new Map<string, StatpackLogWithId[]>();
  for (const log of logs) {
    const key = log.statpackId || 'unknown';
    const arr = byPack.get(key) ?? [];
    arr.push(log);
    byPack.set(key, arr);
  }

  // Map check-in log id -> its paired checkout log, per pack.
  const checkoutForCheckin = new Map<string, StatpackLogWithId>();
  for (const packLogs of byPack.values()) {
    const paired = pairStatpackLogs(packLogs);
    for (const item of paired) {
      if (item.kind === 'pair' && item.checkin && item.checkout) {
        checkoutForCheckin.set(item.checkin.id, item.checkout);
      }
    }
  }

  const events: ItemUsageEvent[] = [];
  const memberTotals = new Map<string, { used: number; times: number }>();
  const packTotals = new Map<string, { used: number; times: number }>();

  for (const log of logs) {
    if (normalizeAction(log.action) !== 'checkin') continue;
    const entries = Array.isArray(log.checkEntries) ? log.checkEntries : [];
    for (const e of entries) {
      const name = e?.itemName || e?.itemId || 'Unknown item';
      if (name !== itemName) continue;
      const required = typeof e?.requiredQuantity === 'number' ? e.requiredQuantity : 0;
      const counted = typeof e?.countedQuantity === 'number' ? e.countedQuantity : 0;
      const used = Math.max(0, required - counted);
      if (used <= 0) continue;

      const packName = log.statpackName || nameById.get(log.statpackId || '') || log.statpackId || 'Unknown pack';
      const checkinUser = log.userName || 'Unknown';
      const pairedCheckout = checkoutForCheckin.get(log.id);
      const checkoutUser = pairedCheckout?.userName || null;

      events.push({
        date: log.timestamp,
        packName,
        usedQty: used,
        checkinUser,
        checkoutUser,
      });

      const memberKey = checkoutUser ?? checkinUser;
      const memberEntry = memberTotals.get(memberKey) ?? { used: 0, times: 0 };
      memberEntry.used += used;
      memberEntry.times += 1;
      memberTotals.set(memberKey, memberEntry);

      const packEntry = packTotals.get(packName) ?? { used: 0, times: 0 };
      packEntry.used += used;
      packEntry.times += 1;
      packTotals.set(packName, packEntry);
    }
  }

  events.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

  const byMember = Array.from(memberTotals.entries())
    .map(([name, v]) => ({ name, used: v.used, times: v.times }))
    .sort((a, b) => b.used - a.used);

  const byPackList = Array.from(packTotals.entries())
    .map(([name, v]) => ({ name, used: v.used, times: v.times }))
    .sort((a, b) => b.used - a.used);

  const totalUsed = events.reduce((sum, e) => sum + e.usedQty, 0);

  return {
    itemName,
    totalUsed,
    eventCount: events.length,
    byMember,
    byPack: byPackList,
    events,
  };
}
