/**
 * Tenure math shared by tier-criteria evaluation (`app/lib/events.ts`
 * `meetsTierCriteria`) and roster display.
 *
 * [Phase 2 / waitlist plan §3.7, P7] `User.joinedOn` is DERIVED from a
 * configured `terms` entry (§4.1), never parsed from freeform text —
 * `deriveJoinedOn` is the one place that mapping lives, so the roster picker
 * (which writes `joinedOn`) and criteria evaluation (which reads it) can
 * never disagree about what a given `joinedTerm` label means. Both
 * `tenureDays` and `completedTermsSince` FAIL CLOSED (return `-1`) when
 * `joinedOn` is absent, matching the plan's explicit requirement that a
 * missing tenure anchor must never be treated as zero or infinite tenure.
 *
 * Deliberately does NOT import from `app/lib/events.ts` (which imports this
 * module's sibling concerns via `certifications.ts`/org-config) — keeping
 * this a leaf module avoids a circular import; `toLocalDate` below is a
 * small local date coercion rather than a re-export of `events.ts`'s
 * private `toJsDate`.
 */

import type { Timestamp } from 'firebase/firestore';
import type { TermDef } from '@/app/config/org-config';

/** Coerce a Firestore Timestamp, Date, or legacy `{seconds,nanoseconds}` map to a Date. */
function toLocalDate(value: Timestamp | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000);
  return null;
}

/**
 * The configured term whose `id` OR `label` matches `joinedTerm`
 * (case-insensitive, trimmed), or `null` when nothing matches (an unmatched
 * freeform string, or no term configured).
 */
export function findTerm(joinedTerm: string | null | undefined, terms: TermDef[]): TermDef | null {
  const needle = joinedTerm?.trim().toLowerCase();
  if (!needle) return null;
  return terms.find((t) => t.id.toLowerCase() === needle || t.label.toLowerCase() === needle) ?? null;
}

/**
 * Local-midnight `Date` of the matched term's `startDate` ('YYYY-MM-DD'), or
 * `null` when `joinedTerm` matches no configured term. Parses the date
 * components manually (`new Date(y, m-1, d)`) rather than `new Date(str)` —
 * the latter parses 'YYYY-MM-DD' as UTC midnight, which shifts the calendar
 * day in any timezone west of UTC.
 */
export function deriveJoinedOn(joinedTerm: string | null | undefined, terms: TermDef[]): Date | null {
  const term = findTerm(joinedTerm, terms);
  if (!term) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term.startDate);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

/**
 * Whole days elapsed since `joinedOn`, as of `now`. Returns `-1` when
 * `joinedOn` is absent — fail-closed per §3.7 (any `minTenureDays >= 0`
 * criterion then correctly fails to match).
 */
export function tenureDays(joinedOn: Timestamp | Date | null | undefined, now: Date): number {
  const joined = toLocalDate(joinedOn);
  if (!joined) return -1;
  return Math.floor((now.getTime() - joined.getTime()) / 86_400_000);
}

/**
 * Count of configured terms whose `startDate` is on/after `joinedOn` and
 * on/before `now` — "how many semesters have you been here, counting the
 * one you joined in." Returns `-1` when `joinedOn` is absent (fail-closed,
 * matching `tenureDays`).
 */
export function completedTermsSince(
  joinedOn: Timestamp | Date | null | undefined,
  now: Date,
  terms: TermDef[],
): number {
  const joined = toLocalDate(joinedOn);
  if (!joined) return -1;
  const joinedMs = joined.getTime();
  const nowMs = now.getTime();
  let count = 0;
  for (const t of terms) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.startDate);
    if (!match) continue;
    const [, y, m, d] = match;
    const start = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
    if (start >= joinedMs && start <= nowMs) count += 1;
  }
  return count;
}
