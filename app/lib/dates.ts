/**
 * Local-time parsing/formatting for `<input type="date">` / `<input type="month">`
 * values.
 *
 * `new Date('2026-06-30')` parses a date-only ISO string as UTC midnight, which in
 * any US timezone is the PREVIOUS local day (and `'2026-06-01'` becomes May 31).
 * Likewise `date.toISOString().slice(0, 10)` formats in UTC, so a late-evening
 * local date shows as tomorrow. Every date/month input must go through these
 * helpers instead.
 *
 * Pure (no Firebase) so libs, pages and scripts can share it.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * `'YYYY-MM-DD'` → local Date. `endOfDay` gives 23:59:59.999 instead of 00:00
 * (use it for "valid through" dates such as cert expirations).
 * Returns `null` for empty/malformed input.
 */
export function parseDateInput(value: string | null | undefined, endOfDay = false): Date | null {
  if (!value) return null;
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = endOfDay ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d);
  // Reject rollovers like 2026-02-31.
  return date.getMonth() === mo - 1 ? date : null;
}

/**
 * `'YYYY-MM'` → local Date on the FIRST of that month at 00:00 (`'start'`, the
 * existing intake semantics) or the LAST day at 23:59:59.999 (`'end'`, the
 * statpack check-off semantics). Returns `null` for empty/malformed input.
 */
export function parseMonthInput(value: string | null | undefined, at: 'start' | 'end' = 'start'): Date | null {
  if (!value) return null;
  const m = MONTH_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12) return null;
  return at === 'end' ? new Date(y, mo, 0, 23, 59, 59, 999) : new Date(y, mo - 1, 1);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → `'YYYY-MM-DD'` in LOCAL time (for `<input type="date">` values). */
export function toDateInputValue(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date → `'YYYY-MM'` in LOCAL time (for `<input type="month">` values). */
export function toMonthInputValue(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}
