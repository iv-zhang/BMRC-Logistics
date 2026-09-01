/**
 * EVT-BULK — Phase 5a bulk event creation, headless core
 * (medops-signup-plan.md §5.9, §4.1 `eventTemplates`, §2.2 `seriesId`, §8 Phase 5).
 *
 * Two kinds of assertion live in this file, matching evt-tiers.test.ts's and
 * evt-reminders.test.ts's rule exactly:
 *  - The PURE functions in `app/lib/event-series.ts` (`expandEventSeries`,
 *    `formatSeriesName`, `resolveAccessTierForDate`, `parsePastedEvents`,
 *    `diagnoseDraftRows`) do no I/O — asserted directly against their return
 *    value. These suites (01–07) skip `wipeEvents()`: there is nothing in
 *    Firestore for them to touch or be confused by.
 *  - `createEventsBulk` / `deleteBulkCreatedEvents` (`app/lib/events.ts`) are
 *    real writes — asserted only against a RE-READ `events`/`shift_requests`
 *    document, never against the value passed in or the function's own
 *    return value alone (suites 08–10).
 *
 * Decisions protected:
 *  - **§5.9, the load-bearing bug this phase exists to prevent**: tier
 *    windows and `generalOpensAt` are absolute per-event `Timestamp`s, so the
 *    generator must resolve each row's access tier from THAT row's own date,
 *    never copy one row's instant across the series — "twelve events that all
 *    open for signup on the same day... only discovered by members."
 *    EVT-BULK-04 is that test, verbatim from the plan's own worked example
 *    (4-week series, `generalLeadDays: 7`, four DISTINCT `generalOpensAt`).
 *  - **Local time, not epoch arithmetic** (§5.9's "two more traps"): a
 *    recurrence must never be built with `new Date(t + n*864e5)`, which
 *    shifts an event by an hour across a DST boundary and by a day at a
 *    month end. EVT-BULK-01/02 assert real calendar-day spacing (not raw
 *    millisecond spacing) across a genuine DST spring-forward and a genuine
 *    month-end crossing.
 *  - **P16**: bulk creation writes through `createEvent` once per row, with
 *    no second write path — this file does not assert *how* `createEventsBulk`
 *    writes, only that the RE-READ documents are correct, which is exactly
 *    what would catch a parallel writer that skipped `createEvent`'s
 *    validation/defaulting.
 *  - **§5.9 "bulk means bulk failure"**: `createEventsBulk` collects failures
 *    instead of throwing — 12 of 14 created is a good outcome a rollback
 *    would throw away. EVT-BULK-09 proves the call never rejects and that
 *    the good rows still land even when a bad row is present.
 *  - **§5.9 undo guard**: `deleteBulkCreatedEvents` deletes BY ID, never by
 *    querying `seriesId`, and only ever deletes a `status === 'draft'` event
 *    with ZERO `shift_requests` — "the moment a member signs up, the event
 *    has stopped being scaffolding." EVT-BULK-10 proves both halves of the
 *    guard independently (a draft event with a request is kept; a published
 *    event with no requests is kept) and that a kept event's data is
 *    genuinely untouched by re-reading it.
 *  - **Row diagnostics never block on volume**: `diagnoseDraftRows` flags
 *    `duplicate`/`sameDay` as informational only (never `blocked`) — "a
 *    doubleheader is real" — while `invalid` (no date, no name, no
 *    `callTime` per P12) blocks that row alone. EVT-BULK-07.
 *  - **A dropped column must be visible, not silently lost**:
 *    `parsePastedEvents`'s `ignoredColumns` is the mechanism; a `Notes`
 *    header is a special case that is NOT dropped (it maps to `description`).
 *    EVT-BULK-06.
 *
 * A note on interpreting the contract where it left an implementation detail
 * unstated: `formatSeriesName`'s `ctx.index` is read here as the 0-based
 * array position (the natural value `expandEventSeries` would pass per row),
 * with `{n}` rendering as `index + 1` — matching the doc comment "{n}
 * (1-based index)" directly on the export. If the implementing agent chose
 * to have callers pass an already-1-based `index`, EVT-BULK-05 will fail on
 * exactly that point and nothing else; flagged in the phase report either way.
 */
import { defineInvariant, db } from '../harness';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  setDoc,
} from 'firebase/firestore';
import {
  createEvent,
  createEmptyTeam,
  requestShift,
  setEventStatus,
  createEventsBulk,
  deleteBulkCreatedEvents,
  clampEmtCount,
  MIN_EMTS,
  MAX_EMTS,
  type EventActor,
  type ShiftRequester,
  type BulkCreateRow,
} from '@/app/lib/events';
import type { Event, EventTeam, ShiftRequest } from '@/app/types';
import {
  expandEventSeries,
  formatSeriesName,
  resolveAccessTierForDate,
  parsePastedEvents,
  diagnoseDraftRows,
  draftRowToCreateInput,
  type EventSeriesSpec,
  type DraftEventRow,
} from '@/app/lib/event-series';
import type {
  EventTemplateDef,
  EventTemplateTeamDef,
  EventTemplateAccessTierPreset,
} from '@/app/config/org-config';

// ── local helpers (mirrors evt-reminders.test.ts's / evt-tiers.test.ts's shape) ──

/** `events`/`shift_requests`/`notifications` aren't in SEED_COLLECTIONS, so clear
 *  them per suite that actually touches Firestore (08–10 only — 01–07 exercise
 *  pure functions with zero I/O and have nothing to wipe). */
async function wipeEvents(): Promise<void> {
  for (const name of ['events', 'shift_requests', 'notifications']) {
    const snap = await getDocs(collection(db, name));
    if (snap.empty) continue;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

const MANAGER: EventActor = { uid: 'medops-1', name: 'Devon MedOps', role: 'medops' };

/** A cert-valid requester (EMT + CPR unexpired) so cert gating never masks a result. */
async function requester(uid: string, name: string, role: string): Promise<ShiftRequester> {
  const future = new Date(Date.now() + 365 * 86400000);
  const certifications = { emt: { expiresOn: future }, cpr: { expiresOn: future } };
  await setDoc(
    doc(db, 'users', uid),
    { uid, name, role, certifications, memberStatus: 'general' },
    { merge: true },
  );
  return { uid, name, role, certifications, memberStatus: 'general' };
}

/** A 2-EMT team, matching evt-tiers.test.ts's / evt-reminders.test.ts's shape. */
function team1(): EventTeam {
  return { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
}

async function readEvent(id: string): Promise<Event> {
  const snap = await getDoc(doc(db, 'events', id));
  const data = snap.data() as Event;
  return { ...data, id: snap.id, date: (data.date as { toDate?: () => Date })?.toDate?.() ?? data.date };
}

async function readRequests(eventId: string): Promise<ShiftRequest[]> {
  const snap = await getDocs(query(collection(db, 'shift_requests'), where('eventId', '==', eventId)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }));
}

// ── date-arithmetic helpers used ONLY as an independent oracle in this test
//    file — never imported from event-series.ts, so they can't accidentally
//    validate the module against itself. All local-component construction
//    (`new Date(y, m, d)`), never epoch math — exactly the discipline §5.9
//    requires of the code under test.

/** Local midnight of `y`-`m`-`d` (m is 0-based, matching `Date`). */
function localDay(y: number, m: number, d: number): Date {
  return new Date(y, m, d, 0, 0, 0, 0);
}

/** Exact integer number of CALENDAR days between two dates, immune to any
 *  DST shift in either date's own local time-of-day (compares Y/M/D only). */
function calendarDayDiff(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86_400_000);
}

function isLocalMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/** True iff this machine's local timezone observes a DST-style offset change
 *  at all in `year` (comparing Jan 1 vs Jul 1). Some environments (UTC,
 *  Arizona, CI containers pinned to a fixed-offset zone) never do — the
 *  DST-crossing half of EVT-BULK-01 is then genuinely vacuous there, and the
 *  suite says so explicitly rather than silently passing for the wrong reason. */
function localObservesDst(year: number): boolean {
  return new Date(year, 0, 1).getTimezoneOffset() !== new Date(year, 6, 1).getTimezoneOffset();
}

/** First "spring forward" (offset DECREASES — clocks move forward, so the
 *  minutes-behind-UTC figure drops) day of `year` in the local timezone, or
 *  null if none exists. Scans the whole year rather than assuming any
 *  specific US rule, so it's correct for whatever TZ this process runs under. */
function findDstTransitionDay(year: number): Date | null {
  let prevOffset = new Date(year, 0, 1).getTimezoneOffset();
  for (let d = 1; d < 366; d++) {
    const cur = new Date(year, 0, 1 + d);
    const curOffset = cur.getTimezoneOffset();
    if (curOffset < prevOffset) return localDay(cur.getFullYear(), cur.getMonth(), cur.getDate());
    prevOffset = curOffset;
  }
  return null;
}

/**
 * Independent oracle for a weekly/biweekly/etc. recurrence, implementing the
 * contract's own words literally: "Week 1 is the week containing `from`."
 * Read here as a rolling 7-day block starting at `from`'s own calendar day
 * (not a Sunday-anchored calendar week) — every suite that uses more than one
 * weekday (EVT-BULK-03) picks `from` to land ON one of its own weekdays so
 * this reading and a Sunday-anchored reading coincide, sidestepping the
 * ambiguity entirely rather than betting the test on one interpretation.
 */
function expectedRecurrence(from: Date, to: Date, weekdays: number[], everyNWeeks: number): Date[] {
  const fromMid = localDay(from.getFullYear(), from.getMonth(), from.getDate());
  const out: Date[] = [];
  const cursor = localDay(fromMid.getFullYear(), fromMid.getMonth(), fromMid.getDate());
  while (cursor.getTime() <= to.getTime()) {
    if (weekdays.includes(cursor.getDay())) {
      const weekIndex = Math.floor(calendarDayDiff(fromMid, cursor) / 7);
      if (weekIndex % everyNWeeks === 0) out.push(localDay(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function datesEqual(a: Date[], b: Date[]): boolean {
  return a.length === b.length && a.every((d, i) => d.getTime() === b[i]!.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-01 — weekly recurrence across a genuine DST spring-forward: exactly
// 7 calendar days apart, each at local midnight, same weekday throughout
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-01', 'expandEventSeries across a genuine DST spring-forward boundary yields dates exactly 7 calendar days apart, each at local midnight, same weekday throughout', async (t) => {
  const now = new Date();
  const dstYear = now.getFullYear() + 1; // a full future year, never already-passed relative to `now`
  const transition = findDstTransitionDay(dstYear);
  const dstObserved = localObservesDst(dstYear);

  if (!transition || !dstObserved) {
    t.note(`this environment's local timezone does not observe a DST-style offset change in ${dstYear} — the DST-crossing half of this suite is vacuous here. Asserting calendar-day spacing anyway, per the phase contract, rather than skipping the suite outright.`);
  }

  // Anchor: the real transition day if one exists, else an arbitrary mid-March
  // day so the suite still exercises the same recurrence math.
  const anchor = transition ?? localDay(dstYear, 2, 15);
  const weekday = anchor.getDay();
  const from = localDay(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 21);
  const to = localDay(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 21);

  const spec: EventSeriesSpec = { recurrence: { from, to, weekdays: [weekday], everyNWeeks: 1 }, namePattern: 'DST {n}' };
  const rows = expandEventSeries(spec, { keyPrefix: 'dst' });
  const expected = expectedRecurrence(from, to, [weekday], 1);

  t.ok(expected.length >= 6, `sanity: the oracle itself produced a real multi-week series (${expected.length} rows) — the test range is wide enough to matter`);
  t.equal(rows.length, expected.length, `expandEventSeries produced exactly ${expected.length} rows, matching the independent oracle`);
  t.ok(datesEqual(rows.map((r) => r.date!), expected), 'every row date matches the independently-computed expected calendar day, in order');
  t.ok(rows.every((r) => isLocalMidnight(r.date!)), 'every row date is genuinely local midnight, not merely "close to" midnight');
  t.ok(rows.every((r) => r.date!.getDay() === weekday), 'every row lands on the SAME weekday throughout the whole expansion, DST boundary included');

  for (let i = 1; i < rows.length; i++) {
    t.equal(calendarDayDiff(rows[i - 1]!.date!, rows[i]!.date!), 7, `row ${i - 1}->${i}: exactly 7 CALENDAR days apart (not 6 or 8, which a UTC-offset bug would produce right at the transition)`);
  }

  if (transition && dstObserved) {
    // Non-vacuousness proof: find the pair of consecutive rows whose interval
    // straddles the real transition day, and show their raw millisecond gap
    // is NOT exactly 7*86400000 — i.e., the clocks genuinely moved during
    // this interval, so the calendar-day assertions above are doing real
    // work, not passing by coincidence.
    const straddleIdx = rows.findIndex((r, i) => i > 0 && rows[i - 1]!.date!.getTime() < transition.getTime() && r.date!.getTime() >= transition.getTime());
    t.ok(straddleIdx > 0, 'sanity: at least one consecutive row pair genuinely straddles the transition day');
    if (straddleIdx > 0) {
      const gapMs = rows[straddleIdx]!.date!.getTime() - rows[straddleIdx - 1]!.date!.getTime();
      t.ok(gapMs !== 7 * 86_400_000, 'PROOF this is non-vacuous: the raw millisecond gap across the transition is NOT a clean 7*86400000 — the local clock genuinely shifted, and the calendar-day (not millisecond) comparison above is what caught it correctly');
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-02 — weekly recurrence across a genuine month end: no day slips
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-02', 'expandEventSeries across a month end (and into a second month) never slips a day — every row is exactly 7 calendar days from the last, month and day both correct', async (t) => {
  // The plan's own §5.9 example: Jan 25 -> Mar 1. Fixed calendar dates are
  // fine here — expandEventSeries is a pure function with no wall-clock
  // dependence, so there is nothing to gain from anchoring this to `now`.
  const from = localDay(2027, 0, 25); // Jan 25, 2027
  const to = localDay(2027, 2, 1); // Mar 1, 2027
  const weekday = from.getDay();

  const spec: EventSeriesSpec = { recurrence: { from, to, weekdays: [weekday], everyNWeeks: 1 }, namePattern: 'Month End {n}' };
  const rows = expandEventSeries(spec, { keyPrefix: 'me' });
  const expected = expectedRecurrence(from, to, [weekday], 1);

  t.equal(rows.length, expected.length, `expandEventSeries produced exactly ${expected.length} rows (Jan 25 -> Mar 1, weekly), matching the independent oracle`);
  t.ok(datesEqual(rows.map((r) => r.date!), expected), 'every row date matches the independently-computed expected calendar day, in order');
  t.ok(rows.every((r) => isLocalMidnight(r.date!)), 'every row date is local midnight');
  t.ok(rows.every((r) => r.date!.getDay() === weekday), 'every row lands on the same weekday throughout');

  const months = new Set(rows.map((r) => `${r.date!.getFullYear()}-${r.date!.getMonth()}`));
  t.ok(months.size >= 2, `sanity: this series genuinely crosses at least one month boundary (rows fall in ${months.size} distinct year-months)`);
  t.ok(rows.some((r) => r.date!.getMonth() === 0), 'at least one row is still in January (before the crossing)');
  t.ok(rows.some((r) => r.date!.getMonth() === 1), 'at least one row lands in February (the crossing did not skip it)');
  t.ok(rows.some((r) => r.date!.getMonth() === 2 && r.date!.getDate() === 1), 'the final row is genuinely March 1 — the day did not slip to Feb 29/30 or roll into a wrong month');

  for (let i = 1; i < rows.length; i++) {
    t.equal(calendarDayDiff(rows[i - 1]!.date!, rows[i]!.date!), 7, `row ${i - 1}->${i}: exactly 7 calendar days apart across the month boundary`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-03 — everyNWeeks:2 with two weekdays keeps only on-pattern weeks;
// `dates` overrides `recurrence`; duplicate days are deduped
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-03', 'everyNWeeks:2 with two selected weekdays yields only the on-pattern weeks; dates wins over recurrence when both are present; same-day duplicates are removed', async (t) => {
  const now = new Date();
  // `from` is deliberately a Sunday so "the week containing from" is
  // unambiguous under either a Sunday-anchored or a from-anchored reading —
  // see the oracle's doc comment.
  const from = localDay(now.getFullYear(), now.getMonth(), now.getDate());
  while (from.getDay() !== 0) from.setDate(from.getDate() + 1);
  from.setDate(from.getDate() + 14); // push well into the future, arbitrary
  const to = localDay(from.getFullYear(), from.getMonth(), from.getDate() + 32);
  const weekdays = [0, 3]; // Sunday and Wednesday

  const spec: EventSeriesSpec = { recurrence: { from, to, weekdays, everyNWeeks: 2 }, namePattern: 'Biweekly {n}' };
  const rows = expandEventSeries(spec, { keyPrefix: 'bw' });
  const expected = expectedRecurrence(from, to, weekdays, 2);

  t.equal(expected.length, 6, 'sanity: the oracle itself expects exactly 6 on-pattern occurrences (weeks 0, 2, 4 x 2 weekdays) in this range');
  t.equal(rows.length, 6, 'expandEventSeries returns exactly 6 rows — the off-pattern weeks (1, 3, 5), which DO fall inside [from, to], are correctly excluded');
  t.ok(datesEqual(rows.map((r) => r.date!), expected), 'the 6 returned dates exactly match the on-pattern set, in ascending order');

  const offPatternSunWeek1 = localDay(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  const offPatternWedWeek3 = localDay(from.getFullYear(), from.getMonth(), from.getDate() + 24);
  t.ok(!rows.some((r) => r.date!.getTime() === offPatternSunWeek1.getTime()), 'an off-pattern week-1 Sunday (in range, wrong week) is genuinely absent, not merely under-counted');
  t.ok(!rows.some((r) => r.date!.getTime() === offPatternWedWeek3.getTime()), 'an off-pattern week-3 Wednesday is likewise absent');

  // dates overrides recurrence: two hand-picked dates, one duplicated at a
  // different time-of-day (dedup-by-day) and deliberately out of order (sort).
  const dA = localDay(from.getFullYear(), from.getMonth(), from.getDate() + 100);
  const dADupDifferentTime = new Date(dA.getTime() + 9 * 3_600_000); // same calendar day, 9am
  const dB = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 5, 15, 30);

  const overrideSpec: EventSeriesSpec = {
    recurrence: { from, to, weekdays, everyNWeeks: 2 }, // present, but must be ignored
    dates: [dA, dADupDifferentTime, dB],
    namePattern: 'Picked {n}',
  };
  const overrideRows = expandEventSeries(overrideSpec, { keyPrefix: 'ov' });

  t.equal(overrideRows.length, 2, 'dates wins over recurrence (2 distinct days), AND the same-day duplicate collapsed to one row');
  t.ok(overrideRows[0]!.date!.getTime() < overrideRows[1]!.date!.getTime(), 'output is sorted ascending by date');
  t.equal(overrideRows[0]!.date!.getTime(), localDay(dB.getFullYear(), dB.getMonth(), dB.getDate()).getTime(), 'the earlier hand-picked date (dB) comes first, normalized to local midnight regardless of its time-of-day input');
  t.equal(overrideRows[1]!.date!.getTime(), localDay(dA.getFullYear(), dA.getMonth(), dA.getDate()).getTime(), 'the later hand-picked date (dA) comes second, also normalized to local midnight — the recurrence pattern never leaked in');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-04 — THE load-bearing suite (§5.9): four DISTINCT generalOpensAt
// values, each exactly `generalLeadDays` before its OWN row's date; same for
// a window's leadDays
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-04', 'a 4-week series from a template with generalLeadDays:7 produces four DISTINCT generalOpensAt values, each exactly 7 days before its OWN row date — never one shared date across the series', async (t) => {
  const now = new Date();
  const base = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  const dates = [0, 1, 2, 3].map((i) => localDay(base.getFullYear(), base.getMonth(), base.getDate() + i * 7));

  const preset: EventTemplateAccessTierPreset = {
    windows: [{ label: 'FTOs early', leadDays: 10, criteria: { roles: ['FTO'] } }],
    generalLeadDays: 7,
    rationale: 'FTOs get 3 extra days before general signup opens.',
  };
  const template: EventTemplateDef = {
    id: 'tmpl-bulk04',
    name: 'EVT-BULK-04 Weekly Series Template',
    callTime: '18:00',
    teams: [{ name: 'Team 1', emtCount: 2, hasFtoIntern: false }],
    accessTierPreset: preset,
  };

  const spec: EventSeriesSpec = { template, dates, namePattern: '{type} {n}' };
  const rows = expandEventSeries(spec, { keyPrefix: 'series' });

  t.equal(rows.length, 4, 'sanity: the series really has 4 rows, one per hand-picked date');
  t.ok(rows.every((r) => !!r.accessTier), 'every row resolved a real accessTier from the template preset');

  const generalMillis = rows.map((r) => r.accessTier!.generalOpensAt.toMillis());
  t.equal(new Set(generalMillis).size, 4, 'THE ASSERTION THAT MATTERS: four DISTINCT generalOpensAt instants — a bug that copies one row’s date across the series collapses this Set to size 1, invisible in the UI');

  const windowMillis = rows.map((r) => r.accessTier!.tiers[0]!.opensAt.toMillis());
  t.equal(new Set(windowMillis).size, 4, 'the same distinctness holds for the window’s own leadDays, not just generalOpensAt');

  rows.forEach((r, i) => {
    const expectedGeneral = localDay(r.date!.getFullYear(), r.date!.getMonth(), r.date!.getDate() - 7);
    const expectedWindow = localDay(r.date!.getFullYear(), r.date!.getMonth(), r.date!.getDate() - 10);
    t.equal(r.accessTier!.generalOpensAt.toMillis(), expectedGeneral.getTime(), `row ${i}: generalOpensAt is exactly 7 days before THIS row's own date (${r.date!.toDateString()}), not some other row's`);
    t.equal(r.accessTier!.tiers[0]!.opensAt.toMillis(), expectedWindow.getTime(), `row ${i}: the FTO window opens exactly 10 days before THIS row's own date`);
    t.equal(r.accessTier!.tiers[0]!.id, 'tier_0', `row ${i}: the single window is given id tier_0`);
    t.equal(r.accessTier!.tiers.length, 1, `row ${i}: exactly one window, matching the one-element preset`);
  });

  // Cross-check against the pure resolver called directly, per row — proves
  // expandEventSeries's per-row embedding didn't diverge from (or reuse a
  // cached result of) resolveAccessTierForDate itself.
  rows.forEach((r, i) => {
    const direct = resolveAccessTierForDate(preset, r.date!);
    t.ok(!!direct, `row ${i}: resolveAccessTierForDate resolves directly against this row's date too`);
    t.equal(direct!.generalOpensAt.toMillis(), r.accessTier!.generalOpensAt.toMillis(), `row ${i}: direct resolveAccessTierForDate call agrees with the row's embedded accessTier (generalOpensAt)`);
    t.equal(direct!.tiers[0]!.opensAt.toMillis(), r.accessTier!.tiers[0]!.opensAt.toMillis(), `row ${i}: direct resolveAccessTierForDate call agrees on the window's opensAt too`);
  });

  t.equal(resolveAccessTierForDate(undefined, rows[0]!.date!), undefined, 'resolveAccessTierForDate(undefined, ...) returns undefined — an untiered template produces no accessTier at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-05 — formatSeriesName token substitution; an unknown token
// survives verbatim
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-05', 'formatSeriesName renders {date:MMM d}, {n}, {type}, {venue}, and every date variant; an unrecognized token is left verbatim, not blanked', async (t) => {
  const date = localDay(2027, 2, 5); // Mar 5, 2027
  const ctx = { date, index: 0, eventType: 'football', venue: 'Main Field' };

  t.equal(formatSeriesName('{date:MMM d}', ctx), 'Mar 5', '{date:MMM d} renders the short month + day');
  t.equal(formatSeriesName('{date:MMM d, yyyy}', ctx), 'Mar 5, 2027', '{date:MMM d, yyyy} includes the year');
  t.equal(formatSeriesName('{date:yyyy-MM-dd}', ctx), '2027-03-05', '{date:yyyy-MM-dd} renders ISO-shaped');
  t.equal(formatSeriesName('{date}', ctx), 'Mar 5', 'bare {date} (no format spec) defaults to MMM d, per the doc comment');
  t.equal(formatSeriesName('Clinic shift {n}', ctx), 'Clinic shift 1', '{n} at array index 0 renders as the 1-based "1"');
  t.equal(formatSeriesName('Clinic shift {n}', { ...ctx, index: 3 }), 'Clinic shift 4', '{n} at array index 3 renders as "4"');
  t.equal(formatSeriesName('{type}', ctx), 'football', '{type} interpolates eventType');
  t.equal(formatSeriesName('{venue}', ctx), 'Main Field', '{venue} interpolates venue');

  const combined = formatSeriesName('{type} vs TBD — {date:MMM d} — {n} — unknown:{bogus}', ctx);
  t.equal(combined, 'football vs TBD — Mar 5 — 1 — unknown:{bogus}', 'all four documented token kinds combine correctly in one pattern');
  t.ok(combined.includes('{bogus}'), 'an unrecognized token is left LITERALLY in the output, not silently dropped or blanked — a manager sees it in the grid and can fix the pattern');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-06 — parsePastedEvents: TSV and CSV, ignored columns, bad dates
// still return the row, missing fields fall back to the template
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-06', 'parsePastedEvents parses TSV and CSV, header matching is case/space/underscore-insensitive, an unmapped column is reported (not silently dropped), a bad date still returns its row with date:null, and missing fields fall back to the template', async (t) => {
  const template: EventTemplateDef = {
    id: 'tmpl-bulk06',
    name: 'EVT-BULK-06 Fallback Template',
    callTime: '20:00',
    venue: 'HQ',
    eventType: 'meeting',
    teams: [{ name: 'Team 1', emtCount: 2, hasFtoIntern: false }],
  };

  // Deliberately spaced/mixed-case headers ("Event Type", "Call Time") to
  // exercise the case/space/underscore-insensitive matching rule, plus one
  // genuinely unmapped column ("Foo").
  const tsv = [
    'Date\tName\tEvent Type\tVenue\tCall Time\tFoo',
    '2027-03-05\tGame 1\tfootball\tMain Field\t18:00\tignored-value',
    'not-a-date\tGame 2\t\t\t\t',
    '2027-03-08\tGame 3\t\t\t\t',
  ].join('\n');

  const tsvResult = parsePastedEvents(tsv, template, { keyPrefix: 'tsv' });
  t.equal(tsvResult.rows.length, 3, 'all three data rows come back, including the one with an unparseable date');
  t.ok(tsvResult.ignoredColumns.some((c) => c.toLowerCase().trim() === 'foo'), '"Foo" (genuinely unmapped) is reported in ignoredColumns — not silently dropped');

  const [r0, r1, r2] = tsvResult.rows;
  t.equal(r0!.date?.getTime(), localDay(2027, 2, 5).getTime(), 'row 0: the date parses as local Mar 5, 2027');
  t.equal(r0!.name, 'Game 1', 'row 0: name parses');
  t.equal(r0!.eventType, 'football', 'row 0: "Event Type" (space-separated header) correctly maps to eventType');
  t.equal(r0!.venue, 'Main Field', 'row 0: venue parses');
  t.equal(r0!.callTime, '18:00', 'row 0: "Call Time" (space-separated header) correctly maps to callTime');

  t.equal(r1!.date, null, 'row 1: an unparseable date comes back as date:null, not a thrown error or a dropped row');
  t.equal(r1!.name, 'Game 2', 'row 1: the rest of the row is still usable even though the date failed to parse');
  t.equal(r1!.callTime, '20:00', "row 1: callTime is still absent -> falls back to the template even on a row whose date didn't parse");

  t.equal(r2!.date?.getTime(), localDay(2027, 2, 8).getTime(), 'row 2: date parses as local Mar 8, 2027');
  t.equal(r2!.callTime, '20:00', 'row 2: empty callTime falls back to template.callTime');
  t.equal(r2!.venue, 'HQ', 'row 2: empty venue falls back to template.venue');
  t.equal(r2!.eventType, 'meeting', 'row 2: empty eventType falls back to template.eventType');

  // CSV: comma-delimited (no tab in the header line), plus the 'notes' ->
  // description special-case mapping, plus proof that fully-recognized
  // headers produce an EMPTY ignoredColumns (no false positives).
  const csv = ['Date,Name,Notes', '2027-03-06,Game 4,check weather forecast'].join('\n');
  const csvResult = parsePastedEvents(csv, template, { keyPrefix: 'csv' });

  t.equal(csvResult.rows.length, 1, 'the CSV form parses (comma delimiter chosen because the header has no tab)');
  t.equal(csvResult.ignoredColumns.length, 0, 'every CSV header here is recognized -> ignoredColumns is genuinely empty, not a false positive');
  const csvRow = csvResult.rows[0]!;
  t.equal(csvRow.date?.getTime(), localDay(2027, 2, 6).getTime(), 'CSV row date parses');
  t.equal(csvRow.name, 'Game 4', 'CSV row name parses');
  t.equal(csvRow.description, 'check weather forecast', "'Notes' maps to description, per the export's explicit NOTE");
  t.equal(csvRow.callTime, '20:00', 'CSV row has no CallTime column at all -> falls back to the template, same as an empty cell would');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-07 — diagnoseDraftRows: duplicate (warn, not blocked), sameDay
// (informational, both against existing AND within the batch), invalid
// (blocked) for each of its three triggers
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-07', 'diagnoseDraftRows: same-day+same-name is duplicate (never blocked); same-day-only is sameDay (existing AND intra-batch); missing date/name/callTime is invalid and blocked, and ONLY those three trigger it', async (t) => {
  const now = new Date();
  const D = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 10);
  const D2 = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 11);
  const D3 = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 12);
  const D4 = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 13);
  const D5 = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 14);
  const teams = [{ name: 'Team 1', emtCount: 2, hasFtoIntern: false }];

  const rDup: DraftEventRow = { key: 'dup', date: D, name: '  Big Game  ', callTime: '18:00', teams };
  const rSameDay: DraftEventRow = { key: 'sameday', date: D, name: 'Different Game', callTime: '18:00', teams };
  const rBatchA: DraftEventRow = { key: 'batch-a', date: D2, name: 'Batch A', callTime: '18:00', teams };
  const rBatchB: DraftEventRow = { key: 'batch-b', date: D2, name: 'Batch B', callTime: '18:00', teams };
  const rInvalidNoDate: DraftEventRow = { key: 'inv-date', date: null, name: 'X', callTime: '18:00', teams };
  const rInvalidNoName: DraftEventRow = { key: 'inv-name', date: D3, name: '', callTime: '18:00', teams };
  const rInvalidNoCallTime: DraftEventRow = { key: 'inv-calltime', date: D4, name: 'Y', callTime: '', teams };
  const rClean: DraftEventRow = { key: 'clean', date: D5, name: 'Clean Row', callTime: '18:00', teams };

  const rows = [rDup, rSameDay, rBatchA, rBatchB, rInvalidNoDate, rInvalidNoName, rInvalidNoCallTime, rClean];
  const existing = [{ name: 'Big Game', date: D }];

  const diag = diagnoseDraftRows(rows, existing);

  // Every row got a diagnosis, and reasons is always parallel in length to flags.
  for (const r of rows) {
    const d = diag[r.key];
    t.ok(!!d, `row ${r.key} has a diagnosis entry`);
    t.equal(d!.reasons.length, d!.flags.length, `row ${r.key}: reasons has one entry per flag, same order`);
  }

  t.ok(diag['dup']!.flags.includes('duplicate'), 'same local day + same trimmed, case-insensitive name as an existing event -> duplicate');
  t.equal(diag['dup']!.blocked, false, 'duplicate warns but never blocks — a doubleheader is real');

  t.ok(diag['sameday']!.flags.includes('sameDay'), 'same local day, DIFFERENT name -> sameDay (informational), not duplicate');
  t.ok(!diag['sameday']!.flags.includes('duplicate'), 'sameday row is genuinely not also flagged duplicate — the names differ');
  t.equal(diag['sameday']!.blocked, false, 'sameDay never blocks either');

  t.ok(diag['batch-a']!.flags.includes('sameDay'), 'sameDay also fires WITHIN the batch (batch-a collides with batch-b), not only against the existing feed');
  t.ok(diag['batch-b']!.flags.includes('sameDay'), 'and symmetrically for the other row in the same-day pair');
  t.equal(diag['batch-a']!.blocked, false, 'intra-batch sameDay still never blocks');

  t.ok(diag['inv-date']!.flags.includes('invalid'), 'no date -> invalid');
  t.equal(diag['inv-date']!.blocked, true, 'invalid blocks THAT ROW');
  t.ok(diag['inv-name']!.flags.includes('invalid'), 'empty name -> invalid');
  t.equal(diag['inv-name']!.blocked, true, 'invalid blocks that row too');
  t.ok(diag['inv-calltime']!.flags.includes('invalid'), 'empty callTime (P12) -> invalid');
  t.equal(diag['inv-calltime']!.blocked, true, 'invalid blocks that row too');

  t.equal(diag['clean']!.flags.length, 0, 'a row with no conflicts and all required fields present gets zero flags');
  t.equal(diag['clean']!.blocked, false, 'and is never blocked');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-08 — createEventsBulk against the real emulator: N events created,
// RE-READ with the right dates and a shared seriesId, status:'draft' by
// default, and onProgress called N times ending at (N, N)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-08', 'createEventsBulk creates N events; re-read documents have the right dates, status:draft by default, and one SHARED seriesId; onProgress fires N times ending at (N, N)', async (t) => {
  await wipeEvents();
  const now = new Date();
  const N = 3;
  const rows: BulkCreateRow[] = Array.from({ length: N }, (_, i) => ({
    key: `row-${i}`,
    input: {
      name: `EVT-BULK-08 Event ${i}`,
      date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 30 + i * 7),
      callTime: '18:00',
      teams: [team1()],
    },
  }));

  const progressCalls: [number, number][] = [];
  const result = await createEventsBulk(rows, MANAGER, { onProgress: (done, total) => progressCalls.push([done, total]) });

  t.equal(result.created.length, N, `createEventsBulk reports ${N} created`);
  t.equal(result.failed.length, 0, 'nothing failed in this all-valid batch');
  t.ok(!!result.seriesId, 'a seriesId was generated (opts.seriesId was not supplied)');

  t.equal(progressCalls.length, N, `onProgress was called exactly ${N} times, once per row`);
  t.ok(progressCalls.every(([, total]) => total === N), 'every progress call reports the same total');
  t.ok(progressCalls.every(([done], i) => done === i + 1), 'done increments 1, 2, ... N in call order');
  t.equal(progressCalls[progressCalls.length - 1]?.[0], N, 'the FINAL progress call reports done === N');
  t.equal(progressCalls[progressCalls.length - 1]?.[1], N, 'the FINAL progress call reports total === N — ends at (N, N)');

  // Re-read every created id — never trust result.created's own fields alone.
  for (let i = 0; i < N; i++) {
    const created = result.created.find((c) => c.key === `row-${i}`);
    t.ok(!!created, `a created entry exists for row-${i}`);
    const reread = await readEvent(created!.id);
    t.equal(reread.name, `EVT-BULK-08 Event ${i}`, `re-read event ${i}: name matches`);
    t.equal((reread.date as Date).getTime(), rows[i]!.input.date.getTime(), `re-read event ${i}: date matches what was submitted, exactly`);
    t.equal(reread.status, 'draft', `re-read event ${i}: status defaults to 'draft' (bulk rows never open signup on their own)`);
    t.equal(reread.seriesId, result.seriesId, `re-read event ${i}: seriesId matches the batch's shared seriesId`);
  }

  // All N share the SAME seriesId, re-read via a live query, not by trusting
  // the in-memory result object alone.
  const bySeriesSnap = await getDocs(query(collection(db, 'events'), where('seriesId', '==', result.seriesId)));
  t.equal(bySeriesSnap.size, N, `querying events by seriesId==${result.seriesId} finds exactly ${N} documents`);

  // opts.seriesId passthrough: a second, distinct batch with an explicit id.
  const explicitSeriesId = 'evt-bulk-08-explicit-series';
  const rows2: BulkCreateRow[] = [
    { key: 'e2-a', input: { name: 'EVT-BULK-08 Explicit A', date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 90), callTime: '19:00', teams: [team1()] } },
    { key: 'e2-b', input: { name: 'EVT-BULK-08 Explicit B', date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 97), callTime: '19:00', teams: [team1()] } },
  ];
  const result2 = await createEventsBulk(rows2, MANAGER, { seriesId: explicitSeriesId });
  t.equal(result2.seriesId, explicitSeriesId, 'when opts.seriesId is supplied, the RETURNED seriesId is exactly that value, not a freshly generated one');
  const explicitSnap = await getDocs(query(collection(db, 'events'), where('seriesId', '==', explicitSeriesId)));
  t.equal(explicitSnap.size, 2, 're-read: both events from the second batch were stamped with the EXPLICIT seriesId, not a generated one');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-09 — partial failure: one bad row is collected in failed[] while
// every other row still lands in created[]; the call never rejects
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-09', 'a row with an empty name is collected in failed[] while every other row still creates successfully, and createEventsBulk never rejects', async (t) => {
  await wipeEvents();
  const now = new Date();
  const rows: BulkCreateRow[] = [
    { key: 'good-1', input: { name: 'EVT-BULK-09 Good 1', date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 20), callTime: '18:00', teams: [team1()] } },
    { key: 'bad-1', input: { name: '', date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 21), callTime: '18:00', teams: [team1()] } },
    { key: 'good-2', input: { name: 'EVT-BULK-09 Good 2', date: localDay(now.getFullYear(), now.getMonth(), now.getDate() + 22), callTime: '18:00', teams: [team1()] } },
  ];

  let result: Awaited<ReturnType<typeof createEventsBulk>> | undefined;
  let threw = false;
  try {
    result = await createEventsBulk(rows, MANAGER);
  } catch {
    threw = true;
  }
  t.ok(!threw, 'createEventsBulk NEVER rejects, even with an invalid row in the batch — the whole point of collecting failures instead of throwing');
  t.ok(!!result, 'a result object was returned');

  t.equal(result!.failed.length, 1, 'exactly one row failed');
  t.equal(result!.failed[0]?.key, 'bad-1', 'the failed entry names the correct row key');
  t.ok(!!result!.failed[0]?.error, 'the failed entry carries a non-empty error/reason string');

  t.equal(result!.created.length, 2, 'BOTH good rows still landed in created[] — one bad row does not sink the batch');
  t.ok(result!.created.some((c) => c.key === 'good-1'), 'good-1 is among the created entries');
  t.ok(result!.created.some((c) => c.key === 'good-2'), 'good-2 is among the created entries');

  // Re-read: the two good events genuinely persisted, and NOTHING persisted
  // for the bad row (an empty-name event is not silently written).
  const goodSnap = await getDocs(query(collection(db, 'events'), where('seriesId', '==', result!.seriesId)));
  t.equal(goodSnap.size, 2, 're-read: exactly 2 documents exist under this seriesId — the failed row wrote nothing');
  const names = goodSnap.docs.map((d) => (d.data() as Event).name);
  t.ok(names.includes('EVT-BULK-09 Good 1') && names.includes('EVT-BULK-09 Good 2'), 're-read: both good events are present by name');
  t.ok(!names.some((n) => n === ''), 're-read: no event with an empty name was written for the failed row');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-10 — deleteBulkCreatedEvents: deletes a draft event with zero
// requests; keeps (does not delete) a draft event WITH a request, a
// published event with zero requests, and a nonexistent id — all guarded
// independently, all proven by re-reading the surviving documents
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-10', 'deleteBulkCreatedEvents deletes only a draft event with zero shift_requests; a draft-with-a-request, a published event, and a nonexistent id are each independently kept with a reason, and kept events are untouched on re-read', async (t) => {
  await wipeEvents();
  const now = new Date();
  const day = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 14);

  // Deletable: plain draft (createEvent's own default when status is omitted), zero requests.
  const refDelete = await createEvent({ name: 'EVT-BULK-10 Delete Me', date: day, callTime: '18:00', teams: [team1()] }, MANAGER);

  // Kept-for-requests: has to be 'open' for requestShift to succeed, then
  // demoted back to 'draft' — isolating the guard to the REQUEST half only.
  const refKeepReq = await createEvent({ name: 'EVT-BULK-10 Has Request', date: day, callTime: '18:00', teams: [team1()], status: 'open' }, MANAGER);
  const bulk10Requester = await requester('bulk10-member', 'Bulk10 Member', 'member');
  await requestShift(await readEvent(refKeepReq.id), 'team-1', 'EMT', bulk10Requester);
  await setEventStatus(refKeepReq.id, 'draft');
  const reqsBefore = await readRequests(refKeepReq.id);
  t.equal(reqsBefore.length, 1, "sanity: refKeepReq really is 'draft' status with exactly one real shift_requests doc");

  // Kept-for-status: published ('open'), zero requests — isolating the guard
  // to the STATUS half only.
  const refKeepPub = await createEvent({ name: 'EVT-BULK-10 Published', date: day, callTime: '18:00', teams: [team1()], status: 'open' }, MANAGER);

  const result = await deleteBulkCreatedEvents([refDelete.id, refKeepReq.id, refKeepPub.id, 'does-not-exist-id']);

  t.equal(result.deleted.length, 1, 'exactly one event was deleted');
  t.ok(result.deleted.includes(refDelete.id), 'the deleted id is the draft/zero-requests event, and only that one');

  t.equal(result.kept.length, 3, 'the other three ids (draft-with-request, published, nonexistent) are each kept, none silently dropped from the report');
  const keptReq = result.kept.find((k) => k.id === refKeepReq.id);
  const keptPub = result.kept.find((k) => k.id === refKeepPub.id);
  const keptMissing = result.kept.find((k) => k.id === 'does-not-exist-id');
  t.ok(!!keptReq && !!keptReq.reason, 'the draft-with-a-request event is kept, with a non-empty reason');
  t.ok(!!keptPub && !!keptPub.reason, 'the published (non-draft) event is kept, with a non-empty reason');
  t.ok(!!keptMissing && !!keptMissing.reason, 'a nonexistent id is kept (not silently ignored, not thrown), with a non-empty reason');

  // Re-read every document — this is the load-bearing proof, not the
  // function's own return value.
  const deletedSnap = await getDoc(doc(db, 'events', refDelete.id));
  t.equal(deletedSnap.exists(), false, 're-read: the deleted event genuinely no longer exists in Firestore');

  const keepReqSnap = await getDoc(doc(db, 'events', refKeepReq.id));
  t.equal(keepReqSnap.exists(), true, 're-read: the draft-with-a-request event genuinely still exists');
  t.equal((keepReqSnap.data() as Event | undefined)?.status, 'draft', "re-read: its status is untouched ('draft')");

  const keepPubSnap = await getDoc(doc(db, 'events', refKeepPub.id));
  t.equal(keepPubSnap.exists(), true, 're-read: the published event genuinely still exists');
  t.equal((keepPubSnap.data() as Event | undefined)?.status, 'open', "re-read: its status is untouched ('open')");

  const reqsAfter = await readRequests(refKeepReq.id);
  t.equal(reqsAfter.length, 1, 're-read: the shift_requests doc that saved refKeepReq from deletion is itself still there, untouched — undo never cascades into requests');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-11 — draftRowToCreateInput's blocked-row guard: throws independently
// on a missing date, a missing/whitespace-only name, and a missing/
// whitespace-only callTime; a genuinely clean row does not throw at all. This
// is the seam Phase 5b's bulk modal calls once per row — a caller who skips
// `diagnoseDraftRows` first must get a loud failure, never a malformed event.
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-11', 'draftRowToCreateInput throws independently on a missing date, a missing/whitespace-only name, and a missing/whitespace-only callTime, naming the offending row key; a clean row does not throw', async (t) => {
  const D = localDay(2027, 4, 1); // May 1, 2027 — arbitrary fixed date; the function is pure
  const teams: EventTemplateTeamDef[] = [{ name: 'Team 1', emtCount: 2, hasFtoIntern: false }];

  const cases: [string, DraftEventRow][] = [
    ['missing date', { key: 'r-no-date', date: null, name: 'Real Name', callTime: '18:00', teams }],
    ['empty name', { key: 'r-empty-name', date: D, name: '', callTime: '18:00', teams }],
    ['whitespace-only name', { key: 'r-ws-name', date: D, name: '   \t  ', callTime: '18:00', teams }],
    ['missing callTime', { key: 'r-no-calltime', date: D, name: 'Real Name', callTime: '', teams }],
    ['whitespace-only callTime', { key: 'r-ws-calltime', date: D, name: 'Real Name', callTime: '   ', teams }],
  ];

  for (const [label, row] of cases) {
    let threw = false;
    let message = '';
    try {
      draftRowToCreateInput(row);
    } catch (e) {
      threw = true;
      message = (e as Error)?.message ?? '';
    }
    t.ok(threw, `draftRowToCreateInput throws on a row with ${label}`);
    t.ok(message.includes(row.key), `the thrown error names the offending row key ("${row.key}") so a caller can trace it back to the review grid`);
  }

  const rowClean: DraftEventRow = { key: 'r-clean', date: D, name: 'Real Name', callTime: '18:00', teams };
  let cleanThrew = false;
  try {
    draftRowToCreateInput(rowClean);
  } catch {
    cleanThrew = true;
  }
  t.ok(!cleanThrew, 'a genuinely clean row (real date, non-blank name, non-blank callTime) does NOT throw');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-12 — team construction: each EventTemplateTeamDef becomes a real
// EventTeam (ftoSlot, emtSlots of length emtCount, hasFtoIntern passed
// through, an ftoInternSlot present); team ids are unique within one event AND
// unique across two separate draftRowToCreateInput calls, since a whole
// series is converted by calling this function once per row in a loop.
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-12', 'draftRowToCreateInput builds one real EventTeam per EventTemplateTeamDef (ftoSlot, emtSlots of length emtCount, hasFtoIntern passed through, an ftoInternSlot present); team ids are unique within one event and unique across two separate calls converting the same series', async (t) => {
  const D = localDay(2027, 4, 3);
  const teamsDef: EventTemplateTeamDef[] = [
    { name: 'Alpha', emtCount: 2, hasFtoIntern: true },
    { name: 'Bravo', emtCount: 4, hasFtoIntern: false },
    { name: 'Charlie', emtCount: 3, hasFtoIntern: true },
  ];
  const row: DraftEventRow = { key: 'multi-team', date: D, name: 'Multi Team Event', callTime: '17:00', teams: teamsDef };

  const input = draftRowToCreateInput(row);
  t.equal(input.teams!.length, 3, 'one EventTeam is built per EventTemplateTeamDef, in order');

  input.teams!.forEach((team, i) => {
    const def = teamsDef[i]!;
    t.equal(team.name, def.name, `team ${i}: name passed through from the def`);
    t.ok(!!team.ftoSlot, `team ${i}: has a real ftoSlot object`);
    t.equal(Object.keys(team.ftoSlot).length, 0, `team ${i}: ftoSlot is genuinely empty (unfilled), not pre-seeded with a userId`);
    t.equal(team.emtSlots.length, def.emtCount, `team ${i}: emtSlots has length ${def.emtCount}, matching this def's own emtCount (already inside the 2-4 range)`);
    t.ok(team.emtSlots.every((s) => Object.keys(s).length === 0), `team ${i}: every emtSlot is genuinely empty`);
    t.equal(team.hasFtoIntern, def.hasFtoIntern, `team ${i}: hasFtoIntern passed through unchanged from the def`);
    t.ok(!!team.ftoInternSlot, `team ${i}: has a real ftoInternSlot object, even for the team with hasFtoIntern:false`);
  });

  // Team ids unique WITHIN one event.
  const idsWithinEvent = input.teams!.map((tm) => tm.id);
  t.equal(new Set(idsWithinEvent).size, 3, 'all 3 team ids are unique within this single event — no accidental collision building three teams in one loop');

  // Team ids unique ACROSS two separate draftRowToCreateInput calls — a whole
  // series is converted by calling this function once per row in a loop, so a
  // per-call-scoped counter (instead of the module-level `teamIdSeq`) would
  // silently collide ids across events in the same batch.
  const row2: DraftEventRow = { key: 'multi-team-2', date: localDay(2027, 4, 10), name: 'Second Event', callTime: '17:00', teams: teamsDef };
  const input2 = draftRowToCreateInput(row2);
  const idsAcrossCalls = [...idsWithinEvent, ...input2.teams!.map((tm) => tm.id)];
  t.equal(new Set(idsAcrossCalls).size, 6, 'team ids are unique across TWO SEPARATE draftRowToCreateInput calls too — exactly the pattern a bulk series conversion loop uses');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-13 — the 2-4 EMT clamp. `buildTeamFromDef` MIRRORS clampEmtCount
// inline (it may not value-import events.ts), so this suite exists to keep the
// copy honest: every case is asserted against the REAL clampEmtCount, not a
// hand-written expectation. emtCount:0 is the case that actually drifted — see
// D29 in docs/medops-signup-plan.md.
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-13', "draftRowToCreateInput's EMT clamp is byte-for-byte equivalent to clampEmtCount for EVERY input, emtCount:0 included — the bulk path and the single-event editor path can never produce different team sizes from the same number. Trivially true since Phase 5b deleted the inline mirror and both now call the one copy in org-config; kept so that reintroducing a mirror fails loudly (D29)", async (t) => {
  const D = localDay(2027, 4, 5);

  const buildWithEmtCount = (emtCount: number): number => {
    const row: DraftEventRow = { key: `emt-${emtCount}`, date: D, name: 'EMT Clamp Row', callTime: '18:00', teams: [{ name: 'Solo', emtCount, hasFtoIntern: false }] };
    return draftRowToCreateInput(row).teams![0]!.emtCount;
  };

  // `buildTeamFromDef` cannot import `clampEmtCount` (this module must not take a
  // VALUE import back into events.ts — see event-series.ts's header), so it mirrors
  // the rule inline. A mirror that is only *mostly* right is worse than no mirror:
  // this suite is the thing that keeps the copy honest, so every case is asserted
  // against the real `clampEmtCount` rather than against a hand-written expectation.
  // 0 is listed explicitly because it is the one that actually drifted (D29): the
  // original `Math.round(x) || 3` treated falsy-0 as "unset" and returned 3, so the
  // same template team produced 3 EMT slots through the bulk path and 2 through the
  // single-event editor.
  const cases: number[] = [0, 1, 2, 3, 4, 5, 2.4, 2.6, -1, -10, NaN];
  for (const n of cases) {
    const actual = buildWithEmtCount(n);
    const expected = clampEmtCount(n);
    t.equal(actual, expected, `emtCount:${n} -> ${actual}, matching app/lib/events.ts's real clampEmtCount(${n}) === ${expected}`);
  }

  // 0 and NaN are the two branch-selecting inputs; assert their absolute values too,
  // so a future edit that changed BOTH implementations in the same wrong direction
  // still fails here rather than agreeing with itself.
  t.equal(buildWithEmtCount(0), 2, 'emtCount:0 resolves to 2 — the MIN bound, not the 3-EMT default: 0 is a real number a manager typed, not an unset field');
  t.equal(buildWithEmtCount(NaN), 3, 'a non-finite emtCount (an unset or unparsed field) resolves to the 3-EMT default, which is the only case that legitimately takes the default branch');

  // Sanity: every produced emtCount lands within [2,4].
  for (const n of cases) {
    const actual = buildWithEmtCount(n);
    t.ok(actual >= MIN_EMTS && actual <= MAX_EMTS, `emtCount input ${n}: result ${actual} is within [${MIN_EMTS}, ${MAX_EMTS}]`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-14 — passthrough: accessTier, waitlistEnabled, seriesId, eventType,
// venue, location, endTime, description all reach the returned
// CreateEventInput intact; name is trimmed; an empty teams[] falls back to one
// default team.
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-14', 'draftRowToCreateInput passes accessTier, waitlistEnabled, seriesId, eventType, venue, location, endTime, and description through unchanged, trims name, and falls back to one default Team 1 (emtCount:3, hasFtoIntern:true) when teams is empty', async (t) => {
  const D = localDay(2027, 4, 20);
  const preset: EventTemplateAccessTierPreset = {
    windows: [{ label: 'Early', leadDays: 5, criteria: {} }],
    generalLeadDays: 3,
    rationale: 'test rationale',
  };
  const accessTier = resolveAccessTierForDate(preset, D);
  t.ok(!!accessTier, 'sanity: the accessTier fixture actually resolved to something non-undefined');

  const row: DraftEventRow = {
    key: 'passthrough',
    date: D,
    name: '  Padded Name  ',
    eventType: 'training',
    venue: 'HQ Bay',
    location: 'Room 2',
    callTime: '19:30',
    endTime: '21:00',
    description: 'a passthrough test row',
    teams: [{ name: 'Solo', emtCount: 2, hasFtoIntern: true }],
    waitlistEnabled: false,
    accessTier,
  };

  const input = draftRowToCreateInput(row, 'series-xyz');

  t.equal(input.name, 'Padded Name', 'name is trimmed');
  t.equal(input.eventType, 'training', 'eventType passes through');
  t.equal(input.venue, 'HQ Bay', 'venue passes through');
  t.equal(input.location, 'Room 2', 'location passes through');
  t.equal(input.callTime, '19:30', 'callTime passes through');
  t.equal(input.endTime, '21:00', 'endTime passes through');
  t.equal(input.description, 'a passthrough test row', 'description passes through');
  t.equal(input.waitlistEnabled, false, 'waitlistEnabled passes through, including the explicit `false` value (not coerced away to undefined/true)');
  t.equal(input.seriesId, 'series-xyz', 'the seriesId argument passes through onto the returned CreateEventInput');
  t.ok(input.accessTier === accessTier, 'the accessTier object passes through by reference, unchanged — draftRowToCreateInput does not rebuild or mutate it');
  t.equal(input.date.getTime(), D.getTime(), "date passes through unchanged");

  // Empty teams[] fallback.
  const emptyTeamsRow: DraftEventRow = { key: 'empty-teams', date: D, name: 'Fallback Team Row', callTime: '18:00', teams: [] };
  const emptyTeamsInput = draftRowToCreateInput(emptyTeamsRow);
  t.equal(emptyTeamsInput.teams!.length, 1, 'a row with teams:[] yields exactly one default team, not zero teams');
  const defaultTeam = emptyTeamsInput.teams![0]!;
  t.equal(defaultTeam.name, 'Team 1', "the default team is named 'Team 1'");
  t.equal(defaultTeam.emtCount, 3, 'the default team has emtCount:3');
  t.equal(defaultTeam.emtSlots.length, 3, 'the default team has 3 emtSlots, matching its emtCount');
  t.equal(defaultTeam.hasFtoIntern, true, 'the default team has hasFtoIntern:true');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-BULK-15 — THE full 5a chain, end to end, against the real emulator:
// expandEventSeries -> diagnoseDraftRows -> draftRowToCreateInput (per
// unblocked row) -> createEventsBulk, then RE-READ the created docs from
// Firestore and assert: N events created, one shared seriesId, and — the bug
// §5.9 calls the worst one bulk creation can produce — each event's
// accessTier opening instants are DISTINCT per row and correctly offset from
// THAT row's own date, never one shared date across the series.
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-BULK-15', 'the full Phase 5a chain (expandEventSeries -> diagnoseDraftRows -> draftRowToCreateInput -> createEventsBulk), re-read from Firestore: N events created under one shared seriesId, each with its own DISTINCT accessTier opening instants correctly offset from that row\'s own date — never one shared date across the series', async (t) => {
  await wipeEvents();
  const now = new Date();
  const base = localDay(now.getFullYear(), now.getMonth(), now.getDate() + 60);
  const dates = [0, 1, 2, 3, 4].map((i) => localDay(base.getFullYear(), base.getMonth(), base.getDate() + i * 7));

  const preset: EventTemplateAccessTierPreset = {
    windows: [{ label: 'FTOs early', leadDays: 9, criteria: { roles: ['FTO'] } }],
    generalLeadDays: 6,
    rationale: 'EVT-BULK-15 end-to-end chain fixture',
  };
  const template: EventTemplateDef = {
    id: 'tmpl-bulk15',
    name: 'EVT-BULK-15 Series Template',
    callTime: '18:30',
    teams: [{ name: 'Team 1', emtCount: 2, hasFtoIntern: true }],
    accessTierPreset: preset,
  };

  const spec: EventSeriesSpec = { template, dates, namePattern: 'BULK-15 {n}' };
  const rows = expandEventSeries(spec, { keyPrefix: 'e2e' });
  t.equal(rows.length, 5, 'sanity: the series really has 5 rows, one per hand-picked date');

  const diag = diagnoseDraftRows(rows, []);
  const unblockedRows = rows.filter((r) => !diag[r.key]!.blocked);
  t.equal(unblockedRows.length, 5, 'sanity: none of the 5 rows are blocked (every row has a date, name, and callTime, all supplied by the template)');

  const bulkRows: BulkCreateRow[] = unblockedRows.map((row) => ({
    key: row.key,
    input: draftRowToCreateInput(row),
  }));

  const result = await createEventsBulk(bulkRows, MANAGER);
  t.equal(result.created.length, 5, 'all 5 rows created successfully');
  t.equal(result.failed.length, 0, 'no row failed');
  t.ok(!!result.seriesId, 'a seriesId was generated for the whole batch');

  // Re-read every created document from Firestore — never trust the
  // in-memory result or the draft rows themselves for the assertions below.
  const rereadEvents: Event[] = [];
  for (const row of unblockedRows) {
    const created = result.created.find((c) => c.key === row.key);
    t.ok(!!created, `a created entry exists for row ${row.key}`);
    const reread = await readEvent(created!.id);
    rereadEvents.push(reread);
    t.equal(reread.seriesId, result.seriesId, `re-read event for row ${row.key}: shares the batch's seriesId`);
    t.ok(!!reread.accessTier, `re-read event for row ${row.key}: has a real accessTier (not dropped en route to Firestore)`);
  }

  // N events created, sharing ONE seriesId, proven via a live query (not the
  // in-memory result object alone).
  const bySeriesSnap = await getDocs(query(collection(db, 'events'), where('seriesId', '==', result.seriesId)));
  t.equal(bySeriesSnap.size, 5, `querying events by seriesId==${result.seriesId} finds exactly 5 documents`);

  // THE assertion that matters: distinct, correctly-offset accessTier
  // instants, re-read from Firestore (not the draft rows' in-memory values).
  const generalMillis = rereadEvents.map((e) => e.accessTier!.generalOpensAt.toMillis());
  t.equal(new Set(generalMillis).size, 5, 'THE ASSERTION THAT MATTERS: 5 DISTINCT re-read generalOpensAt instants — a bug anywhere in the chain (expansion, conversion, or the bulk write) that collapsed them to one shared date would show up here as a Set of size 1');

  const windowMillis = rereadEvents.map((e) => e.accessTier!.tiers[0]!.opensAt.toMillis());
  t.equal(new Set(windowMillis).size, 5, 'the same distinctness holds for the FTO window opensAt, re-read from Firestore');

  rereadEvents.forEach((e, i) => {
    const rowDate = unblockedRows[i]!.date!;
    const expectedGeneral = localDay(rowDate.getFullYear(), rowDate.getMonth(), rowDate.getDate() - 6);
    const expectedWindow = localDay(rowDate.getFullYear(), rowDate.getMonth(), rowDate.getDate() - 9);
    t.equal(e.accessTier!.generalOpensAt.toMillis(), expectedGeneral.getTime(), `re-read event ${i}: generalOpensAt is exactly 6 days before THIS event's own date (${rowDate.toDateString()}), correctly offset per-row, never one shared date across the series`);
    t.equal(e.accessTier!.tiers[0]!.opensAt.toMillis(), expectedWindow.getTime(), `re-read event ${i}: the FTO window opensAt is exactly 9 days before THIS event's own date`);
    t.equal((e.date as Date).getTime(), rowDate.getTime(), `re-read event ${i}: the event's own date matches this row's date exactly`);
  });
});
