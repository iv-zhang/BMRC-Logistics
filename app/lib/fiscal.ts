/**
 * Fiscal-year helpers. BMRC's fiscal year runs Jul-Jun and is named for the
 * calendar year it ENDS in: "FY27" = Jul 1 2026 - Jun 30 2027.
 *
 * Pure: every function takes the start month as an optional trailing parameter
 * (1-12). When omitted it is read from the live org config
 * (`getFiscalYearStartMonthRuntime`, `org_settings.fiscalYearStartMonth`,
 * default 7), never from the frozen constant, so an admin edit is honored.
 * Dates are local time, matching the rest of the app's calendar math.
 *
 * `fiscalYearOf` returns the FY as a four-digit number (2027 for FY27) so it
 * sorts and compares like a year; `fyLabel` renders it.
 */

import { FISCAL_YEAR_START_MONTH } from '@/app/config/org-config';
import { getFiscalYearStartMonthRuntime } from '@/app/lib/org-config-store';

/** A month outside 1-12 (or a non-integer) falls back to July rather than producing garbage ranges. */
function normalizeStartMonth(m: number): number {
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : FISCAL_YEAR_START_MONTH;
}

function liveStartMonth(): number {
  return normalizeStartMonth(getFiscalYearStartMonthRuntime());
}

/** The fiscal year a date falls in, as the year it ends in (Sep 2026 -> 2027 with a July start). */
export function fiscalYearOf(date: Date, startMonth: number = liveStartMonth()): number {
  const m = normalizeStartMonth(startMonth);
  const year = date.getFullYear();
  if (m === 1) return year; // calendar-year FY
  return date.getMonth() + 1 >= m ? year + 1 : year;
}

/** "FY27" for 2027. Accepts a full year (2027) or an already-short one (27). */
export function fyLabel(fy: number): string {
  return `FY${String(Math.abs(Math.trunc(fy)) % 100).padStart(2, '0')}`;
}

export interface FiscalYearRange {
  /** First instant of the FY (local midnight on the 1st of the start month). */
  start: Date;
  /** First instant AFTER the FY: a half-open range, so `start <= d < endExclusive`. */
  endExclusive: Date;
}

/** The date range of a fiscal year given as its ending year (FY27 -> 2027). */
export function fyRange(fy: number, startMonth: number = liveStartMonth()): FiscalYearRange {
  const m = normalizeStartMonth(startMonth);
  const startYear = m === 1 ? fy : fy - 1;
  return {
    start: new Date(startYear, m - 1, 1),
    endExclusive: new Date(startYear + 1, m - 1, 1),
  };
}

/** True when `date` falls inside fiscal year `fy`. An invalid date is never in any FY. */
export function isInFY(date: Date, fy: number, startMonth: number = liveStartMonth()): boolean {
  const t = date.getTime();
  if (Number.isNaN(t)) return false;
  const { start, endExclusive } = fyRange(fy, startMonth);
  return t >= start.getTime() && t < endExclusive.getTime();
}

/** The fiscal year containing `now`. */
export function currentFiscalYear(now: Date = new Date(), startMonth: number = liveStartMonth()): number {
  return fiscalYearOf(now, startMonth);
}
