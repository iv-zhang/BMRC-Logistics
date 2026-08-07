/**
 * Restock-report analytics for the /stats dashboard's Usage tab.
 *
 * Ported 1:1 from the inline `restockStats` useMemo that used to live in
 * `app/stats/page.tsx`'s `RestockStatsView` (the old dedicated /stats
 * "Restock" tab) — same math, reshaped into the house selector signature
 * `(data, filters, tileId?) => rows`. No React, no Firestore reads. See
 * `app/lib/stats/shared.ts` for `StatsData`/`StatsFilterState`/
 * `RestockReportDoc`/`RestockActionDoc` and `app/lib/stats/consumption.ts`
 * for the sibling usage selectors (not reimplemented here).
 *
 * `RestockReportDoc`/`RestockActionDoc` carry a list of `items` rather than
 * a single itemName/category, so the closed-union `passesCrossFilters`
 * helper (one value per field) doesn't apply cleanly to them — an incoming
 * `itemName` cross-filter (emitted by a different tile, e.g. consumption's
 * "Most-Used Items") is matched by hand against each report/action's item
 * list instead, mirroring the pattern `collectResolvedRestockHours` already
 * uses in consumption.ts.
 */

import {
  toDate,
  inRange,
  bucketBy,
  mean,
  type StatsData,
  type StatsFilterState,
  type DateRange,
  type RestockReportDoc,
  type RestockActionDoc,
} from '@/app/lib/stats/shared';

// ── Shared range + cross-filter helpers ───────────────────────────────────

/**
 * Range gate matching the old page's exact semantics: an unbounded range
 * ("All time") keeps every report/action regardless of whether it even has
 * a valid `createdAt` (the old page's `!range.start && !range.end ? reports
 * : reports.filter(isWithinRange...)` ternary), while a bounded range falls
 * back to the normal `inRange` check (which excludes null dates). Using
 * plain `inRange` unconditionally would silently drop undated legacy rows
 * even in the "all time" view — a regression from what the old tab showed.
 */
function withinReportRange(createdAt: Date | null, range: DateRange): boolean {
  if (!range.start && !range.end) return true;
  return inRange(createdAt, range);
}

function itemNameFiltersFor(filters: StatsFilterState, tileId?: string) {
  return filters.crossFilters.filter((f) => f.field === 'itemName' && f.sourceTileId !== tileId);
}

function reportMatchesItemFilters(report: RestockReportDoc, itemFilters: { value: string }[]): boolean {
  if (itemFilters.length === 0) return true;
  const names = new Set((report.items || []).map((i) => i.name).filter((n): n is string => !!n));
  return itemFilters.every((f) => names.has(f.value));
}

function actionMatchesItemFilters(action: RestockActionDoc, itemFilters: { value: string }[]): boolean {
  if (itemFilters.length === 0) return true;
  const names = new Set((action.items || []).map((i) => i.name).filter((n): n is string => !!n));
  return itemFilters.every((f) => names.has(f.value));
}

function reportsInScope(data: StatsData, filters: StatsFilterState, tileId?: string): RestockReportDoc[] {
  const itemFilters = itemNameFiltersFor(filters, tileId);
  return data.restockReports.filter(
    (r) => withinReportRange(toDate(r.createdAt), filters.range) && reportMatchesItemFilters(r, itemFilters)
  );
}

function actionsInScope(data: StatsData, filters: StatsFilterState, tileId?: string): RestockActionDoc[] {
  const itemFilters = itemNameFiltersFor(filters, tileId);
  return data.restockActions.filter(
    (a) => withinReportRange(toDate(a.createdAt), filters.range) && actionMatchesItemFilters(a, itemFilters)
  );
}

/**
 * Still-open reports with their age (now − createdAt) in hours, sorted
 * longest-outstanding first. Shared by `currentlyMissing` (which slices the
 * top 10 for display) and `missingAgeSummary` (which needs the max/avg over
 * the FULL open set, not just the displayed slice).
 */
function openReportsWithAge(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { report: RestockReportDoc; ageHours: number }[] {
  const now = Date.now();
  return reportsInScope(data, filters, tileId)
    .filter((r) => !r.resolved)
    .map((r) => {
      const createdAt = toDate(r.createdAt);
      return { report: r, ageHours: createdAt ? (now - createdAt.getTime()) / (1000 * 60 * 60) : null };
    })
    .filter((x): x is { report: RestockReportDoc; ageHours: number } => x.ageHours !== null)
    .sort((a, b) => b.ageHours - a.ageHours);
}

// ── 1. Currently missing ───────────────────────────────────────────────────

export interface MissingReportRow {
  id: string;
  name: string;
  ageHours: number;
}

/** Longest-outstanding still-open reports, top 10 — "how long have items been missing". */
export function currentlyMissing(data: StatsData, filters: StatsFilterState, tileId?: string): MissingReportRow[] {
  return openReportsWithAge(data, filters, tileId)
    .slice(0, 10)
    .map((x, i) => ({
      id: x.report.id ?? `open-${i}`,
      name: x.report.restockBoxName || x.report.items?.[0]?.name || 'Unknown item',
      ageHours: x.ageHours,
    }));
}

// ── 2. Missing-age summary ─────────────────────────────────────────────────

export interface MissingAgeSummaryResult {
  maxOpenAgeHours: number | null;
  avgOpenAgeHours: number | null;
}

/** Max/avg age (hours) across ALL still-open reports, not just the top-10 slice `currentlyMissing` shows. */
export function missingAgeSummary(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): MissingAgeSummaryResult {
  const openWithAge = openReportsWithAge(data, filters, tileId);
  return {
    maxOpenAgeHours: openWithAge.length ? openWithAge[0].ageHours : null,
    avgOpenAgeHours: mean(openWithAge.map((x) => x.ageHours)),
  };
}

// ── 3. Top restock boxes ────────────────────────────────────────────────────

export interface LabelValueRow {
  label: string;
  value: number;
}

/** Restock boxes with the most reports in range, top 10 (report count, resolved + open). */
export function topRestockBoxes(data: StatsData, filters: StatsFilterState, tileId?: string): LabelValueRow[] {
  const perBox = new Map<string, { name: string; count: number }>();
  for (const r of reportsInScope(data, filters, tileId)) {
    const id = r.restockBoxId || 'unknown';
    const entry = perBox.get(id) ?? { name: r.restockBoxName || id, count: 0 };
    entry.count += 1;
    perBox.set(id, entry);
  }
  return [...perBox.values()]
    .map((v) => ({ label: v.name, value: v.count }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

// ── 4. Top reported items ───────────────────────────────────────────────────

/** Items named across restock reports the most, top 10 (times reported, not units). */
export function topReportedItems(data: StatsData, filters: StatsFilterState, tileId?: string): LabelValueRow[] {
  const perItem = new Map<string, { name: string; reported: number }>();
  for (const r of reportsInScope(data, filters, tileId)) {
    for (const it of r.items || []) {
      const key = it.itemId || it.name || 'unknown';
      const entry = perItem.get(key) ?? { name: it.name || key, reported: 0 };
      entry.reported += 1;
      perItem.set(key, entry);
    }
  }
  return [...perItem.values()]
    .map((v) => ({ label: v.name, value: v.reported }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

// ── 5. Reports over time ────────────────────────────────────────────────────

/**
 * Report volume per bucket, via `bucketBy` (per the migration brief — the
 * old page's bespoke `bucketDatesByRange` is not reused here). Bucketing
 * inherently needs a real `createdAt`, so — unlike the other selectors in
 * this file — reports with no resolvable date are simply not placed in any
 * bucket, matching what a trend line over time can meaningfully show.
 */
export function reportsOverTime(data: StatsData, filters: StatsFilterState, tileId?: string): LabelValueRow[] {
  const itemFilters = itemNameFiltersFor(filters, tileId);
  const records = data.restockReports.filter((r) => reportMatchesItemFilters(r, itemFilters));
  const buckets = bucketBy(records, (r) => toDate(r.createdAt), filters.range);
  return buckets.map((b) => ({ label: b.label, value: b.items.length }));
}

// ── 6. Restock KPIs ─────────────────────────────────────────────────────────

export interface RestockKpisResult {
  totalReports: number;
  openReports: number;
  totalActions: number;
  /** Mean createdAt→resolvedAt turnaround (hours) across resolved reports in range; null if none resolved. */
  avgResolveHours: number | null;
}

export function restockKpis(data: StatsData, filters: StatsFilterState, tileId?: string): RestockKpisResult {
  const reports = reportsInScope(data, filters, tileId);
  const totalReports = reports.length;
  const openReports = reports.filter((r) => !r.resolved).length;
  const totalActions = actionsInScope(data, filters, tileId).length;

  const resolveHours: number[] = [];
  for (const r of reports) {
    const createdAt = toDate(r.createdAt);
    const resolvedAt = toDate(r.resolvedAt);
    if (createdAt && resolvedAt) resolveHours.push((resolvedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60));
  }

  return { totalReports, openReports, totalActions, avgResolveHours: mean(resolveHours) };
}
