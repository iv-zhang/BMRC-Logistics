/**
 * Staffing / shift-signup tiles for the /stats dashboard.
 *
 * Sources: `events` (+ `teams[]`) and `shift_requests`. Every tile here is a
 * pure `(data, filters, tileId?) => result` function — no Firestore reads.
 * Reuses the shift/attendance math that already lives in `app/lib/events.ts`
 * and `app/components/events/event-utils.ts` rather than re-deriving it.
 *
 * Domain rules this file must not re-derive incorrectly (see CLAUDE.md):
 * - Attendance is a check-in stamp, not a stored status. A request "attended"
 *   iff `attendance.checkedInAt` is set AND `attendance.exception` is unset.
 *   'present'/'late' are never stored values.
 * - `attendance.minutesLate` is a snapshot computed at check-in time. Prefer
 *   it; only fall back to `computeMinutesLate` when it's absent (e.g. a
 *   legacy record) and we can resolve the event's call time.
 * - `Event.callTime` is a report-for-duty time, not a 911 call — there is no
 *   incident/response data in this system, so nothing here is a "response
 *   time".
 * - Required slots for an event = sum over `teams` of (1 FTO + `emtCount`
 *   EMTs). `teamFilledCount` (from events.ts) is the single source of truth
 *   for how many of those are actually filled.
 */

import {
  toDate,
  inRange,
  bucketBy,
  groupBy,
  median,
  histogram,
  passesCrossFilters,
  type StatsData,
  type StatsFilterState,
} from './shared';
import type { Event as BmrcEvent, ShiftRequest } from '@/app/types';
import { teamFilledCount, getMemberShiftStats, formatMemberExperience } from '@/app/lib/events';
import { computeMinutesLate, eventCallDateTime, shiftHours } from '@/app/components/events/event-utils';
import { daysUntilExpiry } from '@/app/lib/certifications';
import { getSemesterStart } from '@/app/config/org-config';

// ── Scoping helpers (range + cross-filters, shared by every tile below) ─────

function eventDate(e: BmrcEvent): Date | null {
  return toDate(e.date);
}

function eventCrossFields(e: BmrcEvent) {
  return { eventName: e.name, eventType: e.eventType, venue: e.venue };
}

/** Events whose date falls in `filters.range` and that pass cross-filters. */
function eventsInScope(data: StatsData, filters: StatsFilterState, tileId?: string): BmrcEvent[] {
  return data.events.filter((e) => {
    if (!inRange(eventDate(e), filters.range)) return false;
    return passesCrossFilters(eventCrossFields(e), filters.crossFilters, tileId);
  });
}

function buildEventById(data: StatsData): Map<string, BmrcEvent> {
  const m = new Map<string, BmrcEvent>();
  for (const e of data.events) if (e.id) m.set(e.id, e);
  return m;
}

/** Event date for a request: prefer the denormalized `eventDate`, else look up the event. */
function requestDate(r: ShiftRequest, eventById: Map<string, BmrcEvent>): Date | null {
  const own = toDate(r.eventDate);
  if (own) return own;
  const ev = eventById.get(r.eventId);
  return ev ? eventDate(ev) : null;
}

function requestCrossFields(r: ShiftRequest, ev: BmrcEvent | undefined) {
  return {
    eventName: r.eventName ?? ev?.name,
    eventType: ev?.eventType,
    venue: ev?.venue,
    memberName: r.userName,
    role: r.role,
  };
}

/** Requests whose (denormalized-or-looked-up) event date falls in range and pass cross-filters. */
function requestsInScope(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { r: ShiftRequest; event?: BmrcEvent }[] {
  const eventById = buildEventById(data);
  return data.shiftRequests
    .map((r) => ({ r, event: eventById.get(r.eventId) }))
    .filter(({ r, event }) => {
      if (!inRange(requestDate(r, eventById), filters.range)) return false;
      return passesCrossFilters(requestCrossFields(r, event), filters.crossFilters, tileId);
    });
}

/** True iff the request attended: checked in and no exception (see domain rule above). */
function isCheckedIn(r: ShiftRequest): boolean {
  return r.status === 'approved' && !r.attendance?.exception && !!r.attendance?.checkedInAt;
}

/** Prefer the stored `minutesLate` snapshot; recompute only when absent. */
function resolvedMinutesLate(r: ShiftRequest, event: BmrcEvent | undefined): number | null {
  if (!isCheckedIn(r)) return null;
  const att = r.attendance;
  if (typeof att?.minutesLate === 'number') return att.minutesLate;
  const arrival = toDate(att?.checkedInAt);
  if (!arrival) return null;
  const callDateTime = event ? eventCallDateTime(event) : null;
  return computeMinutesLate(arrival, callDateTime);
}

function requiredAndFilled(events: BmrcEvent[]): { required: number; filled: number } {
  let required = 0;
  let filled = 0;
  for (const e of events) {
    for (const team of e.teams || []) {
      required += 1 + (team.emtCount || 0);
      const f = teamFilledCount(team);
      filled += f.fto + f.emt;
    }
  }
  return { required, filled };
}

// ── Tiles ─────────────────────────────────────────────────────────────────

/** Staffing fill rate over time, bucketed on event date. `rate` is null when required is 0. */
export function fillRateOverTime(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; required: number; filled: number; rate: number | null }[] {
  const events = eventsInScope(data, filters, tileId);
  const buckets = bucketBy(events, eventDate, filters.range);
  return buckets.map((b) => {
    const { required, filled } = requiredAndFilled(b.items);
    return { label: b.label, required, filled, rate: required > 0 ? filled / required : null };
  });
}

/** Count of empty FTO vs. EMT slots across events in scope. */
export function unfilledSlotsByRole(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: 'FTO' | 'EMT'; value: number }[] {
  const events = eventsInScope(data, filters, tileId);
  let unfilledFto = 0;
  let unfilledEmt = 0;
  for (const e of events) {
    for (const team of e.teams || []) {
      const f = teamFilledCount(team);
      unfilledFto += 1 - f.fto;
      unfilledEmt += (team.emtCount || 0) - f.emt;
    }
  }
  return [
    { label: 'FTO', value: unfilledFto },
    { label: 'EMT', value: unfilledEmt },
  ];
}

/**
 * Funnel from raw demand down to outcome. "Requested" counts every request
 * regardless of status (the top of the funnel); the rest narrow to approved
 * requests only, since attendance is only ever recorded on an approved request.
 */
export function attendanceFunnel(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { stage: 'Requested' | 'Approved' | 'Checked in' | 'No-show' | 'Excused'; value: number }[] {
  const scoped = requestsInScope(data, filters, tileId);
  let approved = 0;
  let checkedIn = 0;
  let noShow = 0;
  let excused = 0;
  for (const { r } of scoped) {
    if (r.status !== 'approved') continue;
    approved += 1;
    if (r.attendance?.exception === 'no_show') noShow += 1;
    else if (r.attendance?.exception === 'excused') excused += 1;
    else if (r.attendance?.checkedInAt) checkedIn += 1;
  }
  return [
    { stage: 'Requested', value: scoped.length },
    { stage: 'Approved', value: approved },
    { stage: 'Checked in', value: checkedIn },
    { stage: 'No-show', value: noShow },
    { stage: 'Excused', value: excused },
  ];
}

/** Distribution of arrival lateness (minutes) across checked-in attendances. */
export function latenessHistogram(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; from: number; to: number; value: number }[] {
  const scoped = requestsInScope(data, filters, tileId);
  const values: number[] = [];
  for (const { r, event } of scoped) {
    const late = resolvedMinutesLate(r, event);
    if (late !== null) values.push(late);
  }
  return histogram(values);
}

/**
 * Median lateness per member, worst first. Members with fewer than 2
 * checked-in shifts are excluded — a median over one point is noise.
 */
export function latenessByMember(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; medianLate: number; shifts: number }[] {
  const scoped = requestsInScope(data, filters, tileId);
  const byMember = new Map<string, { name: string; values: number[] }>();
  for (const { r, event } of scoped) {
    const late = resolvedMinutesLate(r, event);
    if (late === null) continue;
    const entry = byMember.get(r.userId) ?? { name: r.userName, values: [] };
    entry.values.push(late);
    byMember.set(r.userId, entry);
  }
  const rows = [...byMember.values()]
    .filter((m) => m.values.length >= 2)
    .map((m) => ({ label: m.name, medianLate: median(m.values) as number, shifts: m.values.length }));
  rows.sort((a, b) => b.medianLate - a.medianLate);
  return rows;
}

/**
 * Hours logged per member, reusing `getMemberShiftStats` for the shift-hours
 * math. Computed over the requests currently in scope (range + cross-filters),
 * so "all-time"/"semester" here mean "within the dashboard's active filters",
 * not literally the member's full history.
 */
export function hoursByMember(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; allTimeHours: number; semesterHours: number; shifts: number }[] {
  const scoped = requestsInScope(data, filters, tileId);
  const byMember = new Map<string, { name: string; requests: ShiftRequest[] }>();
  for (const { r } of scoped) {
    const entry = byMember.get(r.userId) ?? { name: r.userName, requests: [] };
    entry.requests.push(r);
    byMember.set(r.userId, entry);
  }
  const semesterStart = getSemesterStart();
  const rows = [...byMember.values()].map((m) => {
    const stats = getMemberShiftStats(m.requests, semesterStart);
    return {
      label: m.name,
      allTimeHours: stats.hoursAllTime,
      semesterHours: stats.hoursThisSemester,
      shifts: stats.shiftsAllTime,
    };
  });
  rows.sort((a, b) => b.allTimeHours - a.allTimeHours);
  return rows;
}

/**
 * Participation grouped by experience cohort — `formatMemberExperience`
 * (memberStatus + joinedTerm, e.g. "General · Fall 2025") is the cohort label,
 * matching the roster's D-15 experience model. Only approved requests count
 * as a "shift".
 */
export function participationByCohort(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; members: number; shifts: number; avgShiftsPerMember: number | null }[] {
  const scoped = requestsInScope(data, filters, tileId);
  const byCohort = new Map<string, { members: Set<string>; shifts: number }>();
  for (const { r } of scoped) {
    if (r.status !== 'approved') continue;
    const label = formatMemberExperience(r.memberStatus, r.joinedTerm);
    const entry = byCohort.get(label) ?? { members: new Set<string>(), shifts: 0 };
    entry.members.add(r.userId);
    entry.shifts += 1;
    byCohort.set(label, entry);
  }
  return [...byCohort.entries()].map(([label, { members, shifts }]) => ({
    label,
    members: members.size,
    shifts,
    avgShiftsPerMember: members.size > 0 ? shifts / members.size : null,
  }));
}

type RunwayBucket = 'Expired' | '<30d' | '30-60d' | '60-90d' | '>90d';
const RUNWAY_BUCKETS: RunwayBucket[] = ['Expired', '<30d', '30-60d', '60-90d', '>90d'];

/**
 * Members bucketed by days until their signup-gating certs (EMT + CPR, the
 * pair `canSignUpForShifts` actually checks) run out. The runway is limited
 * by whichever cert expires first; a missing cert is treated the same as
 * already-expired, since either blocks signup today. No date-range filter
 * applies here — this is a roster snapshot, not an event-dated series.
 */
export function certExpiryRunway(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: RunwayBucket; value: number }[] {
  const counts: Record<RunwayBucket, number> = {
    Expired: 0,
    '<30d': 0,
    '30-60d': 0,
    '60-90d': 0,
    '>90d': 0,
  };
  for (const u of data.users) {
    if (!passesCrossFilters({ memberName: u.fullName, role: u.role }, filters.crossFilters, tileId)) continue;
    const daysEmt = daysUntilExpiry(u.certifications?.emt);
    const daysCpr = daysUntilExpiry(u.certifications?.cpr);
    const days = daysEmt === null || daysCpr === null ? null : Math.min(daysEmt, daysCpr);
    let bucket: RunwayBucket;
    if (days === null || days < 0) bucket = 'Expired';
    else if (days < 30) bucket = '<30d';
    else if (days < 60) bucket = '30-60d';
    else if (days < 90) bucket = '60-90d';
    else bucket = '>90d';
    counts[bucket] += 1;
  }
  return RUNWAY_BUCKETS.map((label) => ({ label, value: counts[label] }));
}

/** Requests received vs. slots offered, per event — a demand/supply ratio. */
export function requestSupplyDemand(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): { label: string; requests: number; slots: number; ratio: number | null }[] {
  const events = eventsInScope(data, filters, tileId);
  const requestsByEvent = groupBy(data.shiftRequests, (r) => r.eventId);
  const rows = events.map((e) => {
    const slots = (e.teams || []).reduce((acc, t) => acc + 1 + (t.emtCount || 0), 0);
    const requests = e.id ? requestsByEvent.get(e.id)?.length ?? 0 : 0;
    return { label: e.name, requests, slots, ratio: slots > 0 ? requests / slots : null };
  });
  rows.sort((a, b) => (b.ratio ?? -Infinity) - (a.ratio ?? -Infinity));
  return rows;
}

/** Headline staffing KPIs for the scoped range + cross-filters. */
export function staffingKpis(
  data: StatsData,
  filters: StatsFilterState,
  tileId?: string
): {
  eventCount: number;
  overallFillRate: number | null;
  attendanceRate: number | null;
  noShowCount: number;
  totalHours: number;
  membersActive: number;
} {
  const events = eventsInScope(data, filters, tileId);
  const { required, filled } = requiredAndFilled(events);

  const scoped = requestsInScope(data, filters, tileId);
  let approved = 0;
  let checkedIn = 0;
  let noShowCount = 0;
  let totalHours = 0;
  const activeMembers = new Set<string>();
  for (const { r } of scoped) {
    if (r.status !== 'approved') continue;
    approved += 1;
    activeMembers.add(r.userId);
    if (r.attendance?.exception === 'no_show') {
      noShowCount += 1;
    } else if (isCheckedIn(r)) {
      checkedIn += 1;
      const hours = shiftHours(r.attendance?.checkedInAt, r.attendance?.shiftEndAt);
      if (hours != null) totalHours += hours;
    }
  }

  return {
    eventCount: events.length,
    overallFillRate: required > 0 ? filled / required : null,
    attendanceRate: approved > 0 ? checkedIn / approved : null,
    noShowCount,
    totalHours: Math.round(totalHours * 10) / 10,
    membersActive: activeMembers.size,
  };
}
