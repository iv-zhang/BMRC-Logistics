'use client';

/**
 * Events + shift-staffing operations (`events` and `shift_requests` collections).
 *
 * An event is staffed by one or more TEAMS; each team is exactly one FTO plus
 * `emtCount` EMTs (clamped 2–4, default 3), plus an optional single FTO-INTERN
 * who shadows the FTO. Members self-request a role on a team
 * (`shift_requests`); a manager (admin/quartermaster/medops) approves, which
 * places them into an open slot on the event's `teams` array.
 *
 * Eligibility: FTO-role members may request FTO or EMT slots; `fto_intern`-role
 * members may request the intern or EMT slot; everyone else may request EMT
 * slots only. The intern is supernumerary — never counted toward staffing
 * totals. Signup is additionally gated on valid certifications, identically for
 * every role including interns (see app/lib/certifications.ts).
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  runTransaction,
  writeBatch,
  serverTimestamp,
  Timestamp,
  type FieldValue,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { deepRemoveUndefined } from '@/app/lib/audit';
import { canSignUpForShifts, getShiftBlockReason } from '@/app/lib/certifications';
import { createNotification, broadcastNotification } from '@/app/lib/notifications';
import type {
  Event,
  EventTeam,
  EventStatus,
  ShiftRequest,
  SlotRole,
  TeamSlot,
  User,
  AttendanceStatus,
} from '@/app/types';
import {
  shiftHours,
  eventCallDateTime,
  eventEndDateTime,
  computeMinutesLate,
  computeMinutesEarly,
} from '@/app/components/events/event-utils';

export interface EventActor {
  uid: string;
  name: string;
  role?: string;
}

export const MIN_EMTS = 2;
export const MAX_EMTS = 4;
export const DEFAULT_EMTS = 3;

/** Roles that may create/edit/staff events. NOT the same as `isAdmin`. */
export function isEventManagerRole(role?: string | null): boolean {
  return role === 'admin' || role === 'quartermaster' || role === 'medops';
}

/**
 * May a member of `userRole` request `slotRole`?
 * - EMT: anyone (including FTOs and interns).
 * - FTO: `FTO` role or a manager. Interns explicitly may NOT — earning the FTO
 *   slot is the whole point of the intern tier.
 * - FTO_INTERN: `fto_intern` role or a manager.
 */
export function canRequestRole(userRole: string | null | undefined, slotRole: SlotRole): boolean {
  if (slotRole === 'EMT') return true;
  if (slotRole === 'FTO_INTERN') return userRole === 'fto_intern' || isEventManagerRole(userRole);
  return userRole === 'FTO' || isEventManagerRole(userRole);
}

/** Human label for a slot role ("FTO Intern" reads better than the raw enum). */
export function slotRoleLabel(slotRole: SlotRole): string {
  return slotRole === 'FTO_INTERN' ? 'FTO Intern' : slotRole;
}

// ---------------------------------------------------------------------------
// Pure team helpers (shared by the editor UI so the 2–4 invariant stays honest)
// ---------------------------------------------------------------------------

export function clampEmtCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EMTS;
  return Math.max(MIN_EMTS, Math.min(MAX_EMTS, Math.round(n)));
}

function emptySlot(): TeamSlot {
  return {};
}

/** Grow/shrink a team's EMT slot array to match `emtCount` (preserving fills). */
export function resizeEmtSlots(slots: TeamSlot[], emtCount: number): TeamSlot[] {
  const count = clampEmtCount(emtCount);
  const next = slots.slice(0, count);
  while (next.length < count) next.push(emptySlot());
  return next;
}

/** New teams carry an FTO-intern slot by default; legacy docs (undefined) do not. */
export function teamHasIntern(team: EventTeam): boolean {
  return team.hasFtoIntern === true;
}

export function createEmptyTeam(name: string, emtCount = DEFAULT_EMTS, hasFtoIntern = true): EventTeam {
  const count = clampEmtCount(emtCount);
  return {
    id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    ftoSlot: emptySlot(),
    hasFtoIntern,
    ftoInternSlot: emptySlot(),
    emtCount: count,
    emtSlots: Array.from({ length: count }, emptySlot),
  };
}

/**
 * Count of filled slots on a team. `intern` is reported separately and must NOT
 * be folded into staffing totals — the intern is supernumerary (see EventTeam).
 */
export function teamFilledCount(team: EventTeam): { fto: number; intern: number; emt: number } {
  return {
    fto: team.ftoSlot?.userId ? 1 : 0,
    intern: teamHasIntern(team) && team.ftoInternSlot?.userId ? 1 : 0,
    emt: (team.emtSlots || []).filter((s) => s.userId).length,
  };
}

// ---------------------------------------------------------------------------
// Event CRUD
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  name: string;
  date: Date;
  eventType?: string;
  venue?: string;
  location?: string;
  callTime?: string;
  endTime?: string;
  description?: string;
  status?: EventStatus;
  teams?: EventTeam[];
}

export async function createEvent(input: CreateEventInput, actor: EventActor) {
  const name = input.name.trim();
  if (!name) throw new Error('Event name is required');
  if (!input.date) throw new Error('Event date is required');
  const teams = input.teams && input.teams.length > 0 ? input.teams : [createEmptyTeam('Team 1')];
  const payload = deepRemoveUndefined({
    name,
    date: Timestamp.fromDate(input.date),
    eventType: input.eventType?.trim() || undefined,
    venue: input.venue?.trim() || undefined,
    location: input.location?.trim() || undefined,
    callTime: input.callTime || undefined,
    endTime: input.endTime || undefined,
    description: input.description?.trim() || undefined,
    status: input.status || 'draft',
    teams,
    notified: false,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return addDoc(collection(db, 'events'), payload);
}

/** Patch event fields. Pass `date` as a Date; it is converted to a Timestamp. */
export async function updateEvent(
  eventId: string,
  patch: Partial<Omit<CreateEventInput, 'date'>> & { date?: Date; teams?: EventTeam[]; notified?: boolean },
) {
  const update: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Event name is required');
    update.name = name;
  }
  if (patch.date !== undefined) update.date = Timestamp.fromDate(patch.date);
  if (patch.eventType !== undefined) update.eventType = patch.eventType.trim() || null;
  if (patch.venue !== undefined) update.venue = patch.venue.trim() || null;
  if (patch.location !== undefined) update.location = patch.location.trim() || null;
  if (patch.callTime !== undefined) update.callTime = patch.callTime || null;
  if (patch.endTime !== undefined) update.endTime = patch.endTime || null;
  if (patch.description !== undefined) update.description = patch.description.trim() || null;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.teams !== undefined) update.teams = patch.teams;
  if (patch.notified !== undefined) update.notified = patch.notified;
  await updateDoc(doc(db, 'events', eventId), update);
}

export async function setEventStatus(eventId: string, status: EventStatus) {
  await updateDoc(doc(db, 'events', eventId), { status, updatedAt: serverTimestamp() });
}

export async function deleteEvent(eventId: string) {
  await deleteDoc(doc(db, 'events', eventId));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ShiftRequester {
  uid: string;
  name: string;
  role?: string | null;
  certifications?: User['certifications'];
  /** Denormalized onto the created request. Missing is treated as 'general' (see `User.memberStatus`). */
  memberStatus?: User['memberStatus'];
  joinedTerm?: User['joinedTerm'];
}

/** Capitalized "New" / "Probationary" / "General", optionally with a term ("General · Fall 2025"). */
export function formatMemberExperience(status?: User['memberStatus'], term?: string): string {
  const resolved = status || 'general';
  const label = resolved.charAt(0).toUpperCase() + resolved.slice(1);
  return term ? `${label} · ${term}` : label;
}

/**
 * Create a member's request for a role on a team. Enforces: event open, cert
 * validity, role eligibility, and no duplicate active request for this event.
 */
export async function requestShift(
  event: Event,
  teamId: string,
  role: SlotRole,
  requester: ShiftRequester,
  note?: string,
): Promise<void> {
  if (event.status !== 'open') throw new Error('This event is not open for signups.');
  if (!canSignUpForShifts(requester)) {
    throw new Error(getShiftBlockReason(requester) || 'Your certifications are not current.');
  }
  if (!canRequestRole(requester.role, role)) {
    throw new Error(
      role === 'FTO_INTERN'
        ? 'Only FTO interns may request the FTO intern slot.'
        : 'Only FTOs may request the FTO slot.',
    );
  }
  const team = event.teams.find((t) => t.id === teamId);
  if (!team) throw new Error('Team not found on this event.');
  if (role === 'FTO_INTERN' && !teamHasIntern(team)) {
    throw new Error('This team does not have an FTO intern slot.');
  }

  // Block a second active request for the same event.
  const existing = await getDocs(
    query(
      collection(db, 'shift_requests'),
      where('eventId', '==', event.id),
      where('userId', '==', requester.uid),
    ),
  );
  const hasActive = existing.docs.some((d) => {
    const s = (d.data() as ShiftRequest).status;
    return s === 'pending' || s === 'approved';
  });
  if (hasActive) throw new Error('You already have an active request for this event.');

  const payload = deepRemoveUndefined({
    eventId: event.id,
    eventName: event.name,
    eventDate: event.date,
    teamId,
    teamName: team.name,
    role,
    userId: requester.uid,
    userName: requester.name,
    memberStatus: requester.memberStatus || 'general',
    joinedTerm: requester.joinedTerm || undefined,
    status: 'pending' as const,
    note: note?.trim() || undefined,
    requestedAt: serverTimestamp(),
  });
  await addDoc(collection(db, 'shift_requests'), payload);

  // Best-effort: notify managers (and the team's FTO, if any) that a new
  // request needs a decision. A notify failure must never fail the request.
  try {
    const managersSnap = await getDocs(
      query(collection(db, 'users'), where('role', 'in', ['admin', 'quartermaster', 'medops'])),
    );
    const ids = managersSnap.docs.map((d) => d.id);
    const ftoId = team.ftoSlot?.userId;
    if (ftoId && ftoId !== requester.uid) ids.push(ftoId);
    await broadcastNotification(
      ids,
      {
        type: 'broadcast',
        title: 'New shift request',
        body: `${requester.name} requested ${team.name} · ${slotRoleLabel(role)} for ${event.name}`,
        link: '/events?event=' + event.id,
      },
      { uid: requester.uid, name: requester.name },
    );
  } catch (e) {
    console.error('shift request notification failed:', e);
  }
}

/**
 * Approve a request: place the member into an open slot on the team and stamp
 * the request. Runs in a transaction against the event doc so slot capacity
 * (1 FTO / emtCount EMTs) can't be oversubscribed by concurrent approvals.
 */
export async function approveRequest(request: ShiftRequest, actor: EventActor): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const eventRef = doc(db, 'events', request.eventId);
  const reqRef = doc(db, 'shift_requests', request.id);

  const assignedSlot = await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists()) throw new Error('Event no longer exists');
    const event = eventSnap.data() as Event;
    const teams = (event.teams || []).map((t) => ({ ...t }));
    const team = teams.find((t) => t.id === request.teamId);
    if (!team) throw new Error('Team no longer exists on this event');

    const slot: TeamSlot = { userId: request.userId, userName: request.userName, requestId: request.id };
    let placed: string;
    if (request.role === 'FTO') {
      if (team.ftoSlot?.userId && team.ftoSlot.userId !== request.userId) {
        throw new Error('The FTO slot on this team is already filled.');
      }
      team.ftoSlot = slot;
      placed = 'fto';
    } else if (request.role === 'FTO_INTERN') {
      if (!teamHasIntern(team)) {
        throw new Error('This team does not have an FTO intern slot.');
      }
      if (team.ftoInternSlot?.userId && team.ftoInternSlot.userId !== request.userId) {
        throw new Error('The FTO intern slot on this team is already filled.');
      }
      team.ftoInternSlot = slot;
      placed = 'intern';
    } else {
      team.emtSlots = resizeEmtSlots(team.emtSlots || [], team.emtCount);
      const idx = team.emtSlots.findIndex((s) => !s.userId);
      if (idx === -1) throw new Error('All EMT slots on this team are full.');
      team.emtSlots[idx] = slot;
      placed = `emt:${idx}`;
    }

    tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
    tx.update(reqRef, {
      status: 'approved',
      assignedSlot: placed,
      decidedBy: actor.uid,
      decidedByName: actor.name,
      decidedAt: serverTimestamp(),
    });
    return placed;
  });

  // Best-effort notification (outside the tx).
  try {
    await createNotification(
      request.userId,
      {
        type: 'request_approved',
        title: `You're confirmed: ${request.eventName}`,
        body: `${request.teamName} · ${slotRoleLabel(request.role)}. See you there!`,
        link: '/events',
      },
      { uid: actor.uid, name: actor.name },
    );
  } catch (e) {
    console.error('approve notification failed:', e);
  }
  void assignedSlot;
}

export async function rejectRequest(
  request: ShiftRequest,
  actor: EventActor,
  reason?: string,
): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  await updateDoc(doc(db, 'shift_requests', request.id), deepRemoveUndefined({
    status: 'rejected',
    note: reason?.trim() || request.note || undefined,
    decidedBy: actor.uid,
    decidedByName: actor.name,
    decidedAt: serverTimestamp(),
  }));
  try {
    await createNotification(
      request.userId,
      {
        type: 'request_rejected',
        title: `Update on ${request.eventName}`,
        body: reason?.trim()
          ? `Your ${slotRoleLabel(request.role)} request wasn't approved: ${reason.trim()}`
          : `Your ${slotRoleLabel(request.role)} request wasn't approved this time.`,
        link: '/events',
      },
      { uid: actor.uid, name: actor.name },
    );
  } catch (e) {
    console.error('reject notification failed:', e);
  }
}

/**
 * Cancel/withdraw a request. If it was already approved, free the team slot it
 * occupied (transaction) so the seat re-opens.
 */
export async function cancelRequest(request: ShiftRequest): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const reqRef = doc(db, 'shift_requests', request.id);

  if (request.status !== 'approved') {
    await updateDoc(reqRef, { status: 'cancelled', decidedAt: serverTimestamp() });
    return;
  }

  const eventRef = doc(db, 'events', request.eventId);
  await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists()) {
      const event = eventSnap.data() as Event;
      const teams = (event.teams || []).map((t) => ({ ...t }));
      const team = teams.find((t) => t.id === request.teamId);
      if (team) {
        if (team.ftoSlot?.requestId === request.id || team.ftoSlot?.userId === request.userId) {
          team.ftoSlot = {};
        }
        if (
          team.ftoInternSlot?.requestId === request.id ||
          team.ftoInternSlot?.userId === request.userId
        ) {
          team.ftoInternSlot = {};
        }
        team.emtSlots = (team.emtSlots || []).map((s) =>
          s.requestId === request.id || s.userId === request.userId ? {} : s,
        );
        tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
      }
    }
    tx.update(reqRef, { status: 'cancelled', decidedAt: serverTimestamp() });
  });
}

// ---------------------------------------------------------------------------
// Attendance (FTO / manager records member turnout after the event)
// ---------------------------------------------------------------------------

/**
 * Low-level attendance patch on an approved request. This is the MANAGER
 * (admin/quartermaster/medops) retro-edit path — the live FTO flow goes through
 * `checkInMember` / `checkOutMember`, which stamp `now` and derive the snapshots.
 * The UI enforces who may call this (see `getAttendanceAccess` in event-utils).
 *
 * Semantics: `checkedInAt: Date` sets arrival (and clears any exception);
 * `checkedInAt: null` clears arrival. `exception: 'no_show' | 'excused'` sets an
 * exception (and clears arrival/minutesLate); `exception: null` clears it.
 * Passing neither leaves the existing value alone. `shiftEndAt: Date` sets a
 * departure time (used to mark an early departure); `shiftEndAt: null` clears
 * it; omitted, the existing value is preserved (only `endEventShifts` normally
 * sets/clears it otherwise). `leftEarly: true` marks the member as having left
 * before the event's scheduled end; `leftEarly: false` clears it; omitted, the
 * existing value is preserved. Clearing `checkedInAt` or setting an `exception`
 * also clears `leftEarly`/`shiftEndAt` — an absent member can't have left early.
 */
export async function recordAttendance(
  request: ShiftRequest,
  patch: {
    checkedInAt?: Date | null;
    minutesLate?: number;
    exception?: 'no_show' | 'excused' | null;
    notes?: string;
    shiftEndAt?: Date | null;
    leftEarly?: boolean;
    minutesEarly?: number;
  },
  actor: EventActor,
): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  if (!actor?.uid) throw new Error('Actor is required to record attendance');
  if (request.status !== 'approved') {
    throw new Error('Attendance can only be recorded for a confirmed member.');
  }

  const existing = request.attendance;
  let checkedInAt: Date | Timestamp | FieldValue | undefined = existing?.checkedInAt;
  let minutesLate: number | undefined = existing?.minutesLate;
  let exception: AttendanceStatus | undefined = existing?.exception;
  let shiftEndAt: Date | Timestamp | FieldValue | undefined = existing?.shiftEndAt;
  let leftEarly: boolean | undefined = existing?.leftEarly;
  let minutesEarly: number | undefined = existing?.minutesEarly;

  if (patch.checkedInAt !== undefined) {
    if (patch.checkedInAt) {
      checkedInAt = patch.checkedInAt;
      minutesLate = patch.minutesLate;
      exception = undefined; // setting checkedInAt clears any exception
    } else {
      checkedInAt = undefined;
      minutesLate = undefined;
      leftEarly = undefined; // no check-in means "left early" is meaningless
      minutesEarly = undefined;
      shiftEndAt = undefined;
    }
  } else if (patch.minutesLate !== undefined && checkedInAt) {
    minutesLate = patch.minutesLate;
  }

  if (patch.exception !== undefined) {
    if (patch.exception) {
      exception = patch.exception;
      checkedInAt = undefined; // setting an exception clears checkedInAt/minutesLate
      minutesLate = undefined;
      leftEarly = undefined; // an absent member can't have left early
      minutesEarly = undefined;
      shiftEndAt = undefined;
    } else {
      exception = undefined;
    }
  }

  if (patch.shiftEndAt !== undefined) {
    if (patch.shiftEndAt) {
      shiftEndAt = patch.shiftEndAt;
    } else {
      shiftEndAt = undefined;
      leftEarly = undefined; // no departure time ⇒ no early-departure snapshot
      minutesEarly = undefined;
    }
  }

  if (patch.leftEarly !== undefined) {
    leftEarly = patch.leftEarly ? true : undefined;
    if (!patch.leftEarly) minutesEarly = undefined;
  }

  if (patch.minutesEarly !== undefined) {
    minutesEarly = patch.minutesEarly > 0 ? patch.minutesEarly : undefined;
  }

  const notes = patch.notes !== undefined ? (patch.notes.trim() || undefined) : existing?.notes;

  await updateDoc(doc(db, 'shift_requests', request.id), deepRemoveUndefined({
    attendance: {
      checkedInAt,
      shiftEndAt,
      minutesLate,
      exception,
      leftEarly,
      minutesEarly,
      notes,
      recordedBy: actor.uid,
      recordedByName: actor.name,
      recordedAt: serverTimestamp(),
    },
  }));
}

/**
 * Live check-in: arrival IS the moment the button is tapped. Stamps
 * `checkedInAt = now` and the `minutesLate` snapshot against the event's call
 * time. There is deliberately no arrival-time argument — retroactive time
 * changes are a manager-only path through `recordAttendance`.
 */
export async function checkInMember(
  event: Event,
  request: ShiftRequest,
  actor: EventActor,
  now: Date = new Date(),
): Promise<{ minutesLate: number }> {
  const minutesLate = computeMinutesLate(now, eventCallDateTime(event));
  await recordAttendance(request, { checkedInAt: now, minutesLate }, actor);
  return { minutesLate };
}

/**
 * Live check-out: departure IS the moment the button is tapped. Stamps
 * `shiftEndAt = now` and derives the early-departure snapshot from the event's
 * end time — strictly, with no grace window. When the event has no `endTime`,
 * `leftEarly`/`minutesEarly` are left unset (undeterminable), and the shift
 * simply ends.
 */
export async function checkOutMember(
  event: Event,
  request: ShiftRequest,
  actor: EventActor,
  now: Date = new Date(),
): Promise<{ leftEarly: boolean; minutesEarly: number }> {
  if (!request.attendance?.checkedInAt) {
    throw new Error('Check the member in before checking them out.');
  }
  const minutesEarly = computeMinutesEarly(now, eventEndDateTime(event));
  const leftEarly = minutesEarly > 0;
  await recordAttendance(
    request,
    { shiftEndAt: now, leftEarly, minutesEarly: leftEarly ? minutesEarly : undefined },
    actor,
  );
  return { leftEarly, minutesEarly };
}

/**
 * Best-effort: stamp `attendance.shiftEndAt` on every approved request for this
 * event that has checked in but hasn't ended yet. Called both from the manual
 * "End shift" button and automatically when the statpack tied to the event is
 * checked back in. Returns the number of requests updated.
 *
 * `teamIds` scopes the sweep to specific teams — an assigned FTO may only end
 * their OWN team's shifts, while managers (and the statpack auto-end) pass
 * nothing and sweep the whole event.
 */
export async function endEventShifts(
  eventId: string,
  actor: EventActor,
  teamIds?: string[] | null,
): Promise<number> {
  if (!actor?.uid) throw new Error('Actor is required to end shifts');
  const snap = await getDocs(
    query(
      collection(db, 'shift_requests'),
      where('eventId', '==', eventId),
      where('status', '==', 'approved'),
    ),
  );
  const scope = teamIds && teamIds.length > 0 ? new Set(teamIds) : null;
  const targets = snap.docs.filter((d) => {
    const r = d.data() as ShiftRequest;
    if (scope && !scope.has(r.teamId)) return false;
    return !!r.attendance?.checkedInAt && !r.attendance?.shiftEndAt;
  });
  if (targets.length === 0) return 0;

  const batch = writeBatch(db);
  for (const d of targets) {
    batch.update(d.ref, { 'attendance.shiftEndAt': serverTimestamp() });
  }
  await batch.commit();
  return targets.length;
}

export interface MemberShiftStats {
  shiftsAllTime: number;
  shiftsThisSemester: number;
  /** Checked in and not an exception (attended, whether on time or late). */
  checkedIn: number;
  /** Subset of `checkedIn` where minutesLate > 0. */
  lateCount: number;
  /** Sum of minutesLate across all checked-in shifts. */
  totalMinutesLate: number;
  /** Subset of `checkedIn` where attendance.leftEarly is true. */
  leftEarlyCount: number;
  noShow: number;
  excused: number;
  /** Approved shifts still awaiting a check-in or exception. */
  unrecorded: number;
  /** Sum of shiftHours() across all approved requests, all-time. */
  hoursAllTime: number;
  /** Sum of shiftHours() across approved requests since `semesterStart`. */
  hoursThisSemester: number;
}

function toJsDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  const maybe = value as { toDate?: () => Date };
  return typeof maybe.toDate === 'function' ? maybe.toDate() : null;
}

/**
 * Aggregate one member's shift history from their APPROVED requests. Pass every
 * request belonging to the user (approved-only are counted). `semesterStart`
 * comes from `getSemesterStart()` in org-config.
 */
export function getMemberShiftStats(
  requests: ShiftRequest[],
  semesterStart: Date,
): MemberShiftStats {
  const stats: MemberShiftStats = {
    shiftsAllTime: 0,
    shiftsThisSemester: 0,
    checkedIn: 0,
    lateCount: 0,
    totalMinutesLate: 0,
    leftEarlyCount: 0,
    noShow: 0,
    excused: 0,
    unrecorded: 0,
    hoursAllTime: 0,
    hoursThisSemester: 0,
  };
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    stats.shiftsAllTime += 1;
    const d = toJsDate(r.eventDate);
    const inSemester = !!d && d.getTime() >= semesterStart.getTime();
    if (inSemester) stats.shiftsThisSemester += 1;

    const attendance = r.attendance;
    if (attendance?.exception === 'no_show') {
      stats.noShow += 1;
    } else if (attendance?.exception === 'excused') {
      stats.excused += 1;
    } else if (attendance?.checkedInAt) {
      stats.checkedIn += 1;
      const late = attendance.minutesLate ?? 0;
      if (late > 0) {
        stats.lateCount += 1;
        stats.totalMinutesLate += late;
      }
      if (attendance.leftEarly === true) {
        stats.leftEarlyCount += 1;
      }
      const hours = shiftHours(attendance.checkedInAt, attendance.shiftEndAt);
      if (hours != null) {
        stats.hoursAllTime += hours;
        if (inSemester) stats.hoursThisSemester += hours;
      }
    } else {
      stats.unrecorded += 1;
    }
  }
  stats.hoursAllTime = Math.round(stats.hoursAllTime * 10) / 10;
  stats.hoursThisSemester = Math.round(stats.hoursThisSemester * 10) / 10;
  return stats;
}

/** Approved-request userIds for an event (audience = "people signed up"). */
export async function getSignedUpUserIds(eventId: string): Promise<string[]> {
  const snap = await getDocs(
    query(
      collection(db, 'shift_requests'),
      where('eventId', '==', eventId),
      where('status', '==', 'approved'),
    ),
  );
  return Array.from(new Set(snap.docs.map((d) => (d.data() as ShiftRequest).userId).filter(Boolean)));
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export function subscribeEvents(cb: (events: Event[]) => void): () => void {
  const q = query(collection(db, 'events'), orderBy('date', 'asc'));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Event) }))),
    (err) => {
      console.error('events subscription error:', err);
      cb([]);
    },
  );
}

export function subscribeEventRequests(
  eventId: string,
  cb: (requests: ShiftRequest[]) => void,
): () => void {
  const q = query(collection(db, 'shift_requests'), where('eventId', '==', eventId));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }))),
    (err) => {
      console.error('event requests subscription error:', err);
      cb([]);
    },
  );
}

export function subscribeMyRequests(
  userId: string,
  cb: (requests: ShiftRequest[]) => void,
): () => void {
  const q = query(collection(db, 'shift_requests'), where('userId', '==', userId));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }))),
    (err) => {
      console.error('my requests subscription error:', err);
      cb([]);
    },
  );
}

/** All pending requests across events (admin/medops inbox). */
export function subscribePendingRequests(cb: (requests: ShiftRequest[]) => void): () => void {
  const q = query(collection(db, 'shift_requests'), where('status', '==', 'pending'));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }))),
    (err) => {
      console.error('pending requests subscription error:', err);
      cb([]);
    },
  );
}
