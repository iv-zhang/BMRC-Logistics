/**
 * Local-time round trip for `<input type="date">` values.
 *
 * This is a shared module, not a per-file helper, because this exact pair of
 * functions has now been hand-duplicated across the events UI three times
 * (D29, D30, and this fix — see `docs/medops-signup-plan.md`): a helper isn't
 * exported, an agent scoped to one file needs it anyway, so it gets copied —
 * and the copy silently drifts from the original later. Import from here
 * instead of writing a fourth copy.
 *
 * The hazard both functions guard against: `new Date("YYYY-MM-DD")` parses
 * the string as **UTC midnight**, and `Date#toISOString()` formats in UTC —
 * either one can shift the calendar day by one once converted to local time.
 * Every function below works in local time end to end specifically to avoid
 * that.
 */

/** Parse a "YYYY-MM-DD" `<input type="date">` value as a local calendar day
 *  (never `new Date(str)`, which parses as UTC and can shift the day). */
export function parseDateInputValue(v: string): Date | null {
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Format a Date as yyyy-MM-dd in local time (toISOString would shift the day across timezones). */
export function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
