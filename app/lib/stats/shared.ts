/**
 * Shared contracts for the /stats dashboard.
 *
 * This file is the WAVE-0 GATE: every stats lib module and every tile component
 * keys off the types here. Treat it as an interface, not an implementation —
 * add helpers freely, but changing an exported type signature breaks other
 * agents' files in parallel, so coordinate before editing one.
 *
 * Design note (see decisions.md D-27): the /stats dashboard is deliberately NOT
 * a generic query engine. Tiles are hand-written components with fixed queries,
 * registered in `tile-registry.ts`. Users compose dashboards from a catalog of
 * those tiles; they cannot invent new ones. That keeps the analysis honest
 * (every number has an author) while still giving the arrangeable, cross-
 * filtering feel of a Tableau dashboard.
 */

import { Timestamp } from 'firebase/firestore';
import type {
  Purchase,
  BuyListItem,
  InventoryItem,
  MedicationLog,
  Event as BmrcEvent,
  ShiftRequest,
  User,
  VehicleLog,
} from '@/app/types';
import type { StatpackLogWithId, StatpackSummaryDoc, DateRange } from '@/app/lib/statpack-stats';

export type { DateRange };

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Canonical Firestore-value → Date coercion for stats code.
 *
 * Handles the three shapes that actually appear in this database: a real
 * `Timestamp`, an already-converted `Date`, and the legacy plain
 * `{seconds, nanoseconds}` map that older docs carry (see the `toJsDate`
 * gotcha in CLAUDE.md). Returns null for `FieldValue` sentinels and anything
 * unrecognized — callers must handle null rather than defaulting to `now`,
 * which would silently invent activity.
 */
export function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v === 'object') {
    const maybe = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof maybe.toDate === 'function') {
      try {
        const d = maybe.toDate();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
      } catch {
        return null;
      }
    }
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000);
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** True when `d` falls inside `range`. A null bound means "unbounded". */
export function inRange(d: Date | null, range: DateRange): boolean {
  if (!d) return false;
  if (range.start && d < range.start) return false;
  if (range.end && d > range.end) return false;
  return true;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two dates (may be fractional). */
export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

/** Bucket granularity chosen to keep a chart readable across the given span. */
export type Granularity = 'day' | 'week' | 'month';

export function pickGranularity(range: DateRange, fallbackDays = 90): Granularity {
  const start = range.start;
  const end = range.end ?? new Date();
  const span = start ? daysBetween(start, end) : fallbackDays * 4;
  if (span <= 31) return 'day';
  if (span <= 180) return 'week';
  return 'month';
}

/** Start-of-bucket for `d` at the given granularity (local time). */
export function bucketStart(d: Date, g: Granularity): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === 'day') return x;
  if (g === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  x.setDate(x.getDate() - x.getDay()); // week starts Sunday
  return x;
}

export function bucketLabel(d: Date, g: Granularity): string {
  if (g === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Group timestamped records into contiguous buckets across the whole range,
 * INCLUDING empty ones. Emitting empty buckets matters: a gap in activity is a
 * finding, and dropping it makes a line chart lie about continuity.
 */
export function bucketBy<T>(
  records: T[],
  getDate: (t: T) => Date | null,
  range: DateRange,
  g: Granularity = pickGranularity(range)
): { start: Date; label: string; items: T[] }[] {
  const dated = records
    .map((r) => ({ r, d: getDate(r) }))
    .filter((x): x is { r: T; d: Date } => x.d !== null && inRange(x.d, range));

  const first = range.start ?? dated.reduce<Date | null>((m, x) => (!m || x.d < m ? x.d : m), null);
  const last = range.end ?? new Date();
  if (!first) return [];

  const buckets = new Map<number, { start: Date; label: string; items: T[] }>();
  for (let cur = bucketStart(first, g); cur <= last; ) {
    buckets.set(cur.getTime(), { start: new Date(cur), label: bucketLabel(cur, g), items: [] });
    const next = new Date(cur);
    if (g === 'day') next.setDate(next.getDate() + 1);
    else if (g === 'week') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
    cur = next;
  }
  for (const { r, d } of dated) {
    const key = bucketStart(d, g).getTime();
    buckets.get(key)?.items.push(r);
  }
  return [...buckets.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ── Aggregation helpers ──────────────────────────────────────────────────────

export function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

export function mean(ns: number[]): number | null {
  return ns.length ? sum(ns) / ns.length : null;
}

export function median(ns: number[]): number | null {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(ns: number[], p: number): number | null {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Group rows by a string key, preserving insertion order of first sight. */
export function groupBy<T>(rows: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Top-N by value with the remainder rolled into a single "Other" row.
 * Rolling up rather than truncating keeps totals honest — a chart whose bars
 * don't sum to the KPI above it is a bug report waiting to happen.
 */
export function topNWithOther<T extends { label: string; value: number }>(
  rows: T[],
  n: number,
  otherLabel = 'Other'
): { label: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n);
  const rest = sum(sorted.slice(n).map((r) => r.value));
  return rest > 0 ? [...head, { label: otherLabel, value: rest }] : head;
}

/**
 * Histogram bins over `values`. Returns fixed-width bins covering the observed
 * range; empty bins are kept so the distribution's shape (and its tail) reads
 * correctly.
 */
export function histogram(values: number[], binCount = 12): { label: string; from: number; to: number; value: number }[] {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ label: String(min), from: min, to: min, value: values.length }];
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    value: 0,
  }));
  for (const v of values) {
    const i = Math.min(binCount - 1, Math.floor((v - min) / width));
    bins[i].value++;
  }
  return bins.map((b) => ({ ...b, label: `${Math.round(b.from)}–${Math.round(b.to)}` }));
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatCurrency(n: number | null | undefined, currency = 'USD'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/** Compact human duration for an hour count: "3.4h", "2d 5h", "1d". */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours - days * 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || Number.isNaN(days)) return '—';
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

// ── Cross-filtering ──────────────────────────────────────────────────────────

/**
 * Dimensions a tile may cross-filter on. Kept as a closed union so a tile can
 * never emit a filter no other tile understands — a click that silently does
 * nothing is worse than a click that isn't offered.
 */
export type CrossFilterField =
  | 'vendor'
  | 'category'
  | 'itemName'
  | 'packName'
  | 'memberName'
  | 'eventName'
  | 'eventType'
  | 'venue'
  | 'role';

export interface CrossFilter {
  field: CrossFilterField;
  /** Raw value used for matching (exact, case-sensitive). */
  value: string;
  /** Human label for the filter chip. */
  label: string;
  /** Tile that emitted it — lets a tile skip filtering itself (Tableau's default). */
  sourceTileId: string;
}

export interface StatsFilterState {
  range: DateRange;
  rangeLabel: string;
  crossFilters: CrossFilter[];
}

/**
 * Test a record against the active cross-filters.
 *
 * `own` is the calling tile's id: a tile does NOT apply a filter it emitted
 * itself, matching Tableau's "use as filter" behavior, where the source sheet
 * highlights the selection rather than collapsing to it.
 */
export function passesCrossFilters(
  fields: Partial<Record<CrossFilterField, string | undefined>>,
  filters: CrossFilter[],
  own?: string
): boolean {
  for (const f of filters) {
    if (own && f.sourceTileId === own) continue;
    const v = fields[f.field];
    if (v === undefined) continue; // record doesn't carry this dimension → not excluded
    if (v !== f.value) return false;
  }
  return true;
}

// ── Days of cover (shared by consumption + procurement tiles) ────────────────

export interface DaysOfCoverRow {
  itemId: string;
  itemName: string;
  category?: string;
  /** Back-reserve units available (NOT the front shelf — see the two-pool model). */
  reserveUnits: number;
  /** Units consumed per day, averaged over the observed window. */
  burnPerDay: number;
  /** reserveUnits / burnPerDay, or null when burn is zero (infinite cover). */
  daysOfCover: number | null;
}

/**
 * Sort key for a days-of-cover table: soonest-to-run-out first, with
 * zero-burn items pushed to the end rather than treated as "0 days".
 */
export function compareDaysOfCover(a: DaysOfCoverRow, b: DaysOfCoverRow): number {
  if (a.daysOfCover === null && b.daysOfCover === null) return a.itemName.localeCompare(b.itemName);
  if (a.daysOfCover === null) return 1;
  if (b.daysOfCover === null) return -1;
  return a.daysOfCover - b.daysOfCover;
}

// ── The dataset bundle every tile receives ───────────────────────────────────

export interface RestockReportDoc {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { itemId?: string; name?: string; observedQuantity?: number; requiredQuantity?: number }[];
  createdAt?: unknown;
  resolved?: boolean;
  resolvedAt?: unknown;
}

export interface RestockActionDoc {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { name?: string; quantity?: number }[];
  createdAt?: unknown;
}

export interface AuditEventDoc {
  id?: string;
  itemId?: string;
  itemName?: string;
  action?: string;
  quantity?: number;
  actorName?: string;
  createdAt?: unknown;
  [k: string]: unknown;
}

/**
 * Everything the dashboard loads, in one bundle. Loaded once per page visit by
 * `useStatsData` (one-shot `getDocs`, not `onSnapshot` — full-collection live
 * listeners for analytics would be wasteful; the page has an explicit Refresh).
 */
export interface StatsData {
  purchases: Purchase[];
  buyList: BuyListItem[];
  inventory: InventoryItem[];
  statpackLogs: StatpackLogWithId[];
  statpacks: StatpackSummaryDoc[];
  restockReports: RestockReportDoc[];
  restockActions: RestockActionDoc[];
  auditEvents: AuditEventDoc[];
  medicationLogs: MedicationLog[];
  events: BmrcEvent[];
  shiftRequests: ShiftRequest[];
  users: User[];
  vehicleLogs: VehicleLog[];
}

export const EMPTY_STATS_DATA: StatsData = {
  purchases: [],
  buyList: [],
  inventory: [],
  statpackLogs: [],
  statpacks: [],
  restockReports: [],
  restockActions: [],
  auditEvents: [],
  medicationLogs: [],
  events: [],
  shiftRequests: [],
  users: [],
  vehicleLogs: [],
};
