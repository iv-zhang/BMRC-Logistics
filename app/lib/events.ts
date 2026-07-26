'use client';

/**
 * Events + shift-staffing operations (`events` and `shift_requests` collections).
 *
 * An event is staffed by one or more TEAMS; each team is exactly one FTO plus
 * `emtCount` EMTs (clamped 2–4, default 3). Members self-request a role on a
 * team (`shift_requests`); a manager (admin/quartermaster/medops) approves,
 * which places them into an open slot on the event's `teams` array.
 *
 * Eligibility: FTO-role members may request FTO or EMT slots; everyone else may
 * request EMT slots only. Signup is additionally gated on valid certifications
 * (see app/lib/certifications.ts).
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
import { shiftHours } from '@/app/components/events/event-utils';

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

/** May a member of `userRole` request `slotRole`? EMT: anyone; FTO: FTO-role or manager. */
export function canRequestRole(userRole: string | null | undefined, slotRole: SlotRole): boolean {
  if (slotRole === 'EMT') return true;
  return userRole === 'FTO' || isEventManagerRole(userRole);
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

export function createEmptyTeam(name: string, emtCount = DEFAULT_EMTS): EventTeam {
  const count = clampEmtCount(emtCount);
  return {
    id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    ftoSlot: emptySlot(),
    emtCount: count,
    emtSlots: Array.from({ length: count }, emptySlot),
  };
}

/** Count of filled slots on a team. */
export function teamFilledCount(team: EventTeam): { fto: number; emt: number } {
  return {
    fto: team.ftoSlot?.userId ? 1 : 0,
    emt: team.emtSlots.filter((s) => s.userId).length,
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
    throw new Error('Only FTOs may request the FTO slot.');
  }
  const team = event.teams.find((t) => t.id === teamId);
  if (!team) throw new Error('Team not found on this event.');

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
        body: `${requester.name} requested ${team.name} · ${role} for ${event.name}`,
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
        body: `${request.teamName} · ${request.role}. See you there!`,
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
          ? `Your ${request.role} request wasn't approved: ${reason.trim()}`
          : `Your ${request.role} request wasn't approved this time.`,
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
 * Patch attendance onto an approved request. Intended caller: the team's FTO or
 * a manager (UI enforces who sees the control).
 *
 * Semantics: `checkedInAt: Date` sets arrival (and clears any exception);
 * `checkedInAt: null` clears arrival. `exception: 'no_show' | 'excused'` sets an
 * exception (and clears arrival/minutesLate); `exception: null` clears it.
 * Passing neither leaves the existing value alone. Any existing `shiftEndAt` is
 * always preserved (only `endEventShifts` sets/clears it).
 */
export async function recordAttendance(
  request: ShiftRequest,
  patch: { checkedInAt?: Date | null; minutesLate?: number; exception?: 'no_show' | 'excused' | null; notes?: string },
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
  const shiftEndAt = existing?.shiftEndAt;

  if (patch.checkedInAt !== undefined) {
    if (patch.checkedInAt) {
      checkedInAt = patch.checkedInAt;
      minutesLate = patch.minutesLate;
      exception = undefined; // setting checkedInAt clears any exception
    } else {
      checkedInAt = undefined;
      minutesLate = undefined;
    }
  } else if (patch.minutesLate !== undefined && checkedInAt) {
    minutesLate = patch.minutesLate;
  }

  if (patch.exception !== undefined) {
    if (patch.exception) {
      exception = patch.exception;
      checkedInAt = undefined; // setting an exception clears checkedInAt/minutesLate
      minutesLate = undefined;
    } else {
      exception = undefined;
    }
  }

  const notes = patch.notes !== undefined ? (patch.notes.trim() || undefined) : existing?.notes;

  await updateDoc(doc(db, 'shift_requests', request.id), deepRemoveUndefined({
    attendance: {
      checkedInAt,
      shiftEndAt,
      minutesLate,
      exception,
      notes,
      recordedBy: actor.uid,
      recordedByName: actor.name,
      recordedAt: serverTimestamp(),
    },
  }));
}

/**
 * Best-effort: stamp `attendance.shiftEndAt` on every approved request for this
 * event that has checked in but hasn't ended yet. Called both from the manual
 * "End shift" button and automatically when the statpack tied to the event is
 * checked back in. Returns the number of requests updated.
 */
export async function endEventShifts(eventId: string, actor: EventActor): Promise<number> {
  if (!actor?.uid) throw new Error('Actor is required to end shifts');
  const snap = await getDocs(
    query(
      collection(db, 'shift_requests'),
      where('eventId', '==', eventId),
      where('status', '==', 'approved'),
    ),
  );
  const targets = snap.docs.filter((d) => {
    const r = d.data() as ShiftRequest;
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
