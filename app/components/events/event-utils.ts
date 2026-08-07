/**
 * Shared display helpers for the Shifts board (`/events`). Pure, no Firestore
 * writes — see `app/lib/events.ts` for data operations.
 */

import type { Timestamp, FieldValue } from 'firebase/firestore';
import type { Event, EventTeam, ShiftRequest } from '@/app/types';

/**
 * Coerce a Firestore Timestamp / Date / FieldValue-ish value to a Date, or null.
 * Also handles plain `{seconds,nanoseconds}` (or `_seconds`) maps — legacy event
 * docs written before the deepRemoveUndefined Timestamp fix stored dates that way,
 * so this keeps them displaying instead of crashing / showing "No date".
 */
export function toJsDate(value: Date | Timestamp | FieldValue | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const maybe = value as {
    toDate?: () => Date;
    seconds?: number; _seconds?: number;
    nanoseconds?: number; _nanoseconds?: number;
  };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  const secs = typeof maybe.seconds === 'number' ? maybe.seconds
    : typeof maybe._seconds === 'number' ? maybe._seconds : undefined;
  if (typeof secs === 'number') {
    const nanos = maybe.nanoseconds ?? maybe._nanoseconds ?? 0;
    const d = new Date(secs * 1000 + Math.floor(nanos / 1e6));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function formatEventDate(value: Event['date'] | undefined): string {
  const d = toJsDate(value);
  if (!d) return 'No date';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTimeRange(callTime?: string, endTime?: string): string {
  if (callTime && endTime) return `${callTime} – ${endTime}`;
  return callTime || endTime || '';
}

export type ViewerColor = 'success' | 'warning' | 'primary' | 'default';

export interface ViewerRelation {
  color: ViewerColor;
  label: string;
  request?: ShiftRequest;
}

/** The viewer's most relevant active (pending/approved) request for this event, if any. */
export function myActiveRequestForEvent(
  eventId: string | undefined,
  myRequests: ShiftRequest[],
): ShiftRequest | undefined {
  if (!eventId) return undefined;
  return myRequests.find((r) => r.eventId === eventId && (r.status === 'pending' || r.status === 'approved'));
}

/**
 * Color-code an event by the viewer's relationship to it:
 * success = confirmed (approved request), warning = requested (pending),
 * primary = open and available, default = closed/draft/cancelled.
 */
export function getViewerRelation(event: Event, myRequests: ShiftRequest[]): ViewerRelation {
  const req = myActiveRequestForEvent(event.id, myRequests);
  if (req?.status === 'approved') return { color: 'success', label: 'Confirmed', request: req };
  if (req?.status === 'pending') return { color: 'warning', label: 'Requested', request: req };
  if (event.status === 'open') return { color: 'primary', label: 'Available' };
  const label = event.status === 'draft' ? 'Draft' : event.status === 'cancelled' ? 'Cancelled' : 'Closed';
  return { color: 'default', label };
}

export const VIEWER_COLOR_PILL: Record<ViewerColor, string> = {
  success: 'bg-success-50 dark:bg-success-900/20 text-success',
  warning: 'bg-warning-50 dark:bg-warning-900/20 text-warning',
  primary: 'bg-primary-50 dark:bg-primary-900/20 text-primary',
  default: 'bg-content3 text-foreground-500',
};

export const VIEWER_COLOR_CHIP: Record<ViewerColor, 'success' | 'warning' | 'primary' | 'default'> = {
  success: 'success',
  warning: 'warning',
  primary: 'primary',
  default: 'default',
};

export interface TeamSummary {
  teamId: string;
  name: string;
  ftoOk: boolean;
  emtFilled: number;
  emtCount: number;
  /** Whether this team carries an FTO-intern slot at all. */
  hasIntern: boolean;
  /** Whether that intern slot is filled. NEVER fold this into staffing totals —
   *  the intern is supernumerary (see `EventTeam` in app/types.ts). */
  internFilled: boolean;
}

export function teamSummaryLines(teams: EventTeam[]): TeamSummary[] {
  return teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    ftoOk: !!t.ftoSlot?.userId,
    emtFilled: (t.emtSlots || []).filter((s) => s.userId).length,
    emtCount: t.emtCount,
    hasIntern: t.hasFtoIntern === true,
    internFilled: t.hasFtoIntern === true && !!t.ftoInternSlot?.userId,
  }));
}

export function pendingCountForEvent(eventId: string | undefined, pending: ShiftRequest[]): number {
  if (!eventId) return 0;
  return pending.filter((r) => r.eventId === eventId && r.status === 'pending').length;
}

// ---------------------------------------------------------------------------
// Attendance: call time / lateness / shift-length helpers
// ---------------------------------------------------------------------------

/** Combine `event.date` (the day) with `event.callTime` ("HH:mm") into a Date. Null if no callTime. */
export function eventCallDateTime(event: Event): Date | null {
  if (!event.callTime) return null;
  const day = toJsDate(event.date);
  if (!day) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(event.callTime.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Combine `event.date` with `event.endTime` ("HH:mm") into a Date. Null if the
 * event has no end time — early-departure is undeterminable in that case, which
 * callers must treat as "not early" rather than guessing.
 */
export function eventEndDateTime(event: Event): Date | null {
  if (!event.endTime) return null;
  const day = toJsDate(event.date);
  if (!day) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(event.endTime.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** Minutes an arrival is after the event's call time (never negative). 0 if no call time is set. */
export function computeMinutesLate(arrival: Date, callDateTime: Date | null): number {
  if (!callDateTime) return 0;
  return Math.max(0, Math.round((arrival.getTime() - callDateTime.getTime()) / 60000));
}

/**
 * Minutes a departure is BEFORE the event's end time (never negative). 0 when
 * the event has no end time. There is deliberately no grace window: any
 * departure strictly before the scheduled end counts as leaving early.
 */
export function computeMinutesEarly(departure: Date, endDateTime: Date | null): number {
  if (!endDateTime) return 0;
  return Math.max(0, Math.round((endDateTime.getTime() - departure.getTime()) / 60000));
}

/**
 * Has the event finished? Uses the end datetime when `endTime` is set, else the
 * end of the event day. This is what flips attendance from the live stamp flow
 * to the retroactive (manager-only edit) view — no manual "close" step needed.
 */
export function isEventPast(event: Event, now: Date = new Date()): boolean {
  const end = eventEndDateTime(event);
  if (end) return now.getTime() > end.getTime();
  const day = toJsDate(event.date);
  if (!day) return false;
  const endOfDay = new Date(day);
  endOfDay.setHours(23, 59, 59, 999);
  return now.getTime() > endOfDay.getTime();
}

// ---------------------------------------------------------------------------
// Attendance permissions (who may record / edit, and over which teams)
// ---------------------------------------------------------------------------

export type AttendanceMode = 'live' | 'retro-edit' | 'read-only';

export interface AttendanceAccess {
  /** Whether the attendance panel renders at all for this viewer. */
  visible: boolean;
  mode: AttendanceMode;
  /** Team ids the viewer may see/act on; `null` means every team on the event. */
  scopeTeamIds: string[] | null;
  /** Stamp-only controls (Check in / Check out / No-show / Excused). */
  canRecordLive: boolean;
  /** Retroactive time + status overrides, incl. the arrival/departure inputs. */
  canEditRetro: boolean;
  /** Managers may wipe an attendance record back to unrecorded. */
  canClear: boolean;
  /**
   * True when the viewer is an assigned FTO who has not checked THEMSELVES in
   * yet: they may only act on their own row until they start the shift.
   */
  gatedOnSelfCheckIn: boolean;
  /** User-facing explanation for a restricted state (read-only / gated). */
  reason?: string;
}

/**
 * The single source of truth for attendance permissions (see decisions.md D-29).
 *
 * - Managers (admin/quartermaster/medops) act on every team. While the event is
 *   live they get the stamp controls; once it is past they get the ONLY
 *   retroactive edit surface in the app.
 * - The assigned FTO acts on their own team only, live only, and must check
 *   themselves in first — that is what starts the shift.
 * - An FTO intern is a normal attendee: they are checked in like anyone else and
 *   get no recording powers of their own.
 * - Everyone else: no panel.
 */
export function getAttendanceAccess(params: {
  event: Event;
  viewerRole: string | null | undefined;
  viewerUid: string | null | undefined;
  /** Whether the viewer's own approved request already has a check-in stamp. */
  viewerCheckedIn: boolean;
  now?: Date;
}): AttendanceAccess {
  const { event, viewerRole, viewerUid, viewerCheckedIn } = params;
  const now = params.now ?? new Date();
  const isManager =
    viewerRole === 'admin' || viewerRole === 'quartermaster' || viewerRole === 'medops';
  const myFtoTeamIds = (event.teams || [])
    .filter((t) => !!viewerUid && t.ftoSlot?.userId === viewerUid)
    .map((t) => t.id);
  const isAssignedFto = myFtoTeamIds.length > 0;
  const past = isEventPast(event, now);

  if (isManager) {
    return {
      visible: true,
      mode: past ? 'retro-edit' : 'live',
      scopeTeamIds: null,
      canRecordLive: !past,
      canEditRetro: past,
      canClear: true,
      gatedOnSelfCheckIn: false,
    };
  }

  if (isAssignedFto) {
    if (past) {
      return {
        visible: true,
        mode: 'read-only',
        scopeTeamIds: myFtoTeamIds,
        canRecordLive: false,
        canEditRetro: false,
        canClear: false,
        gatedOnSelfCheckIn: false,
        reason: 'This event has ended — contact MedOps or an admin to correct attendance.',
      };
    }
    return {
      visible: true,
      mode: 'live',
      scopeTeamIds: myFtoTeamIds,
      canRecordLive: true,
      canEditRetro: false,
      canClear: false,
      gatedOnSelfCheckIn: !viewerCheckedIn,
      reason: viewerCheckedIn ? undefined : 'Check yourself in to start the shift.',
    };
  }

  return {
    visible: false,
    mode: 'read-only',
    scopeTeamIds: [],
    canRecordLive: false,
    canEditRetro: false,
    canClear: false,
    gatedOnSelfCheckIn: false,
  };
}

/** Hours between check-in and shift-end, rounded to 1 decimal. Null if either is missing/unresolved. */
export function shiftHours(
  checkedInAt: Date | Timestamp | FieldValue | undefined,
  shiftEndAt: Date | Timestamp | FieldValue | undefined,
): number | null {
  const start = toJsDate(checkedInAt);
  const end = toJsDate(shiftEndAt);
  if (!start || !end) return null;
  const hours = (end.getTime() - start.getTime()) / 3600000;
  if (!Number.isFinite(hours) || hours < 0) return null;
  return Math.round(hours * 10) / 10;
}
