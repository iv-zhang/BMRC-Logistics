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
  deleteField,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  runTransaction,
  writeBatch,
  serverTimestamp,
  Timestamp,
  arrayUnion,
  type FieldValue,
  type Transaction,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { deepRemoveUndefined } from '@/app/lib/audit';
import { canSignUpForShifts, getShiftBlockReason } from '@/app/lib/certifications';
import { createNotification, broadcastNotification } from '@/app/lib/notifications';
import type {
  Event,
  EventTeam,
  EventStatus,
  EventAccessTier,
  ShiftRequest,
  ShiftRequestStatus,
  SlotRole,
  TeamSlot,
  TierCriteria,
  TierWindow,
  User,
  AttendanceStatus,
  WaitlistOffer,
} from '@/app/types';
import {
  shiftHours,
  eventCallDateTime,
  eventEndDateTime,
  computeMinutesLate,
  computeMinutesEarly,
} from '@/app/components/events/event-utils';
// [Phase 0 / waitlist plan §4.3, §3.8] Used only by `resolveEventPolicy` below
// — no existing function in this file reads org config.
import {
  getOrgConfig,
  getCancellationPolicy,
  getSemesterStart,
  getTerms,
  // [Phase 3 / waitlist plan §6.2, §6.6] The plan's prose calls this getter
  // `getShiftReminders()` and sources it from `@/app/lib/org-config-store`.
  // Neither is right: the raw runtime getter is `getShiftRemindersRuntime`,
  // and every other org-config read in this file (getOrgConfig /
  // getCancellationPolicy / getSemesterStart / getTerms) goes through the
  // `@/app/config/org-config` wrapper rather than the raw runtime layer. This
  // uses the equivalent wrapper to match that convention. Recorded in the
  // plan's §10.4 corrections table so the prose gets fixed rather than
  // re-followed.
  getShiftReminderConfig,
  type OrgConfigDoc,
  type ResolvedEventPolicy,
  type CancellationPolicyConfig,
  type ShiftReminderConfig,
} from '@/app/config/org-config';
// [Phase 2 / waitlist plan §3.7] Tenure math (fail-closed on missing
// `joinedOn`) lives in its own leaf module — see that file's header for why
// it must not import from here.
import { tenureDays, completedTermsSince } from '@/app/lib/tenure';

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
  /**
   * [Phase 2 / waitlist plan §2.2, §3.7, T7] Staged-release tier config. Every
   * `Timestamp` inside it (`generalOpensAt`, each `tiers[].opensAt`) must
   * already be a real `Timestamp` (e.g. `Timestamp.fromDate(...)`) by the
   * time it reaches here — NEVER a `serverTimestamp()` sentinel, which
   * Firestore rejects inside an array element (`tiers` is an array); that was
   * bug D12 in this build. `deepRemoveUndefined` (app/lib/audit.ts) preserves
   * `Timestamp` instances as-is at any nesting depth, including inside
   * `tiers[]`, so passing real Timestamps through is safe.
   */
  accessTier?: EventAccessTier;
  /** [Phase 2 / waitlist plan §2.2, T7] Per-event waitlist kill switch. Absent = ON — see the field's doc comment on `Event` (app/types.ts) for why the default polarity is inverted from `hasFtoIntern`. */
  waitlistEnabled?: boolean;
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
    accessTier: input.accessTier ?? undefined,
    waitlistEnabled: input.waitlistEnabled ?? undefined,
    notified: false,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return addDoc(collection(db, 'events'), payload);
}

/**
 * Patch event fields. Pass `date` as a Date; it is converted to a Timestamp.
 *
 * [Phase 1 / waitlist plan §2.1 propagation obligation, decision 2] When
 * `date`, `callTime`, or `teams` change — the only inputs
 * `getShiftStartInstant` reads — every non-terminal (`pending`/`waitlisted`/
 * `offered`/`approved`) request for this event gets its denormalized
 * `shiftStartAt` re-stamped in one batch, same obligation the location model
 * carries for zone renames. A non-empty `callTime` also clears
 * `needsCallTime` (the flag `flagEventNeedsCallTime` sets when promotion was
 * refused on a legacy event with none). Both are best-effort AFTER the event
 * save itself commits: a propagation failure must never fail the edit, but
 * it is logged loudly since a stale `shiftStartAt` would silently mislead the
 * cancellation policy and the external sweep worker.
 */
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
  if (patch.callTime !== undefined) {
    const callTime = patch.callTime || null;
    update.callTime = callTime;
    if (callTime) update.needsCallTime = false;
  }
  if (patch.endTime !== undefined) update.endTime = patch.endTime || null;
  if (patch.description !== undefined) update.description = patch.description.trim() || null;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.teams !== undefined) update.teams = patch.teams;
  if (patch.notified !== undefined) update.notified = patch.notified;
  // [Phase 2 / waitlist plan §2.2, §3.7, T7] `accessTier`/`waitlistEnabled`
  // pass through as-is (this function builds `update` by hand rather than
  // via `deepRemoveUndefined`, same as every other field here — the
  // `!== undefined` guard is what keeps an omitted key from clobbering the
  // stored value). Real `Timestamp` instances nested inside `tiers[]` are
  // fine for `updateDoc`; only a bare `serverTimestamp()` sentinel would be
  // rejected inside an array element — see `CreateEventInput.accessTier`'s
  // doc comment (that was bug D12). The caller (event-editor-modal.tsx) is
  // responsible for converting picked dates to real Timestamps before this
  // is called.
  if (patch.accessTier !== undefined) update.accessTier = patch.accessTier;
  if (patch.waitlistEnabled !== undefined) update.waitlistEnabled = patch.waitlistEnabled;
  await updateDoc(doc(db, 'events', eventId), update);

  if (patch.date !== undefined || patch.callTime !== undefined || patch.teams !== undefined) {
    try {
      const eventSnap = await getDoc(doc(db, 'events', eventId));
      if (eventSnap.exists()) {
        const freshEvent = { id: eventSnap.id, ...(eventSnap.data() as Event) };
        const reqsSnap = await getDocs(
          query(
            collection(db, 'shift_requests'),
            where('eventId', '==', eventId),
            where('status', 'in', ['pending', 'waitlisted', 'offered', 'approved']),
          ),
        );
        if (!reqsSnap.empty) {
          const batch = writeBatch(db);
          for (const d of reqsSnap.docs) {
            const r = d.data() as ShiftRequest;
            const team = freshEvent.teams.find((t) => t.id === r.teamId);
            const shiftStart = getShiftStartInstant(freshEvent, team);
            batch.update(
              d.ref,
              shiftStart ? { shiftStartAt: Timestamp.fromDate(shiftStart) } : { shiftStartAt: deleteField() },
            );
          }
          await batch.commit();
        }
      }
    } catch (e) {
      console.error('updateEvent: shiftStartAt propagation failed:', e);
    }
  }
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

/**
 * [Phase 2 / waitlist plan §3.7] The minimal member shape tier criteria are
 * evaluated against. `User` satisfies this structurally; `ShiftRequester`
 * below is widened to extend it so the lib-side enforcement path
 * (`requestShift`/`joinWaitlist`) can evaluate tier criteria against the same
 * projection it already has in hand, with no extra fetch of the full `User`
 * doc on the common (untiered-event) path.
 */
export interface TierSubject {
  role?: string | null;
  memberStatus?: User['memberStatus'];
  joinedOn?: User['joinedOn'];
  isCommitteeMember?: boolean;
}

/**
 * [Phase 2 / waitlist plan §3.7 — DEFECT FOUND IN THIS PHASE] §3.7 specifies
 * `meetsTierCriteria`/`getTierAccess` evaluated against a full `User`, but the
 * only caller inside the lib enforcement path (`requestShift`) has ONLY ever
 * received this `ShiftRequester` projection — which, before this phase,
 * carried neither `joinedOn` nor `isCommitteeMember`. Left unwidened, EVERY
 * `minTenureDays`/`minSemesters`/`requireCommitteeMember` criterion would have
 * evaluated against `undefined` and failed closed for every member — a
 * silent, total lockout on any tiered event using those criteria, and it
 * would have typechecked cleanly since nothing in `requestShift` was ever
 * declared to need these fields. Extending `TierSubject` here (and populating
 * `joinedOn`/`isCommitteeMember` at every call site that builds a
 * `ShiftRequester`) is the fix; see plan §10.3 for the discovery log entry.
 */
export interface ShiftRequester extends TierSubject {
  uid: string;
  name: string;
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

export interface RequestShiftOptions {
  note?: string;
  /**
   * The member's soft team preference for a queue entry — see
   * `ShiftRequest.preferredTeamId`. Defaults to the `teamId` the member
   * actually pressed (the team-card they were looking at) when omitted, so a
   * plain "request this team's slot" click that overflows into the waitlist
   * still records a sensible preference with zero extra UI.
   */
  preferredTeamId?: string;
}

/**
 * [Phase 2 / waitlist plan §3.7, T5] One-time fetch of a member's own
 * approved-shift history, for the tier-eligibility check inside
 * `requestShift`. Only ever called when `event.accessTier?.enabled` is
 * truthy — see that call site; every other signup path pays zero extra
 * reads for tiering.
 */
async function getRequesterShiftStats(uid: string): Promise<MemberShiftStats> {
  const snap = await getDocs(query(collection(db, 'shift_requests'), where('userId', '==', uid)));
  const reqs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }));
  return getMemberShiftStats(reqs, getSemesterStart());
}

/**
 * Create a member's request for a role on a team. Enforces: event open, cert
 * validity, role eligibility, and no duplicate active request for this event.
 *
 * [Phase 1 / waitlist plan §3.2, §3.8, P13] Branches to a `waitlisted` queue
 * entry when no slot for `role` is open ANYWHERE on the event (not just on
 * `teamId`) — the queue is event-scoped by default (`policy.scope ===
 * 'event'`), so "full" means the whole event, not the one team the member
 * happened to click. "Open" excludes a slot with a live `heldUntil` (an
 * outstanding offer) — see `isSlotHeld`. The `pending` (direct-signup) branch
 * is otherwise unchanged: it still attaches to the exact `teamId` requested,
 * even if some other team on the event has room, matching the pre-Phase-1
 * behavior where `approveRequest`'s own transaction is what actually enforces
 * capacity.
 */
export async function requestShift(
  event: Event,
  teamId: string,
  role: SlotRole,
  requester: ShiftRequester,
  opts?: RequestShiftOptions,
): Promise<void> {
  if (event.status !== 'open') throw new Error('This event is not open for signups.');
  // [Phase 2 / waitlist plan §3.7, §5.3] Tier gate is the COARSEST guard —
  // checked before certs/role, same ordering the UI uses, so a member who
  // isn't in-window yet sees the real reason instead of an unrelated cert
  // error. Skip the stats query entirely when the event isn't tiered (the
  // overwhelmingly common case) so untiered events pay nothing extra.
  // Managers bypass via `getTierAccess`'s own manager branch, so no special
  // case is needed here.
  if (event.accessTier?.enabled) {
    const stats = await getRequesterShiftStats(requester.uid);
    const access = getTierAccess(event, requester, stats);
    if (!access.eligible) {
      // Not `access.reason` — that is the author's rationale and names no date.
      // §5.3: every blocked state names a date. See `describeTierBlock`.
      throw new Error(describeTierBlock(access, event));
    }
  }
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
  // [Phase 0 / waitlist plan §2.1] Widened beyond pending/approved: an open
  // waitlisted or offered entry is also "active" and must block a duplicate
  // request for the same event. Per-event queue key means one active request
  // per (eventId, userId) regardless of team is exactly right here.
  const hasActive = existing.docs.some((d) => {
    const s = (d.data() as ShiftRequest).status;
    return s === 'pending' || s === 'approved' || s === 'waitlisted' || s === 'offered';
  });
  if (hasActive) throw new Error('You already have an active request for this event.');

  const policy = resolveEventPolicy(event);
  const now = new Date();
  const openSomewhere = hasOpenSlotForRoleOnEvent(event, role, now);

  if (!openSomewhere && !policy.waitlistEnabled) {
    // [Phase 1 / waitlist plan §3.8] Waitlisting is off org/event-wide and
    // nothing is open — this is a hard "full", not a queueable state.
    throw new Error(`${role === 'FTO' ? 'The FTO' : role === 'FTO_INTERN' ? 'The FTO intern' : 'Every EMT'} slot is full for this event.`);
  }

  if (!openSomewhere) {
    // [Phase 1] Under the default event-scoped queue the member has no team
    // yet, so `shiftStartAt` can only be the event-level approximation (see
    // `WaitlistOffer.shiftStartAt`'s doc comment for why this must never be
    // treated as the real per-team instant). Under the legacy `scope: 'team'`
    // opt-in the team IS known (it's the real queue key), so use it.
    const queueTeam = policy.scope === 'team' ? team : undefined;
    const queueShiftStart = getShiftStartInstant(event, queueTeam);

    // [Phase 1 / waitlist plan §4.1] Queue-entry guards. Both read config,
    // never block a member simply asking to be placed on hold — they throw a
    // member-readable reason instead.
    if (!policy.allowQueueAfterShiftStart && queueShiftStart && queueShiftStart.getTime() <= now.getTime()) {
      throw new Error('This shift has already started — joining the waitlist is disabled for it.');
    }
    if (policy.maxQueueLength > 0) {
      const queueScopeConstraints = [
        where('eventId', '==', event.id),
        where('role', '==', role),
        where('status', '==', 'waitlisted'),
      ];
      if (policy.scope === 'team') queueScopeConstraints.push(where('teamId', '==', teamId));
      const queueSnap = await getDocs(query(collection(db, 'shift_requests'), ...queueScopeConstraints));
      if (queueSnap.size >= policy.maxQueueLength) {
        throw new Error(`The waitlist for this role is full (max ${policy.maxQueueLength}).`);
      }
    }

    const payload = deepRemoveUndefined({
      eventId: event.id,
      eventName: event.name,
      eventDate: event.date,
      // [P13] Event-scoped queue: unassigned until an offer picks a team.
      // Under the legacy `scope: 'team'` opt-in, the real team is kept.
      teamId: policy.scope === 'team' ? teamId : '',
      teamName: policy.scope === 'team' ? team.name : '',
      role,
      userId: requester.uid,
      userName: requester.name,
      memberStatus: requester.memberStatus || 'general',
      joinedTerm: requester.joinedTerm || undefined,
      status: 'waitlisted' as const,
      note: opts?.note?.trim() || undefined,
      requestedAt: serverTimestamp(),
      waitlistedAt: serverTimestamp(),
      preferredTeamId: opts?.preferredTeamId || teamId,
      commitmentBinding: false,
      shiftStartAt: queueShiftStart ? Timestamp.fromDate(queueShiftStart) : undefined,
      eventType: event.eventType || undefined,
    });
    await addDoc(collection(db, 'shift_requests'), payload);
    return;
  }

  const pendingShiftStart = getShiftStartInstant(event, team);
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
    note: opts?.note?.trim() || undefined,
    requestedAt: serverTimestamp(),
    commitmentBinding: false,
    shiftStartAt: pendingShiftStart ? Timestamp.fromDate(pendingShiftStart) : undefined,
    eventType: event.eventType || undefined,
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
 * [Phase 1 / waitlist plan §3.8] Thin, intention-revealing wrapper over
 * `requestShift`'s waitlist branch — for a "Join waitlist" button the UI only
 * shows once it already knows the role is full on this event. Delegates
 * entirely to `requestShift`'s own openness check rather than forcing a queue
 * entry: if a slot actually IS open (e.g. a race with another member's
 * cancellation), the member is placed directly instead of needlessly queued.
 * `teamId` is not a parameter here (the queue is event-scoped, P13) — an
 * `opts.preferredTeamId` anchors the request to a specific team for
 * validation/notification purposes and is what ends up recorded as the
 * member's preference; without one, the event's first team is used as that
 * anchor only (never written to the queue entry itself under the default
 * event-scoped mode).
 */
export async function joinWaitlist(
  event: Event,
  role: SlotRole,
  requester: ShiftRequester,
  opts?: RequestShiftOptions,
): Promise<void> {
  const anchorTeamId = opts?.preferredTeamId ?? event.teams[0]?.id;
  if (!anchorTeamId) throw new Error('This event has no teams configured.');
  return requestShift(event, anchorTeamId, role, requester, opts);
}

/**
 * [Phase 1 / waitlist plan §3.2] `waitlisted -> cancelled`. Zero side
 * effects, zero penalty, no slot interaction (a waitlisted entry never held
 * one), and — deliberately — no promotion trigger. This is NOT a no-show
 * surface; a member leaving a queue costs them nothing. Refuses anything
 * that isn't currently `waitlisted` (an `offered` member should decline via
 * `declineOffer`, not this — the semantics differ: an offer is a live
 * proposal with a countdown, a plain queue entry is not).
 */
export async function leaveWaitlist(request: ShiftRequest, actor: EventActor): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  if (request.status !== 'waitlisted') {
    throw new Error('This request is not currently on the waitlist.');
  }
  await updateDoc(doc(db, 'shift_requests', request.id), {
    status: 'cancelled',
    decidedBy: actor.uid,
    decidedByName: actor.name,
    decidedAt: serverTimestamp(),
  });
}

/**
 * Approve a request: place the member into an open slot on the team and stamp
 * the request. Runs in a transaction against the event doc so slot capacity
 * (1 FTO / emtCount EMTs) can't be oversubscribed by concurrent approvals.
 *
 * [Phase 1 / waitlist plan §3.5, §3.8] Direct placement is always binding
 * (`commitmentBinding: true`), regardless of role — this is a manager
 * bypassing the queue/offer machinery entirely, not an offer acceptance.
 * Also refuses a slot with a live soft-hold (`heldUntil` in the future) from
 * an outstanding `WaitlistOffer` rather than silently clobbering it — see
 * `resolveSlotRef`'s FTO/FTO_INTERN branch below for the single-slot case
 * this actually applies to.
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

    const slotValue: TeamSlot = { userId: request.userId, userName: request.userName, requestId: request.id };
    let placed: string;

    if (request.role === 'FTO' || request.role === 'FTO_INTERN') {
      const ref = resolveSlotRef(team, request.role);
      if (!ref) throw new Error('This team does not have an FTO intern slot.');
      if (ref.slot.userId && ref.slot.userId !== request.userId) {
        throw new Error(
          request.role === 'FTO'
            ? 'The FTO slot on this team is already filled.'
            : 'The FTO intern slot on this team is already filled.',
        );
      }
      // A live soft-hold from an outstanding offer to SOMEONE ELSE blocks a
      // direct placement into the same slot — the manager must wait for it
      // to resolve or use the explicit force-promote override, never a
      // silent clobber that orphans the offeree's pending promise (§3.5).
      if (isSlotHeld(ref.slot) && ref.slot.requestId !== request.id) {
        let holderName = 'another member';
        if (ref.slot.requestId) {
          const offerSnap = await tx.get(doc(db, 'shift_requests', ref.slot.requestId));
          if (offerSnap.exists()) holderName = (offerSnap.data() as ShiftRequest).userName || holderName;
        }
        const expiresAt = toJsDate(ref.slot.heldUntil);
        throw new Error(
          `This slot has a pending offer to ${holderName}, expiring ${
            expiresAt ? expiresAt.toLocaleString() : 'soon'
          } — wait or force-promote instead.`,
        );
      }
      ref.assign(slotValue);
      placed = ref.kind === 'fto' ? 'fto' : 'intern';
    } else {
      // EMT: `resolveSlotRef` already skips filled AND live-held slots when
      // choosing an index, so `null` here genuinely means no seat is
      // available (full, or every remaining seat is held by an offer).
      const ref = resolveSlotRef(team, request.role);
      if (!ref) {
        throw new Error('All EMT slots on this team are full or have a pending offer — wait or force-promote instead.');
      }
      ref.assign(slotValue);
      placed = `emt:${ref.index}`;
    }

    tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
    tx.update(reqRef, {
      status: 'approved',
      assignedSlot: placed,
      commitmentBinding: true,
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
 * Cancel/withdraw a request. `actor` is required (Phase 1 — cancellations are
 * now attributable, since a late one can be flagged against the member).
 *
 * What each status actually does now:
 * - `pending` / `waitlisted`: plain status write. Neither ever held a slot,
 *   so there's nothing to free and no promotion to trigger. The
 *   cancellation policy is deliberately NOT evaluated for these — see the
 *   note below.
 * - `offered`: releases the soft hold on whatever slot the offer had (if
 *   any — it may have already expired), marks the request `cancelled`, then
 *   rolls the queue forward via `promoteNextFromWaitlist`.
 * - `approved`: frees the `TeamSlot` it occupied, marks `cancelled`, then
 *   rolls the queue forward the same way.
 * - anything already terminal (`rejected`/`cancelled`/`declined`/`expired`):
 *   idempotent plain write, matching the permissive behavior this function
 *   has always had.
 *
 * The cancellation policy (§3.4 — `lateCancellation`/`lateCancellationHours`
 * stamping, and `mode: 'block'`'s throw) is evaluated ONLY for `offered` and
 * `approved`, never for `pending`/`waitlisted`: a queue entry never held a
 * real commitment, so there is nothing to be "late" about, and blocking a
 * pending/waitlisted withdrawal would directly contradict `leaveWaitlist`'s
 * documented zero-cost guarantee. This is a plan ambiguity resolved here —
 * §3.4's implementation paragraph doesn't scope `appliesTo` by status, but
 * "every confirmed shift" (its own description of the `'all'` mode) reads as
 * "every approved/offered seat," not "every cancellation of any kind."
 *
 * `event` lets a caller that already has it loaded (the events board, the
 * detail drawer) skip a read; when omitted this fetches it. If the event doc
 * is missing entirely (deleted), this NEVER blocks the cancel — it falls
 * back to org-default policy and simply skips the promotion step (there is
 * no event left to promote against).
 */
export async function cancelRequest(
  request: ShiftRequest,
  actor: EventActor,
  event?: Event,
): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const reqRef = doc(db, 'shift_requests', request.id);

  let liveEvent: Event | null = event ?? null;
  if (!liveEvent) {
    const eventSnap = await getDoc(doc(db, 'events', request.eventId));
    liveEvent = eventSnap.exists() ? ({ id: eventSnap.id, ...(eventSnap.data() as Event) }) : null;
  }
  const policy = resolveEventPolicy(liveEvent ?? syntheticEventForPolicy(request.eventId));

  if (request.status === 'pending' || request.status === 'waitlisted') {
    await updateDoc(reqRef, { status: 'cancelled', decidedBy: actor.uid, decidedByName: actor.name, decidedAt: serverTimestamp() });
    return;
  }

  if (request.status === 'offered') {
    const { blocked, stampLate, noticeHours } = evaluateLateCancellation(request, policy.cancellation);
    if (blocked) {
      throw new Error(
        `Cancellations within ${noticeHours} hours of this shift aren't allowed — contact a manager.`,
      );
    }
    let liveEventFresh: Event | null = null;
    await runTransaction(db, async (tx) => {
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists()) throw new Error('Request no longer exists.');
      const freshReq = { id: reqSnap.id, ...(reqSnap.data() as ShiftRequest) };
      if (freshReq.status === 'offered') {
        liveEventFresh = await releaseOfferHoldInTx(tx, freshReq);
      }
      tx.update(
        reqRef,
        deepRemoveUndefined({
          status: 'cancelled',
          decidedBy: actor.uid,
          decidedByName: actor.name,
          decidedAt: serverTimestamp(),
          lateCancellation: stampLate || undefined,
          lateCancellationHours: stampLate ? noticeHours : undefined,
        }),
      );
    });
    if (liveEventFresh) await promoteNextFromWaitlist(liveEventFresh, request.teamId, request.role, actor);
    return;
  }

  if (request.status === 'approved') {
    const { blocked, stampLate, noticeHours } = evaluateLateCancellation(request, policy.cancellation);
    if (blocked) {
      throw new Error(
        `Cancellations within ${noticeHours} hours of this shift aren't allowed — contact a manager.`,
      );
    }
    let liveEventFresh: Event | null = null;
    await runTransaction(db, async (tx) => {
      const eventRef = doc(db, 'events', request.eventId);
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists()) {
        const ev = eventSnap.data() as Event;
        const teams = (ev.teams || []).map((t) => ({ ...t }));
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
        liveEventFresh = { id: eventSnap.id, ...ev };
      }
      tx.update(
        reqRef,
        deepRemoveUndefined({
          status: 'cancelled',
          decidedBy: actor.uid,
          decidedByName: actor.name,
          decidedAt: serverTimestamp(),
          lateCancellation: stampLate || undefined,
          lateCancellationHours: stampLate ? noticeHours : undefined,
        }),
      );
    });
    if (liveEventFresh) await promoteNextFromWaitlist(liveEventFresh, request.teamId, request.role, actor);
    return;
  }

  // Already terminal (rejected/cancelled/declined/expired) — idempotent
  // plain write, matching this function's pre-existing permissive behavior.
  await updateDoc(reqRef, { status: 'cancelled', decidedBy: actor.uid, decidedByName: actor.name, decidedAt: serverTimestamp() });
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
  // [Phase 0 / waitlist plan §2.1] Already correct as a plain `!== 'approved'`
  // guard — attendance only ever applies to a seat someone actually holds;
  // none of the new waitlist statuses (`waitlisted`/`offered`/`declined`/
  // `expired`) ever have a shift to check into. Leave as-is.
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
  // [Phase 0 / waitlist plan §2.1] Correct as-is — only an approved seat has
  // a shift to end; waitlisted/offered/declined/expired requests were never
  // checked in and have no `attendance.shiftEndAt` to stamp.
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
  /**
   * [Phase 1 / waitlist plan §3.4] No-shows against a short-notice-offer
   * acceptance (`commitmentBinding === false`) — informational only. NEVER
   * summed into `noShow` on any surface; a manager scanning for reliability
   * problems must not see a free short-notice pickup inflate someone's
   * no-show count (P4).
   */
  noShowNonBinding: number;
  /**
   * [Phase 1 / waitlist plan §3.4] Count of `cancelled` requests carrying
   * `lateCancellation === true`, gated on the ORG-WIDE
   * `cancellationPolicy.countsAgainstRecord` (`getCancellationPolicy()`) —
   * this function has no event in hand, so a per-event policy override on
   * this one flag can't be honoured here. Known limitation, not a bug.
   */
  lateCancellations: number;
  /** [Phase 1 / waitlist plan §3.4, Q4] Approved shifts by `eventType`. A request with no denormalized `eventType` counts toward `shiftsAllTime` but lands in no bucket. */
  shiftsByType: Record<string, number>;
  /** Same as `shiftsByType`, scoped to the current term. */
  shiftsByTypeSemester: Record<string, number>;
  /** [Phase 3 / §5.5] `status === 'waitlisted'` entries. NEVER summed into `shiftsAllTime`. */
  waitlistPending: number;
  /** [Phase 3 / §5.5] Live outstanding offers — `status === 'offered'` that `resolveOfferState` still calls `'offered'`. */
  offersOutstanding: number;
  /** [Phase 3 / §5.5] `status === 'declined'`. Neutral: P4 makes every non-accepted offer non-binding. */
  offersDeclined: number;
  /** [Phase 3 / §5.5] `status === 'expired'`, plus `offered` docs past `respondBy` that no sweep has rewritten yet. */
  offersExpired: number;
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
  // [Phase 3 / §5.5] Captured once — used only by the waitlist/offer counting
  // pass below (via `resolveOfferState`) so an `offered` doc past its
  // `respondBy` with no sweep yet still counts as expired. Not threaded into
  // the exported signature — several call sites (incl. app/lib/stats/staffing.ts)
  // depend on the existing two-argument shape.
  const now = new Date();
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
    noShowNonBinding: 0,
    lateCancellations: 0,
    shiftsByType: {},
    shiftsByTypeSemester: {},
    waitlistPending: 0,
    offersOutstanding: 0,
    offersDeclined: 0,
    offersExpired: 0,
  };
  for (const r of requests) {
    // [Phase 0 / waitlist plan §2.1] Already correct — new statuses are
    // excluded by construction, no change needed. Leave as a plain filter;
    // the §3.4 `noShowNonBinding`/`lateCancellations` counters get added
    // BESIDE this loop, not folded into this condition.
    if (r.status !== 'approved') continue;
    stats.shiftsAllTime += 1;
    const d = toJsDate(r.eventDate);
    const inSemester = !!d && d.getTime() >= semesterStart.getTime();
    if (inSemester) stats.shiftsThisSemester += 1;

    // [Phase 1 / waitlist plan §3.4, Q4] Never synthesize an 'other' bucket
    // for a request with no `eventType` — that would silently satisfy a
    // `minShiftsByType` tier criterion nobody actually met.
    if (r.eventType) {
      stats.shiftsByType[r.eventType] = (stats.shiftsByType[r.eventType] || 0) + 1;
      if (inSemester) {
        stats.shiftsByTypeSemester[r.eventType] = (stats.shiftsByTypeSemester[r.eventType] || 0) + 1;
      }
    }

    const attendance = r.attendance;
    if (attendance?.exception === 'no_show') {
      // [Phase 1 / waitlist plan §3.4] Split on whether this specific request
      // actually carried no-show liability — see `isCommitmentBinding` for
      // the legacy-undefined default this leans on.
      if (isCommitmentBinding(r)) stats.noShow += 1;
      else stats.noShowNonBinding += 1;
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

  // [Phase 1 / waitlist plan §3.4] Second pass, over the SAME flat list but
  // NOT gated on `status === 'approved'` — a late cancellation is stamped on
  // a `cancelled` doc, which the main loop above always `continue`s past.
  // Reads the org-wide policy (no event join available here); see the field
  // doc comment on `MemberShiftStats.lateCancellations`.
  if (getCancellationPolicy().countsAgainstRecord) {
    for (const r of requests) {
      if (r.status === 'cancelled' && r.lateCancellation === true) {
        stats.lateCancellations += 1;
      }
    }
  }

  // [Phase 3 / §5.5] Third pass, same flat list, same "NOT gated on
  // status === 'approved'" shape as the `lateCancellations` pass above —
  // waitlist/offer states are never `approved`, so the main loop always
  // `continue`s past them. `offersExpired` also catches a still-`offered` doc
  // whose `respondBy` has passed but which no lazy sweep has rewritten yet
  // (`resolveOfferState`) — that offer is expired in fact, and counting it as
  // outstanding would be wrong.
  for (const r of requests) {
    if (r.status === 'waitlisted') {
      stats.waitlistPending += 1;
    } else if (r.status === 'offered') {
      if (resolveOfferState(r, now) === 'expired') stats.offersExpired += 1;
      else stats.offersOutstanding += 1;
    } else if (r.status === 'declined') {
      stats.offersDeclined += 1;
    } else if (r.status === 'expired') {
      stats.offersExpired += 1;
    }
  }

  return stats;
}

/**
 * [Phase 2 / waitlist plan §3.7] A zeroed `MemberShiftStats` for callers that
 * have no history loaded yet (e.g. a signup-eligibility check on an untiered
 * event that never needs to query `shift_requests`). Deep-frozen, not merely
 * `Object.freeze`d at the top level: freezing only the outer object would
 * stop `EMPTY_SHIFT_STATS.shiftsAllTime = 1` but NOT
 * `EMPTY_SHIFT_STATS.shiftsByType.football = 1` — the nested record would
 * still be a live, shared, mutable object every caller of this constant
 * points at, which is exactly the shape of bug D6 in this build (a resolver
 * that silently resized a caller's live data through a shared reference).
 * Freezing the nested `shiftsByType`/`shiftsByTypeSemester` records too turns
 * that mistake into a thrown `TypeError` instead of silent cross-caller
 * corruption.
 */
export const EMPTY_SHIFT_STATS: MemberShiftStats = Object.freeze({
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
  noShowNonBinding: 0,
  lateCancellations: 0,
  shiftsByType: Object.freeze({}),
  shiftsByTypeSemester: Object.freeze({}),
  waitlistPending: 0,
  offersOutstanding: 0,
  offersDeclined: 0,
  offersExpired: 0,
}) as MemberShiftStats;

/**
 * [Phase 2 / waitlist plan §3.7] `TierAccess.phase`: `'closed'` = not yet
 * eligible for any window and general access hasn't opened; `'priority'` =
 * eligible now via a matched `TierWindow`, or matched-but-not-open-yet (see
 * `eligible`); `'general'` = untiered, general access open, or a manager
 * bypass.
 */
export interface TierAccess {
  phase: 'closed' | 'priority' | 'general';
  eligible: boolean;
  /** The instant THIS member can sign up. Drives "you can sign up from Oct 3" copy. */
  opensForYouAt: Date | null;
  /** Which window granted it, for the badge label. */
  matchedTier: TierWindow | null;
  reason: string;
}

/**
 * [Phase 2 / waitlist plan §3.7] Exactly the plan's reference implementation,
 * with the bindings the plan pins:
 *   - `roles`            -> `subject?.role`
 *   - `minCompletedShifts` -> `stats.shiftsAllTime`
 *   - `minShiftsByType`  -> `stats.shiftsByType?.[type] ?? 0`, per entry
 *   - `minTenureDays`    -> `tenureDays(subject?.joinedOn, now)` (tenure.ts;
 *     already returns -1 when absent, so this fails closed for free)
 *   - `minSemesters`     -> `completedTermsSince(subject?.joinedOn, now, getTerms())`
 *   - `requireCommitteeMember` -> `subject?.isCommitteeMember === true`
 * `{}` (no criteria specified) -> `true` ("anyone, once the window opens"). A
 * `null` subject fails every SPECIFIED criterion (fail-closed on every `?.`
 * above reading `undefined`) but still returns `true` for `{}` — a pure
 * timing tier has no eligibility filter to fail.
 */
export function meetsTierCriteria(
  c: TierCriteria,
  subject: TierSubject | null,
  stats: MemberShiftStats,
  now: Date,
): boolean {
  const checks: boolean[] = [];
  if (c.roles?.length) checks.push(!!subject?.role && c.roles.includes(subject?.role as User['role']));
  if (c.memberStatus?.length) checks.push(c.memberStatus.includes(subject?.memberStatus ?? 'general'));
  if (c.minCompletedShifts != null) checks.push(stats.shiftsAllTime >= c.minCompletedShifts);
  if (c.minShiftsByType) {
    for (const [type, min] of Object.entries(c.minShiftsByType)) {
      checks.push((stats.shiftsByType?.[type] ?? 0) >= min);
    }
  }
  if (c.minTenureDays != null) checks.push(tenureDays(subject?.joinedOn, now) >= c.minTenureDays);
  if (c.minSemesters != null) {
    checks.push(completedTermsSince(subject?.joinedOn, now, getTerms()) >= c.minSemesters);
  }
  if (c.requireCommitteeMember) checks.push(subject?.isCommitteeMember === true);

  if (checks.length === 0) return true; // {} = anyone, once the window opens
  return c.combine === 'any' ? checks.some(Boolean) : checks.every(Boolean);
}

/**
 * [Phase 2 / waitlist plan §3.7] A member's access opens at the EARLIEST
 * `opensAt` among the windows whose criteria they satisfy, falling back to
 * `generalOpensAt`. `now` defaults to `new Date()` (a param, not a hardcoded
 * call, so callers/tests can pin it). Manager bypass: `isEventManagerRole`
 * always reads as general/eligible with no window — event managers are never
 * gated by their own tier config.
 */
export function getTierAccess(
  event: Event,
  subject: TierSubject | null,
  stats: MemberShiftStats,
  now: Date = new Date(),
): TierAccess {
  const tier = event.accessTier;
  if (!tier?.enabled) {
    return { phase: 'general', eligible: true, opensForYouAt: null, matchedTier: null, reason: '' };
  }
  if (isEventManagerRole(subject?.role)) {
    return { phase: 'general', eligible: true, opensForYouAt: null, matchedTier: null, reason: 'Manager override.' };
  }

  const general = toJsDate(tier.generalOpensAt);
  if (general && now.getTime() >= general.getTime()) {
    return { phase: 'general', eligible: true, opensForYouAt: general, matchedTier: null, reason: '' };
  }

  // Earliest window this member qualifies for. A window with an unparseable
  // `opensAt` is skipped (never crashes the sort) — `toJsDate` returning
  // `null` for it means it can never win the ascending sort below, so
  // filtering it out first is just avoiding a `null` in the comparator.
  const matches = (tier.tiers ?? [])
    .filter((w) => toJsDate(w.opensAt) !== null && meetsTierCriteria(w.criteria, subject, stats, now))
    .sort((a, b) => toJsDate(a.opensAt)!.getTime() - toJsDate(b.opensAt)!.getTime());
  const mine = matches[0] ?? null;
  const opensForYouAt = mine ? toJsDate(mine.opensAt) : general;

  if (mine && opensForYouAt && now.getTime() >= opensForYouAt.getTime()) {
    return { phase: 'priority', eligible: true, opensForYouAt, matchedTier: mine, reason: '' };
  }

  return {
    phase: mine ? 'priority' : 'closed',
    eligible: false,
    opensForYouAt,
    matchedTier: mine,
    reason: tier.rationale || 'Signups are not open to you yet.',
  };
}

/** Compact inline date form for tier copy — "Oct 3". Deliberately not the long
 *  weekday/year form `formatEventDate` uses, which is overkill for a one-line
 *  reason (waitlist plan §5.3). */
function formatTierDate(d: Date | null): string {
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

/**
 * [Phase 2 / waitlist plan §5.3] The single member-facing sentence for a
 * blocked `TierAccess`, shared by the disabled signup control and by the
 * error `requestShift` throws.
 *
 * It lives here rather than in `team-card.tsx` because the two must not drift:
 * §5.3's rule is that EVERY blocked state names a date ("you're not eligible"
 * is a dead end; "you can sign up from Oct 8" is an instruction), and the lib
 * was throwing `TierAccess.reason` — which is the AUTHOR'S rationale text and
 * names no date at all. A member who reaches the thrown error (a stale tab, a
 * window that closed between render and press) got strictly less information
 * than one who never pressed the button.
 *
 * The `matchedTier`-less `'priority'` branch is defensive: `getTierAccess`
 * only reports `phase: 'priority'` when a window actually matched, so that
 * combination is unreachable today — see §10.3 D16, which records that plan
 * §5.3's button table lists it as a distinct row.
 */
export function describeTierBlock(access: TierAccess, event: Event): string {
  const general = toJsDate(event.accessTier?.generalOpensAt);
  if (access.phase === 'closed') {
    return access.opensForYouAt
      ? `Signup opens ${formatTierDate(access.opensForYouAt)}.`
      : 'Signup is not open yet.';
  }
  if (access.opensForYouAt && access.matchedTier) {
    return `You can sign up from ${formatTierDate(access.opensForYouAt)} (${access.matchedTier.label}).`;
  }
  return `This event is in priority signup until ${
    general ? formatTierDate(general) : 'the general opening'
  }. It opens to everyone then.`;
}

/**
 * Approved-request userIds for an event (audience = "people signed up").
 * [Phase 1 / waitlist plan §2.1, resolved] Left `approved`-only, by decision:
 * the broadcast audience is CONFIRMED people — a queued (`waitlisted`) or
 * softly-held (`offered`) member has no shift yet and should not be told
 * "you're signed up" alongside people who actually are.
 */
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

/**
 * All pending, waitlisted, and offered requests across events — the only
 * cross-event request feed. [Phase 0 / waitlist plan §2.1, orchestrator
 * addition] No longer pending-only: it must also carry `waitlisted`/`offered`
 * docs for Phase 1's manager waitlist panel. Widened from a single equality
 * filter to `where('status','in',[...])` because a stale equality filter here
 * fails silently — the query never fetches the new-status docs at all, so a
 * consumer would render an empty-but-correct-looking list rather than a
 * visibly wrong one. The exported name stays `subscribePendingRequests`
 * (call sites still exist) even though the feed is broader than the name
 * suggests; see `pendingCountForEvent` (event-utils.ts) for the guard that
 * keeps the "needs my decision" badge counting pending-only off this feed.
 */
export function subscribePendingRequests(cb: (requests: ShiftRequest[]) => void): () => void {
  const q = query(
    collection(db, 'shift_requests'),
    where('status', 'in', ['pending', 'waitlisted', 'offered']),
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }))),
    (err) => {
      console.error('pending requests subscription error:', err);
      cb([]);
    },
  );
}

// ---------------------------------------------------------------------------
// [Phase 0 — waitlist plan §3.8, §4.3] Pure policy-resolution primitives.
// No consumers yet in this phase; every later waitlist function (§3.5, §3.6,
// `promoteNextFromWaitlist`, `getWaitlistPosition`, etc.) is required to route
// through these rather than re-deriving org-config-vs-override or the queue
// key inline, so there is exactly one place that knows either decision.
// ---------------------------------------------------------------------------

/**
 * Resolve one event's fully-merged waitlist/cancellation/reminder policy:
 * `DEFAULT_ORG_CONFIG` -> `org_settings/current` -> `Event.policy`, in that
 * order, into a single object. Every consumer takes `ResolvedEventPolicy`,
 * never raw config — until an offer is actually made, at which point the
 * resolved values are frozen onto `offer.policy` (P3) and must NOT be
 * re-derived from a later config change.
 *
 * AMBIGUITY CALL (plan not fully explicit here): `config.waitlist.enabled`
 * (org-wide kill switch, §4.4) and `Event.waitlistEnabled` (the per-event UI
 * switch, §2.2 — absent = ON) are two different toggles with two different
 * defaults, and `EventPolicyOverride.waitlistEnabled` also exists as an
 * "Advanced" override slot alongside them. Resolved here as: the org switch
 * gates everything (off org-wide means off for every event, full stop),
 * AND-ed with the per-event value, which is read from `event.policy` first
 * (an explicit advanced override) and falls back to the plain top-level
 * `event.waitlistEnabled` field, defaulting `true` per §2.2 when neither is
 * set. This keeps `Event.waitlistEnabled`'s documented fail-open default
 * intact while still letting an org-wide `waitlist.enabled: false` win.
 */
export function resolveEventPolicy(
  event: Event,
  config: OrgConfigDoc = getOrgConfig(),
): ResolvedEventPolicy {
  const w = config.waitlist;
  const override = event.policy ?? {};
  const eventLevelEnabled = override.waitlistEnabled ?? event.waitlistEnabled ?? true;

  return {
    waitlistEnabled: w.enabled && eventLevelEnabled,
    scope: override.scope ?? w.scope,
    honorTeamPreference: override.honorTeamPreference ?? w.honorTeamPreference,
    autoPromote: override.autoPromote ?? w.autoPromote,
    longNoticeThresholdHours: override.longNoticeThresholdHours ?? w.longNoticeThresholdHours,
    longNoticeResponseWindowHours:
      override.longNoticeResponseWindowHours ?? w.longNoticeResponseWindowHours,
    shortNoticeResponseWindowHours:
      override.shortNoticeResponseWindowHours ?? w.shortNoticeResponseWindowHours,
    declinedOfferBehavior: override.declinedOfferBehavior ?? w.declinedOfferBehavior,
    maxQueueLength: override.maxQueueLength ?? w.maxQueueLength,
    allowQueueAfterShiftStart: override.allowQueueAfterShiftStart ?? w.allowQueueAfterShiftStart,
    // Org-wide only by design — see the field's doc comment on
    // `ResolvedEventPolicy`; there is intentionally no `override` read here.
    maxOffersPerMember: w.maxOffersPerMember,
    cancellation: { ...config.cancellationPolicy, ...(override.cancellation ?? {}) },
    reminderHoursBefore: override.reminderHoursBefore ?? config.shiftReminders.hoursBefore,
  };
}

/**
 * The single place the `(eventId, role)` queue key (P13, the default —
 * `policy.scope === 'event'`) vs the legacy `(eventId, teamId, role)` key
 * (`policy.scope === 'team'`, an opt-in restoring Revision 1's behaviour) is
 * decided. `getWaitlistPosition` and every promotion-scan query must build
 * their grouping key through this function, never inline, so the two scope
 * modes can never drift apart.
 *
 * Takes a minimal `Pick` (not a full `ShiftRequest`) so it can be called
 * before a request doc exists yet — e.g. to compute the key a not-yet-written
 * queue entry would join — as well as against an already-loaded request.
 */
export function queueKeyOf(
  request: Pick<ShiftRequest, 'eventId' | 'role' | 'teamId'>,
  policy: Pick<ResolvedEventPolicy, 'scope'>,
): string {
  return policy.scope === 'team'
    ? `${request.eventId}::${request.teamId}::${request.role}`
    : `${request.eventId}::${request.role}`;
}

/**
 * [Phase 0 / waitlist plan §2.1, P13] True when a request holds no team yet —
 * the documented `teamId: ''` sentinel.
 *
 * `ShiftRequest.teamId` stays a required `string` so the ~dozen existing
 * consumers keep compiling, which means "unassigned" is encoded as an empty
 * string rather than `undefined`. Call this instead of writing `!request.teamId`
 * inline: the falsy check reads as a possible bug (or gets "cleaned up" into a
 * truthiness assumption) at every site, and if the sentinel ever changes there
 * is exactly one place to change it.
 *
 * Note this is about *slot assignment*, not status: under
 * `waitlist.scope === 'team'` a queued member IS grouped by a chosen team, so a
 * `waitlisted` request can legitimately carry a real `teamId`. Never infer
 * status from this predicate, or vice versa.
 */
export function isUnassignedQueueEntry(
  request: Pick<ShiftRequest, 'teamId'>,
): boolean {
  return !request.teamId;
}

// ---------------------------------------------------------------------------
// [Phase 1 — waitlist plan §3.2–§3.6, §3.8] The waitlist queue itself: pure
// notice-class / soft-hold / ordering / expiry primitives first, then the
// write paths (join/leave, promote, accept/decline, sweep, manager queue
// actions) that are built entirely out of them. Nothing below should
// re-derive a queue key, a notice window, or a slot occupancy check inline —
// route through these.
// ---------------------------------------------------------------------------

/**
 * The shift's start instant: `team.startTime` if set, else `event.callTime`,
 * resolved against `event.date` in the BROWSER'S LOCAL TIMEZONE (same
 * convention as `eventCallDateTime`/`eventEndDateTime`, event-utils.ts — see
 * §3.3 for the DST/clock-skew caveat, an accepted pre-existing risk, not new
 * here). `team` is optional because a per-event queue entry has no team
 * until it is offered one (P13); omitting it falls back to the event-level
 * approximation. Returns `null` only for a legacy event with no `callTime`
 * (P12) — that is now a "needs attention" condition, not a silent default.
 */
export function getShiftStartInstant(event: Event, team?: EventTeam): Date | null {
  const timeStr = team?.startTime ?? event.callTime;
  if (!timeStr) return null;
  const day = toJsDate(event.date);
  if (!day) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const d = new Date(day);
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d;
}

/**
 * Which notice-window bucket a promotion offered right now would fall into.
 * `team` is REQUIRED (unlike `getShiftStartInstant`'s) — §3.5/D2: notice
 * class must always be computed from a resolved team, never the request-level
 * event-only approximation, or a team starting earlier than the event call
 * time could wrongly read as `'long'` (and therefore binding) on a shift
 * that's actually inside the short-notice window. See
 * `WaitlistOffer.shiftStartAt`'s doc comment (app/types.ts) for the full
 * argument. Returns `null` when `getShiftStartInstant` does (legacy event).
 */
export function computeNoticeClass(
  event: Event,
  team: EventTeam,
  now: Date,
  policy: Pick<ResolvedEventPolicy, 'longNoticeThresholdHours'>,
): 'long' | 'short' | null {
  const shiftStart = getShiftStartInstant(event, team);
  if (!shiftStart) return null;
  const hoursUntilShift = (shiftStart.getTime() - now.getTime()) / 3_600_000;
  return hoursUntilShift >= policy.longNoticeThresholdHours ? 'long' : 'short';
}

/**
 * Freeze the resolved policy onto an offer at the moment it's made (P3) —
 * `responseWindowHours` is the window ACTUALLY USED for this offer (the long
 * or short window, whichever `noticeClass` selected), not both, so a reader
 * months later doesn't have to re-derive which one applied.
 */
export function freezePolicy(
  policy: Pick<
    ResolvedEventPolicy,
    'longNoticeThresholdHours' | 'longNoticeResponseWindowHours' | 'shortNoticeResponseWindowHours' | 'cancellation'
  >,
  noticeClass: 'long' | 'short',
): WaitlistOffer['policy'] {
  return {
    longNoticeThresholdHours: policy.longNoticeThresholdHours,
    responseWindowHours:
      noticeClass === 'long' ? policy.longNoticeResponseWindowHours : policy.shortNoticeResponseWindowHours,
    cancellationNoticeHours: policy.cancellation.noticeHours,
    cancellationMode: policy.cancellation.mode,
  };
}

/**
 * Whether a `TeamSlot`'s soft hold is still live. A hold with `heldUntil` in
 * the past reads as effectively open again with NO write required to
 * "release" it (see `TeamSlot.heldUntil`'s doc comment, app/types.ts) — every
 * occupancy check in this file goes through this rather than testing
 * `heldUntil` truthiness directly.
 */
export function isSlotHeld(slot: TeamSlot, now: Date = new Date()): boolean {
  if (!slot.heldUntil) return false;
  const t = toJsDate(slot.heldUntil);
  return !!t && t.getTime() > now.getTime();
}

/** A resolved reference to one team slot, with a way to write a new value back onto the (cloned) team it came from. */
export interface SlotRef {
  kind: 'fto' | 'ftoIntern' | 'emt';
  /** Only meaningful for `kind === 'emt'`. */
  index?: number;
  /** The slot's value as of resolution — read-only; write via `assign`. */
  slot: TeamSlot;
  /** Overwrite this slot's value on the team object `resolveSlotRef` was called with. */
  assign(next: TeamSlot): void;
}

/**
 * The single place slot addressing happens for FTO / FTO_INTERN / EMT
 * PLACEMENT — used by every transaction that is looking for somewhere to put
 * a NEW assignment or hold (`approveRequest`, `promoteNextFromWaitlist`).
 * Mutates `team` in place via the returned `assign` closure — callers pass a
 * shallow-cloned team (as every transaction here already does before
 * mutating) and re-serialize the whole `teams` array in one `tx.update`.
 *
 * This answers "where can I PUT someone", not "which slot does THIS request
 * already hold" — for the latter question (accepting/releasing an existing
 * offer) use `findSlotRefByRequest` instead, which addresses a slot by
 * `requestId` regardless of hold/fill state. Picking the wrong one of the two
 * is exactly the bug this pair of doc comments exists to prevent: a live-held
 * EMT slot is invisible to this function BY DESIGN (see below), so a caller
 * that means "find the slot I already hold" and calls this one instead will
 * see it as taken or will resolve to the wrong seat.
 *
 * FTO / FTO_INTERN: always resolves to the team's single slot for that role
 * (or `null` for FTO_INTERN when the team has no intern slot at all) —
 * occupancy/hold state is the CALLER's to check, since there's only one
 * candidate slot to reason about.
 *
 * EMT: resolves to the first slot that is neither filled NOR live-held
 * (`isSlotHeld`) — i.e. genuinely available for a NEW assignment/hold. Reads
 * through a RESIZED VIEW of `team.emtSlots` (padded/truncated to
 * `team.emtCount`, mirroring the invariant `approveRequest` always enforced
 * before this helper existed — a legacy/short array can't hide a real open
 * seat) without mutating `team` itself: this function must stay side-effect
 * free on resolve, since read-only callers (`hasOpenSlotForRoleOnEvent`) pass
 * live, caller-owned `Event`/`EventTeam` objects (e.g. UI state) that must
 * never be mutated just by asking "is there an open slot?" — only `assign()`
 * writes back, and only transactional callers (which always pass an
 * already-cloned team) call it. Returns `null` when no such slot exists
 * (every EMT seat is filled or held).
 */
export function resolveSlotRef(team: EventTeam, role: SlotRole): SlotRef | null {
  if (role === 'FTO') {
    return {
      kind: 'fto',
      slot: team.ftoSlot ?? {},
      assign: (next) => {
        team.ftoSlot = next;
      },
    };
  }
  if (role === 'FTO_INTERN') {
    if (!teamHasIntern(team)) return null;
    return {
      kind: 'ftoIntern',
      slot: team.ftoInternSlot ?? {},
      assign: (next) => {
        team.ftoInternSlot = next;
      },
    };
  }
  const slots = resizeEmtSlots(team.emtSlots || [], team.emtCount); // pure — does NOT write to `team`
  const idx = slots.findIndex((s) => !s.userId && !isSlotHeld(s));
  if (idx === -1) return null;
  return {
    kind: 'emt',
    index: idx,
    slot: slots[idx],
    assign: (next) => {
      const arr = [...slots];
      arr[idx] = next;
      team.emtSlots = arr;
    },
  };
}

/**
 * The single place slot addressing happens for FTO / FTO_INTERN / EMT
 * IDENTIFICATION — used by every transaction that already knows a slot is
 * (or was) assigned to a specific request and needs to find THAT slot again,
 * regardless of its current hold/fill state: `acceptOffer` (confirm the held
 * seat is still this request's before promoting it), `releaseOfferHoldInTx`
 * (shared by `declineOffer`, `removeWaitlistEntry`, and `cancelRequest`'s
 * `offered` branch — clear the hold this request placed), and
 * `sweepExpiredOffers` (clear the hold on an offer nobody answered in time).
 *
 * This is the mirror image of `resolveSlotRef`: that one answers "where can I
 * PUT someone" (skips filled/held seats by construction, so it can never see
 * a slot this function needs to find), this one answers "which slot does
 * THIS REQUEST already occupy" by matching on `slot.requestId` alone. An EMT
 * seat holding an offer is exactly the case `resolveSlotRef` is built to
 * exclude, which is why the two must never be swapped.
 *
 * Scans FTO, then FTO_INTERN (only when `teamHasIntern(team)` — a legacy team
 * with no intern slot has nothing to match there), then EMT — through the
 * same resized view `resolveSlotRef` uses (`resizeEmtSlots`), for the same
 * reason: a short/legacy `emtSlots` array must not hide a real held seat.
 * Like `resolveSlotRef`, this stays side-effect free on resolve — it never
 * mutates `team`, only `assign()` does, and only once a transactional caller
 * invokes it. Returns `null` when no slot on the team carries `requestId`.
 */
export function findSlotRefByRequest(team: EventTeam, requestId: string): SlotRef | null {
  if (team.ftoSlot?.requestId === requestId) {
    return {
      kind: 'fto',
      slot: team.ftoSlot,
      assign: (next) => {
        team.ftoSlot = next;
      },
    };
  }
  if (teamHasIntern(team) && team.ftoInternSlot?.requestId === requestId) {
    return {
      kind: 'ftoIntern',
      slot: team.ftoInternSlot,
      assign: (next) => {
        team.ftoInternSlot = next;
      },
    };
  }
  const slots = resizeEmtSlots(team.emtSlots || [], team.emtCount); // pure — does NOT write to `team`
  const idx = slots.findIndex((s) => s.requestId === requestId);
  if (idx === -1) return null;
  return {
    kind: 'emt',
    index: idx,
    slot: slots[idx],
    assign: (next) => {
      const arr = [...slots];
      arr[idx] = next;
      team.emtSlots = arr;
    },
  };
}

/**
 * [P13] Is there a genuinely open slot for `role` on ANY team of this event
 * ("open" excludes a live-held slot)? This is the exact condition
 * `requestShift` branches `pending` vs `waitlisted` on — event-scoped, not
 * `teamId`-scoped, because the default queue is event-scoped.
 */
function hasOpenSlotForRoleOnEvent(event: Event, role: SlotRole, now: Date = new Date()): boolean {
  return (event.teams || []).some((team) => {
    const ref = resolveSlotRef(team, role);
    if (!ref) return false;
    return !ref.slot.userId && !isSlotHeld(ref.slot, now);
  });
}

/**
 * Total order over a waitlist queue: skipped entries sort behind every
 * non-skipped entry (`skippedAt == null ? 0 : 1` first), then ascending
 * `waitlistedAt` (a `waitlisted` doc with no `waitlistedAt` is a
 * data-integrity bug per its doc comment — sorts LAST, not first), then a
 * stable tie-break on doc id so two docs with the exact same `waitlistedAt`
 * (a race) don't reorder between renders.
 */
export function waitlistComparator(a: ShiftRequest, b: ShiftRequest): number {
  const skipRank = (r: ShiftRequest) => (r.skippedAt == null ? 0 : 1);
  const sa = skipRank(a);
  const sb = skipRank(b);
  if (sa !== sb) return sa - sb;
  const ta = toJsDate(a.waitlistedAt)?.getTime() ?? Infinity;
  const tb = toJsDate(b.waitlistedAt)?.getTime() ?? Infinity;
  if (ta !== tb) return ta - tb;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

/**
 * 1-based rank of `entry` among the `waitlisted` docs sharing its queue key
 * (`queueKeyOf`), ordered by `waitlistComparator`. Pure, no I/O — position is
 * NEVER a stored field (P2), always a read-time computation over the docs the
 * caller already has loaded. `entry` is included in the candidate set even
 * when its own status is `offered` (so an offered member still sees a
 * displayable rank) or if it isn't present in `requests` at all.
 */
export function getWaitlistPosition(
  requests: ShiftRequest[],
  entry: ShiftRequest,
  policy: Pick<ResolvedEventPolicy, 'scope'>,
): number {
  const key = queueKeyOf(entry, policy);
  const candidates = requests.filter(
    (r) => (r.status === 'waitlisted' || r.id === entry.id) && queueKeyOf(r, policy) === key,
  );
  if (!candidates.some((r) => r.id === entry.id)) candidates.push(entry);
  candidates.sort(waitlistComparator);
  const idx = candidates.findIndex((r) => r.id === entry.id);
  return idx === -1 ? candidates.length : idx + 1;
}

/**
 * §3.6 — pure, read-time expiry resolution. Every read surface that shows an
 * `offered` request must call this instead of trusting `request.status`
 * directly: promotion only advances the queue when a manager client opens
 * the event (§3.6's "lazy evaluation" design), so a stale `offered` doc can
 * sit past its `respondBy` until someone's client sweeps it.
 */
export function resolveOfferState(request: ShiftRequest, now: Date): ShiftRequestStatus {
  if (request.status !== 'offered') return request.status;
  if (request.offer?.response) return request.status;
  if (request.offer && now.getTime() > request.offer.respondBy.toMillis()) return 'expired';
  return 'offered';
}

/**
 * [P4] Whether a no-show against THIS request carries real liability — see
 * `ShiftRequest.commitmentBinding`'s doc comment (app/types.ts) for the full
 * LEGACY-UNDEFINED ASYMMETRY this centralizes. Never inline `?? true` / `??
 * false` at a call site — only one of those defaults is right, and which one
 * depends on `status`:
 *   - explicit `commitmentBinding` present -> use it, unconditionally.
 *   - `undefined` AND `status === 'approved'` -> `true` (a legacy direct
 *     approval predates waitlisting and was always binding in practice;
 *     defaulting it non-binding would silently forgive real historical
 *     no-show liability).
 *   - `undefined` AND any other status -> `false` (no shift to be liable for).
 */
export function isCommitmentBinding(request: Pick<ShiftRequest, 'status' | 'commitmentBinding'>): boolean {
  if (request.commitmentBinding !== undefined) return request.commitmentBinding;
  return request.status === 'approved';
}

/**
 * The late-cancellation policy math (§3.4), shared by every `cancelRequest`
 * branch that actually held a commitment (`offered`/`approved` — see that
 * function's doc comment for why `pending`/`waitlisted` never call this).
 * `appliesTo: 'binding'` (default) gates on `isCommitmentBinding`; `'all'`
 * evaluates the notice math regardless. `enabled: false` short-circuits
 * everything to "not late, not blocked."
 */
function evaluateLateCancellation(
  request: Pick<ShiftRequest, 'shiftStartAt' | 'status' | 'commitmentBinding'>,
  cancellation: CancellationPolicyConfig,
): { blocked: boolean; stampLate: boolean; noticeHours: number } {
  const notLate = { blocked: false, stampLate: false, noticeHours: cancellation.noticeHours };
  if (!cancellation.enabled) return notLate;
  const applies = cancellation.appliesTo === 'all' || isCommitmentBinding(request);
  if (!applies) return notLate;
  const shiftStart = toJsDate(request.shiftStartAt);
  if (!shiftStart) return notLate;
  const hoursUntilShift = (shiftStart.getTime() - Date.now()) / 3_600_000;
  const late = hoursUntilShift < cancellation.noticeHours;
  if (!late) return notLate;
  return {
    blocked: cancellation.mode === 'block',
    stampLate: cancellation.mode === 'flag' || cancellation.mode === 'confirm',
    noticeHours: cancellation.noticeHours,
  };
}

/**
 * A synthetic `Event` good for exactly one thing: resolving org-default
 * policy when the real event doc is missing (deleted, or a race).
 * `resolveEventPolicy` only ever reads `event.policy`/`event.waitlistEnabled`
 * off its argument, both absent here, so this always falls through to plain
 * org config. Used so cancelling/declining can NEVER be blocked by a missing
 * event (decision: §3.2/§3.8).
 */
function syntheticEventForPolicy(eventId: string): Event {
  return { id: eventId, teams: [] } as unknown as Event;
}

/** Does this user already hold an `approved` request on this event (any team/role)? */
async function hasActiveApprovalOnEvent(userId: string, eventId: string): Promise<boolean> {
  const snap = await getDocs(
    query(
      collection(db, 'shift_requests'),
      where('eventId', '==', eventId),
      where('userId', '==', userId),
      where('status', '==', 'approved'),
    ),
  );
  return !snap.empty;
}

/**
 * Release the soft hold `request` has on its offered slot, if one is still
 * live for it, inside an already-open transaction. Shared by every path that
 * can terminate an `offered` request outside of accept/expiry —
 * `declineOffer`, `removeWaitlistEntry`, and `cancelRequest`'s `offered`
 * branch — so the release logic (find the team, resolve the slot, confirm
 * it's still held for THIS request, clear it) exists exactly once. Returns
 * the event as read inside the transaction (or `null` if the event doc is
 * gone) so the caller can decide whether/what to roll forward.
 */
async function releaseOfferHoldInTx(
  tx: Transaction,
  request: Pick<ShiftRequest, 'id' | 'eventId' | 'teamId' | 'role'>,
): Promise<Event | null> {
  const eventRef = doc(db, 'events', request.eventId);
  const eventSnap = await tx.get(eventRef);
  if (!eventSnap.exists()) return null;
  const ev = eventSnap.data() as Event;
  const teams = (ev.teams || []).map((t) => ({ ...t }));
  const team = teams.find((t) => t.id === request.teamId);
  if (team) {
    // `findSlotRefByRequest`, not `resolveSlotRef`: the seat we're releasing
    // is live-held (that's the whole point of a hold), so the placement
    // resolver would skip right past it — see both functions' doc comments.
    const slotRef = findSlotRefByRequest(team, request.id!);
    if (slotRef) {
      slotRef.assign({});
      tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
    }
  }
  return { id: eventSnap.id, ...ev };
}

/**
 * Best-effort: flag a legacy event with no `callTime` as blocked-for-
 * promotion (P12) rather than silently skipping it. `updateEvent` clears
 * this the moment a non-empty `callTime` is saved (decision: app/types.ts
 * `Event.needsCallTime`).
 */
export async function flagEventNeedsCallTime(eventId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'events', eventId), { needsCallTime: true });
  } catch (e) {
    console.error('flagEventNeedsCallTime failed:', e);
  }
}

/**
 * §3.5 — offer the next eligible waitlisted member the slot that just freed
 * on `(teamId, role)`. Short-circuits when waitlisting is off, or when
 * `autoPromote` is off and the caller didn't pass `opts.force` (the manual
 * "send this offer by hand" path from the manager queue panel — same
 * function, one extra flag, never a second implementation).
 *
 * `opts.requestId` (only meaningful with `opts.force`) pins the promotion to
 * one specific queued member — the manager's force-promote picker —
 * bypassing FIFO order and `honorTeamPreference` entirely.
 */
export async function promoteNextFromWaitlist(
  event: Event,
  teamId: string,
  role: SlotRole,
  actor: EventActor,
  opts?: { force?: boolean; requestId?: string },
): Promise<void> {
  const policy = resolveEventPolicy(event);
  if (!policy.waitlistEnabled) return;
  if (!policy.autoPromote && !opts?.force) return;

  // 1. Candidate query — event-scoped (P13); the Firestore query can't
  // consult `queueKeyOf` directly (it needs literal `where()` clauses), so
  // the same scope condition is mirrored here by hand.
  const constraints = [
    where('eventId', '==', event.id),
    where('role', '==', role),
    where('status', '==', 'waitlisted'),
  ];
  if (policy.scope === 'team') constraints.push(where('teamId', '==', teamId));
  const candidatesSnap = await getDocs(
    query(collection(db, 'shift_requests'), ...constraints, orderBy('waitlistedAt', 'asc')),
  );
  const queue = candidatesSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }))
    .sort(waitlistComparator);

  // 2. Ordering. `opts.requestId` bypasses everything below and pins to one
  // candidate. Otherwise `honorTeamPreference`'s two-pass ordering — the
  // queue's underlying FIFO order never changes, this only decides which
  // pass a candidate is considered in.
  const ordered = opts?.requestId
    ? queue.filter((c) => c.id === opts.requestId)
    : policy.honorTeamPreference === 'ignore'
      ? queue
      : policy.honorTeamPreference === 'strict'
        ? queue.filter((c) => !c.preferredTeamId || c.preferredTeamId === teamId)
        : [
            ...queue.filter((c) => !c.preferredTeamId || c.preferredTeamId === teamId),
            ...queue.filter((c) => c.preferredTeamId && c.preferredTeamId !== teamId),
          ];

  for (const candidate of ordered) {
    // 3. Eligibility re-check — a queued member can go stale (certs lapse,
    // role changes, or they got approved onto ANOTHER team for this event).
    const userSnap = await getDoc(doc(db, 'users', candidate.userId));
    if (!userSnap.exists()) continue;
    const user = userSnap.data() as User;
    if (!canSignUpForShifts(user)) continue;
    if (!canRequestRole(user.role, role)) continue;
    if (await hasActiveApprovalOnEvent(candidate.userId, event.id!)) continue;
    // [Phase 2 / waitlist plan §3.5 step 3, §3.7] Tier re-check: a queued
    // member whose window hasn't opened yet is SKIPPED, not offered and not
    // dropped from the queue — `continue` to the next candidate is exactly
    // that; this loop's existing eligibility checks above already establish
    // "skip without mutating the doc" as the mechanism, so this reuses it
    // rather than reaching for the separate manager-facing `skippedAt` field
    // (`skipWaitlistEntry`), which is a persisted, explicit deprioritization
    // action and not what a transient ineligibility re-check should write.
    // `user` (fetched above) already satisfies `TierSubject` structurally.
    // Skip the stats query entirely when the event isn't tiered.
    if (event.accessTier?.enabled) {
      const candidateStats = await getRequesterShiftStats(candidate.userId);
      const access = getTierAccess(event, user, candidateStats);
      if (!access.eligible) continue;
    }

    // 4. Notice class — computed ONCE here from the RESOLVED TEAM (D2), then
    // frozen onto the offer (P3). See `computeNoticeClass`'s doc comment for
    // why this must never be derived from the request-level `shiftStartAt`
    // approximation instead.
    const team = event.teams.find((t) => t.id === teamId);
    if (!team) continue;
    const now = new Date();
    const noticeClass = computeNoticeClass(event, team, now, policy);
    if (noticeClass === null) {
      // Legacy event with no callTime (P12) — do not auto-offer; flag it.
      await flagEventNeedsCallTime(event.id!);
      return;
    }
    const shiftStart = getShiftStartInstant(event, team)!; // non-null: noticeClass !== null guarantees this
    const windowHours =
      noticeClass === 'long' ? policy.longNoticeResponseWindowHours : policy.shortNoticeResponseWindowHours;
    const respondBy = new Date(Date.now() + windowHours * 3_600_000);

    // 5. Transactional soft-hold against the EVENT doc.
    const ok = await runTransaction(db, async (tx) => {
      const eventRef = doc(db, 'events', event.id!);
      const eventSnap = await tx.get(eventRef);
      if (!eventSnap.exists()) return false;
      const liveEvent = eventSnap.data() as Event;
      const teams = (liveEvent.teams || []).map((t) => ({ ...t }));
      const liveTeam = teams.find((t) => t.id === teamId);
      if (!liveTeam) return false;
      const slotRef = resolveSlotRef(liveTeam, role);
      if (!slotRef || slotRef.slot.userId || isSlotHeld(slotRef.slot)) return false; // taken or held — try next candidate

      slotRef.assign({ heldUntil: Timestamp.fromDate(respondBy), requestId: candidate.id });
      tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
      tx.update(
        doc(db, 'shift_requests', candidate.id!),
        deepRemoveUndefined({
          status: 'offered',
          teamId,
          teamName: liveTeam.name,
          // Now that a team is resolved, the request-level approximation can
          // be replaced with the real per-team instant too.
          shiftStartAt: Timestamp.fromDate(shiftStart),
          offer: {
            offeredAt: serverTimestamp(),
            respondBy: Timestamp.fromDate(respondBy),
            noticeClass,
            binding: noticeClass === 'long',
            policy: freezePolicy(policy, noticeClass),
            teamId,
            teamName: liveTeam.name,
            shiftStartAt: Timestamp.fromDate(shiftStart),
            offeredBy: actor.uid,
          },
        }),
      );
      return true;
    });

    if (ok) {
      try {
        await createNotification(
          candidate.userId,
          {
            type: 'waitlist_offer',
            title: `Shift offer: ${event.name}`,
            body: `${team.name} · ${slotRoleLabel(role)} — respond by ${respondBy.toLocaleString()}.`,
            link: '/events?event=' + event.id + '&offer=' + candidate.id,
          },
          { uid: actor.uid, name: actor.name },
        );
      } catch (e) {
        console.error('waitlist offer notification failed:', e);
      }
      return;
    }
    // else: slot claimed between the query and the transaction — try the next candidate.
  }
  // No eligible candidate — slot stays open, untouched.
}

/**
 * §3.5/§3.6 — accept a live offer: `offered -> approved`. Fails closed (never
 * silently "succeeds" past the deadline) if `resolveOfferState` already reads
 * the offer as expired, or if it's already been responded to — the client
 * should already have disabled the button via the same check; this is
 * defence in depth against a stale render.
 */
export async function acceptOffer(request: ShiftRequest, actor: EventActor): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const reqRef = doc(db, 'shift_requests', request.id);
  const eventRef = doc(db, 'events', request.eventId);

  await runTransaction(db, async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) throw new Error('Request no longer exists.');
    const freshReq = { id: reqSnap.id, ...(reqSnap.data() as ShiftRequest) };
    const now = new Date();
    if (freshReq.status !== 'offered' || !freshReq.offer) {
      throw new Error('This offer is no longer available.');
    }
    if (resolveOfferState(freshReq, now) === 'expired' || freshReq.offer.response) {
      throw new Error('This offer is no longer available.');
    }

    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists()) throw new Error('Event no longer exists.');
    const liveEvent = eventSnap.data() as Event;
    const teams = (liveEvent.teams || []).map((t) => ({ ...t }));
    const team = teams.find((t) => t.id === freshReq.teamId);
    if (!team) throw new Error('Team no longer exists on this event.');
    // `findSlotRefByRequest`, not `resolveSlotRef`: the slot we're accepting
    // is the one this request already holds, which is exactly the state
    // `resolveSlotRef` treats as unavailable for a NEW placement. The
    // `requestId` match is already guaranteed by the lookup itself; the only
    // thing left to verify is that the hold hasn't lapsed out from under us.
    const slotRef = findSlotRefByRequest(team, request.id!); // narrowed by the `if (!request.id) throw` guard above; the guard's narrowing doesn't survive into this transaction closure
    if (!slotRef || !isSlotHeld(slotRef.slot, now)) {
      throw new Error('This offer is no longer available.');
    }

    slotRef.assign({ userId: request.userId, userName: request.userName, requestId: request.id });
    tx.update(eventRef, { teams, updatedAt: serverTimestamp() });
    tx.update(
      reqRef,
      deepRemoveUndefined({
        status: 'approved',
        assignedSlot: slotRef.kind === 'fto' ? 'fto' : slotRef.kind === 'ftoIntern' ? 'intern' : `emt:${slotRef.index}`,
        teamId: freshReq.teamId,
        teamName: freshReq.teamName,
        // Long-notice acceptance is binding; short-notice never is, even
        // accepted (P4) — mirrors `offer.binding`, computed once more here
        // because `commitmentBinding` is the field everything else reads.
        commitmentBinding: freshReq.offer.noticeClass === 'long',
        offer: { ...freshReq.offer, respondedAt: serverTimestamp(), response: 'accepted' },
        decidedBy: actor.uid,
        decidedByName: actor.name,
        decidedAt: serverTimestamp(),
      }),
    );
  });

  try {
    await createNotification(
      request.userId,
      {
        type: 'waitlist_promoted',
        title: `You're confirmed: ${request.eventName}`,
        body: `${request.teamName} · ${slotRoleLabel(request.role)}. See you there!`,
        link: '/events',
      },
      { uid: actor.uid, name: actor.name },
    );
  } catch (e) {
    console.error('waitlist accept notification failed:', e);
  }
}

/**
 * §3.5/§4.1 — decline a live offer: `offered -> declined`, OR back to
 * `waitlisted` under `declinedOfferBehavior: 'requeue_back'`. NEVER
 * punitive regardless of `noticeClass` — no flag, no counter that feeds an
 * attendance stat, by design (P4). Releases the slot's soft hold in the same
 * transaction as the status write, then rolls the queue forward for the
 * same `(teamId, role)` — a decline always frees the slot for someone else
 * regardless of what happens to the decliner's own status.
 */
export async function declineOffer(request: ShiftRequest, actor: EventActor): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const reqRef = doc(db, 'shift_requests', request.id);

  let liveEventForPromotion: Event | null = null;
  let rollForward: { teamId: string; role: SlotRole } | null = null;

  await runTransaction(db, async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) throw new Error('Request no longer exists.');
    const freshReq = { id: reqSnap.id, ...(reqSnap.data() as ShiftRequest) };
    if (freshReq.status !== 'offered' || !freshReq.offer) {
      throw new Error('This offer is no longer available.');
    }

    liveEventForPromotion = await releaseOfferHoldInTx(tx, freshReq);
    const policy = resolveEventPolicy(liveEventForPromotion ?? syntheticEventForPolicy(request.eventId));

    // Firestore rejects `serverTimestamp()` sentinels inside arrays outright
    // ("serverTimestamp() is not currently supported inside arrays"), and
    // `offerHistory` is an array — so the response instant is necessarily a
    // concrete CLIENT timestamp here, taken once and reused for both the
    // history entry below and the terminal branch's `offer` map further down
    // so the live offer and its archived copy agree on the exact instant.
    // This is a small, deliberate accuracy tradeoff (client clock, not
    // server); do not "fix" it back to `serverTimestamp()`.
    const respondedAt = Timestamp.now();
    const offerHistory = [
      ...(freshReq.offerHistory || []),
      { ...freshReq.offer, response: 'declined' as const, respondedAt },
    ];
    const offerCount = (freshReq.offerCount || 0) + 1;

    // [Phase 1 / waitlist plan §4.1, decision 7] `requeue_back`: send the
    // member to the back of the queue (a fresh `skippedAt`, which the
    // comparator already treats as "behind every non-skipped entry") instead
    // of terminating them, unless they've burned their offer allowance.
    if (policy.declinedOfferBehavior === 'requeue_back' && offerCount < policy.maxOffersPerMember) {
      tx.update(
        reqRef,
        deepRemoveUndefined({
          status: 'waitlisted',
          skippedAt: serverTimestamp(),
          offerCount,
          offerHistory,
          offer: deleteField(),
        }),
      );
    } else {
      tx.update(
        reqRef,
        deepRemoveUndefined({
          status: 'declined',
          offerCount,
          offerHistory,
          offer: { ...freshReq.offer, response: 'declined', respondedAt },
          decidedBy: actor.uid,
          decidedByName: actor.name,
          decidedAt: serverTimestamp(),
        }),
      );
    }

    rollForward = { teamId: freshReq.teamId, role: freshReq.role };
  });

  if (liveEventForPromotion && rollForward) {
    const { teamId, role } = rollForward as { teamId: string; role: SlotRole };
    await promoteNextFromWaitlist(liveEventForPromotion, teamId, role, actor);
  }
}

/**
 * §3.6 — opportunistic sweep of every `offered` request on this event whose
 * `respondBy` has elapsed with no response: flips it to `expired`, releases
 * its slot's soft hold, and rolls the queue forward. Meant to be called once
 * per manager-client event-drawer mount (debounced there via a `useRef`
 * guard, not here — this function is safe to call redundantly since every
 * write is idempotent on the in-transaction `status === 'offered'`
 * precondition: two managers' clients racing this both attempt it, the
 * second's precondition fails harmlessly, Firestore's tx retry sees the new
 * state and no-ops).
 */
export async function sweepExpiredOffers(event: Event, actor: EventActor): Promise<void> {
  const offeredSnap = await getDocs(
    query(collection(db, 'shift_requests'), where('eventId', '==', event.id), where('status', '==', 'offered')),
  );
  const now = new Date();
  for (const docSnap of offeredSnap.docs) {
    const req = { id: docSnap.id, ...(docSnap.data() as ShiftRequest) };
    if (resolveOfferState(req, now) !== 'expired') continue;

    let liveEventFresh: Event | null = null;
    let rollForward: { teamId: string; role: SlotRole } | null = null;

    await runTransaction(db, async (tx) => {
      const reqRef = doc(db, 'shift_requests', req.id!);
      const freshReqSnap = await tx.get(reqRef);
      if (!freshReqSnap.exists()) return;
      const freshReq = freshReqSnap.data() as ShiftRequest;
      if (freshReq.status !== 'offered') return; // already handled by a concurrent sweep

      liveEventFresh = await releaseOfferHoldInTx(tx, { id: req.id, eventId: event.id!, teamId: freshReq.teamId, role: freshReq.role });
      tx.update(
        reqRef,
        deepRemoveUndefined({
          status: 'expired',
          offer: { ...freshReq.offer, response: 'expired', respondedAt: serverTimestamp() },
        }),
      );
      rollForward = { teamId: freshReq.teamId, role: freshReq.role };
    });

    if (liveEventFresh && rollForward) {
      const { teamId, role } = rollForward as { teamId: string; role: SlotRole };
      await promoteNextFromWaitlist(liveEventFresh, teamId, role, actor);
    }
  }
}

/**
 * Manager **Skip** action: deprioritize a queued member without removing
 * them (see `ShiftRequest.skippedAt`'s doc comment for the ordering rule).
 * A second skip on an already-skipped entry is a no-op.
 */
export async function skipWaitlistEntry(request: ShiftRequest, actor: EventActor): Promise<void> {
  void actor; // no attribution field exists for this action today — see ShiftRequest.skippedAt
  if (!request.id) throw new Error('Request id missing');
  if (request.skippedAt) return;
  await updateDoc(doc(db, 'shift_requests', request.id), { skippedAt: serverTimestamp() });
}

/** Undo `skipWaitlistEntry`, restoring the member's original queue position. */
export async function unskipWaitlistEntry(request: ShiftRequest, actor: EventActor): Promise<void> {
  void actor;
  if (!request.id) throw new Error('Request id missing');
  if (!request.skippedAt) return;
  await updateDoc(doc(db, 'shift_requests', request.id), { skippedAt: deleteField() });
}

/**
 * Manager removal of a queued or offered member: `-> cancelled`, stamped
 * with who decided it. Unlike `leaveWaitlist` (member-initiated, always
 * `waitlisted`-only), this also handles an `offered` entry — releasing its
 * soft hold and rolling the queue forward — since a manager clearing the
 * queue panel shouldn't have to know which sub-state a row is in.
 */
export async function removeWaitlistEntry(request: ShiftRequest, actor: EventActor): Promise<void> {
  if (!request.id) throw new Error('Request id missing');
  const reqRef = doc(db, 'shift_requests', request.id);
  let liveEventFresh: Event | null = null;

  await runTransaction(db, async (tx) => {
    if (request.status === 'offered') {
      liveEventFresh = await releaseOfferHoldInTx(tx, request);
    }
    tx.update(reqRef, {
      status: 'cancelled',
      decidedBy: actor.uid,
      decidedByName: actor.name,
      decidedAt: serverTimestamp(),
    });
  });

  if (request.status === 'offered' && liveEventFresh) {
    await promoteNextFromWaitlist(liveEventFresh, request.teamId, request.role, actor);
  }
}

// ---------------------------------------------------------------------------
// [Phase 3 — waitlist plan §6.2, §6.6] Shift reminders: pure due-computation
// + banner-selection primitives, then the best-effort emit path that stamps
// `remindersSent` for idempotency. Nothing below re-derives the shift start
// instant inline — route through `requestShiftStart` (the request-level
// analogue of `getShiftStartInstant`, which needs a live `Event`/`EventTeam`
// this code does not have).
// ---------------------------------------------------------------------------

/**
 * The instant this request's shift starts: the denormalized
 * `ShiftRequest.shiftStartAt` (already team-`startTime`-aware — plan D2) when
 * present, else `eventDate`. Null when neither parses.
 */
export function requestShiftStart(
  request: Pick<ShiftRequest, 'shiftStartAt' | 'eventDate'>,
): Date | null {
  return toJsDate(request.shiftStartAt) ?? toJsDate(request.eventDate ?? null);
}

export interface DueShiftReminder {
  request: ShiftRequest;
  /** The configured offset from `shiftReminders.hoursBefore` that has been crossed. */
  hoursBefore: number;
  /** Whole hours remaining until `shiftStart`, floored at 0. */
  hoursUntil: number;
  shiftStart: Date;
}

/**
 * [Phase 3 / §6.2, §6.6] `hoursBefore` is admin-edited data — it may be in any
 * order, and may contain duplicates or non-numbers. Every reminder function
 * below routes through this rather than trusting the raw config array:
 * filters to finite positive numbers, dedupes, and sorts ascending so
 * "smallest crossed offset" is simply "first match".
 */
function sanitizedReminderOffsets(hoursBefore: number[] | undefined): number[] {
  return Array.from(
    new Set((hoursBefore ?? []).filter((h) => Number.isFinite(h) && h > 0)),
  ).sort((a, b) => a - b);
}

/**
 * [§6.2, §6.6] Which reminder offsets are due for this member's own APPROVED
 * upcoming shifts right now, and not already in `remindersSent`. Pure — no
 * reads, no writes, no `Date.now()` (takes `now`). Returns [] when
 * `config.enabled` is false, when `hoursBefore` is empty, or when
 * `channels` does not include `'in_app'`.
 *
 * A request yields the SINGLE most specific due offset (the smallest
 * `hoursBefore` whose window has been crossed and which has not been sent),
 * never one entry per crossed offset — a member who first opens the app 3h
 * before a shift gets the 12h reminder once, not the 48h AND the 12h.
 * `config` defaults to `getShiftReminderConfig()`.
 */
export function computeDueShiftReminders(
  requests: ShiftRequest[],
  now: Date,
  config: ShiftReminderConfig = getShiftReminderConfig(),
): DueShiftReminder[] {
  if (!config.enabled) return [];
  if (!config.channels?.includes('in_app')) return [];
  const offsets = sanitizedReminderOffsets(config.hoursBefore);
  if (offsets.length === 0) return [];

  const due: DueShiftReminder[] = [];
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    const shiftStart = requestShiftStart(r);
    if (!shiftStart) continue;
    if (shiftStart.getTime() <= now.getTime()) continue; // already past
    const hoursUntilRaw = (shiftStart.getTime() - now.getTime()) / 3_600_000;
    const sent = new Set(r.remindersSent ?? []);
    // `offsets` is ascending, so the first crossed-and-unsent offset is the
    // smallest — exactly the "single most specific due offset" the contract
    // requires, with no extra sort needed here.
    const hoursBefore = offsets.find((h) => hoursUntilRaw <= h && !sent.has(h));
    if (hoursBefore === undefined) continue;
    due.push({
      request: r,
      hoursBefore,
      hoursUntil: Math.max(0, Math.floor(hoursUntilRaw)),
      shiftStart,
    });
  }
  return due;
}

/**
 * [§6.2] The banner selector: the viewer's single most imminent APPROVED
 * shift whose start is inside the largest configured `hoursBefore` offset and
 * still in the future. Independent of `remindersSent` — the banner is a fact
 * displayed while true, not a one-shot send, so it keeps showing as the shift
 * approaches. Null when reminders are disabled or nothing is imminent.
 */
export function selectShiftReminderBanner(
  requests: ShiftRequest[],
  now: Date,
  config: ShiftReminderConfig = getShiftReminderConfig(),
): DueShiftReminder | null {
  if (!config.enabled) return null;
  if (!config.channels?.includes('in_app')) return null;
  const offsets = sanitizedReminderOffsets(config.hoursBefore);
  if (offsets.length === 0) return null;
  const maxOffset = offsets[offsets.length - 1];

  let best: DueShiftReminder | null = null;
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    const shiftStart = requestShiftStart(r);
    if (!shiftStart) continue;
    if (shiftStart.getTime() <= now.getTime()) continue;
    const hoursUntilRaw = (shiftStart.getTime() - now.getTime()) / 3_600_000;
    if (hoursUntilRaw > maxOffset) continue; // not inside the window yet
    if (best && shiftStart.getTime() >= best.shiftStart.getTime()) continue;
    // Most specific = smallest offset whose window this shift is inside.
    const hoursBefore = offsets.find((h) => hoursUntilRaw <= h) ?? maxOffset;
    best = {
      request: r,
      hoursBefore,
      hoursUntil: Math.max(0, Math.floor(hoursUntilRaw)),
      shiftStart,
    };
  }
  return best;
}

/** `{event}` `{team}` `{role}` `{hours}` interpolation over `config.template`. Unknown placeholders are left as-is. */
export function formatShiftReminder(template: string, due: DueShiftReminder): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    switch (key) {
      case 'event':
        return due.request.eventName;
      case 'team':
        return due.request.teamName || '';
      case 'role':
        return slotRoleLabel(due.request.role);
      case 'hours':
        return String(due.hoursUntil);
      default:
        return match; // leave unrecognized placeholders untouched
    }
  });
}

/**
 * [§6.2, §6.6] Best-effort: for each due reminder, write ONE `shift_reminder`
 * notification to the request's own `userId` and stamp the offset into
 * `remindersSent` via `arrayUnion`. Returns how many were sent. NEVER THROWS —
 * a member whose reminder stamp is denied must still get a working dashboard.
 * Safe to call on every dashboard load; `remindersSent` makes it idempotent.
 */
export async function emitDueShiftReminders(
  due: DueShiftReminder[],
  actor?: { uid: string; name: string },
): Promise<number> {
  const config = getShiftReminderConfig();
  let sentCount = 0;
  for (const item of due) {
    if (!item.request.id) continue;
    try {
      await createNotification(
        item.request.userId,
        {
          type: 'shift_reminder',
          title: `Shift in ${item.hoursUntil} hours`,
          body: formatShiftReminder(config.template, item),
          link: '/events?event=' + item.request.eventId,
        },
        actor,
      );
      await updateDoc(doc(db, 'shift_requests', item.request.id), {
        remindersSent: arrayUnion(item.hoursBefore),
      });
      sentCount += 1;
    } catch (e) {
      console.error('emitDueShiftReminders: reminder failed for request', item.request.id, e);
    }
  }
  return sentCount;
}
