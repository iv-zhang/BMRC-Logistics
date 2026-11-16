import { coerceDate } from '@/app/lib/timestamps';

/** The subset of an `inventory_logs` row the velocity math reads. */
export interface VelocityLogRow {
  action?: string;
  timestamp?: unknown;
  createdAt?: unknown;
  quantity?: number;
  quantityChange?: number;
  details?: { countedTotalUnits?: number | null } | null;
}

export interface CountVelocity {
  /** Back-reserve units used per week, or null when it cannot be known. */
  unitsPerWeek: number | null;
  /** Time of the earliest count that contributed. */
  since: Date | null;
  /** Number of counts found in the rows. */
  samples: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reserve-pool usage rate from audit counts. Audit counts measure the back
 * reserve, so usage between two consecutive counts is
 *   previousCount + intake received in between - currentCount.
 * `refill_shelf` transfers (reserve -> shelf) are already reflected in the
 * counts and are part of that usage, so they are deliberately not added back.
 * Intervals where the count rose with no matching intake (an unlogged receipt
 * or correction) are skipped, along with their elapsed time. Returns a null
 * rate rather than 0 when there is not enough data.
 */
export function computeCountVelocity(rows: VelocityLogRow[]): CountVelocity {
  const at = (r: VelocityLogRow) => coerceDate(r.timestamp) ?? coerceDate(r.createdAt);
  const counts: { t: number; units: number }[] = [];
  const intakes: { t: number; units: number }[] = [];
  for (const r of rows) {
    const d = at(r);
    if (!d) continue;
    if (r.action === 'audit_box_count') {
      const units = r.details?.countedTotalUnits;
      if (typeof units === 'number' && Number.isFinite(units)) counts.push({ t: d.getTime(), units });
    } else if (r.action === 'intake' && typeof r.quantity === 'number' && r.quantity > 0) {
      intakes.push({ t: d.getTime(), units: r.quantity });
    }
  }
  counts.sort((a, b) => a.t - b.t);
  const samples = counts.length;
  let used = 0, elapsed = 0;
  let since: Date | null = null;
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1], cur = counts[i];
    const dt = cur.t - prev.t;
    if (dt <= 0) continue;
    const received = intakes.filter(x => x.t > prev.t && x.t <= cur.t).reduce((s, x) => s + x.units, 0);
    const usage = prev.units + received - cur.units;
    if (usage < 0) continue;
    if (since === null) since = new Date(prev.t);
    used += usage;
    elapsed += dt;
  }
  if (elapsed <= 0) return { unitsPerWeek: null, since: null, samples };
  return { unitsPerWeek: used / (elapsed / WEEK_MS), since, samples };
}
