'use client';

/** Right-side detail drawer for one event: identity/status header, team
 *  slots (member: request buttons; manager: also a pending-requests inbox
 *  scoped to this event), and manager actions (edit/notify/delete). */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Spinner, Textarea, Input, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@heroui/react';
import { collection, documentId, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  X,
  MapPin,
  Clock,
  CalendarDays,
  Pencil,
  Trash2,
  BellRing,
  Info,
  ClipboardCheck,
  LogOut,
  ChevronDown,
  Mail,
  Lock,
} from 'lucide-react';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import {
  subscribeEventRequests,
  approveRequest,
  rejectRequest,
  cancelRequest,
  recordAttendance,
  checkInMember,
  checkOutMember,
  endEventShifts,
  formatMemberExperience,
  slotRoleLabel,
  resolveEventPolicy,
  queueKeyOf,
  getWaitlistPosition,
  waitlistComparator,
  resolveOfferState,
  promoteNextFromWaitlist,
  sweepExpiredOffers,
  skipWaitlistEntry,
  unskipWaitlistEntry,
  removeWaitlistEntry,
  isSlotHeld,
  isCommitmentBinding,
  resolveSlotRef,
  getTierAccess,
  EMPTY_SHIFT_STATS,
  type EventActor,
  type TierAccess,
  type MemberShiftStats,
} from '@/app/lib/events';
import type { Event, EventStatus, ShiftRequest, AttendanceRecord, User, SlotRole } from '@/app/types';
import type { ResolvedEventPolicy } from '@/app/config/org-config';
import TeamCard from './team-card';
import {
  formatEventDate,
  formatTimeRange,
  toJsDate,
  eventCallDateTime,
  eventEndDateTime,
  computeMinutesLate,
  computeMinutesEarly,
  getAttendanceAccess,
  shiftHours,
  shiftRequestStatusChip,
} from './event-utils';
import PanelShell from '@/app/components/panel-shell';

const STATUS_CHIP: Record<EventStatus, { label: string; color: 'primary' | 'default' | 'danger' }> = {
  draft: { label: 'Draft', color: 'default' },
  open: { label: 'Open', color: 'primary' },
  closed: { label: 'Closed', color: 'default' },
  cancelled: { label: 'Cancelled', color: 'danger' },
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "HH:mm" for a time <input type="time"> from a Date. */
function toHHmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Combine an event's day with an arbitrary "HH:mm" string into a Date (not the event's call time). */
function combineDayAndTime(day: Date, hhmm: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** The status chips for one row's attendance state — same rendering in every mode. */
function AttendanceChips({ attendance }: { attendance?: AttendanceRecord }) {
  if (attendance?.exception) {
    return (
      <Chip size="sm" variant="flat" color={attendance.exception === 'no_show' ? 'danger' : 'default'}>
        {attendance.exception === 'no_show' ? 'No-show' : 'Excused'}
      </Chip>
    );
  }
  if (!attendance?.checkedInAt) {
    return (
      <Chip size="sm" variant="flat" color="default">
        Unrecorded
      </Chip>
    );
  }
  const arrivalDate = toJsDate(attendance.checkedInAt);
  const departureDate = toJsDate(attendance.shiftEndAt);
  const lateMinutes = attendance.minutesLate ?? 0;
  const hours = shiftHours(attendance.checkedInAt, attendance.shiftEndAt);
  return (
    <>
      <Chip size="sm" variant="flat" color="success">
        Arrived {arrivalDate ? toHHmm(arrivalDate) : ''}
      </Chip>
      {lateMinutes > 0 && (
        <Chip size="sm" variant="flat" color="warning">
          Late by {lateMinutes}m
        </Chip>
      )}
      {departureDate && (
        <Chip size="sm" variant="flat" color="default">
          Left {toHHmm(departureDate)}
        </Chip>
      )}
      {attendance.leftEarly && (
        <Chip size="sm" variant="flat" color="warning">
          {attendance.minutesEarly ? `Left early by ${attendance.minutesEarly}m` : 'Left early'}
        </Chip>
      )}
      {hours != null && (
        <Chip size="sm" variant="flat" color="default">
          {hours}h
        </Chip>
      )}
    </>
  );
}

/**
 * Mirrors `evaluateLateCancellation`'s late-window predicate (events.ts, not
 * exported) closely enough to decide whether the `mode: 'confirm'` dialog
 * should appear before `cancelRequest` is even called. The lib itself
 * re-derives and stamps the authoritative flag inside the write, so this is
 * UI-only foresight, never a duplicate of `mode: 'block'`'s enforcement —
 * that throw is surfaced through the existing toast catch instead.
 */
function isWithinCancellationNoticeWindow(request: ShiftRequest, policy: ResolvedEventPolicy): boolean {
  const cancellation = policy.cancellation;
  if (!cancellation.enabled) return false;
  const applies = cancellation.appliesTo === 'all' || isCommitmentBinding(request);
  if (!applies) return false;
  const shiftStart = toJsDate(request.shiftStartAt);
  if (!shiftStart) return false;
  const hoursUntilShift = (shiftStart.getTime() - Date.now()) / 3_600_000;
  return hoursUntilShift < cancellation.noticeHours;
}

/**
 * [Phase 2 / waitlist plan §5.3] Compact "Oct 3" inline date form for the tier
 * callout's viewer line and access-dates schedule — deliberately NOT
 * `formatEventDate` (full weekday/year), which is overkill for a list of up
 * to four dates. Mirrors the same `toLocaleDateString` call the calendar/list
 * chip's tier logic uses so all three surfaces read identically.
 */
function formatShortDate(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Compact "1h 42m" / "42m" / "Expired" countdown text for an offer's `respondBy`. */
function formatCountdown(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 'Expired';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** One `role` (or `(teamId, role)` under `scope: 'team'`) queue on the manager waitlist panel. */
interface WaitlistQueueGroup {
  key: string;
  role: SlotRole;
  /** `waitlisted` entries plus any still-live (`resolveOfferState`) `offered` entries, in queue order. */
  entries: ShiftRequest[];
  /** Teams with a genuinely open (unfilled, unheld) slot for `role` right now. */
  openTeams: { id: string; name: string }[];
}

/**
 * §5.4 — the Force-promote control. A dropdown listing every open slot across
 * teams for the row's role (member's preference sorted first by the caller),
 * degrading to a single labelled button when only one slot is open, per plan.
 */
function ForcePromoteControl({
  openTeams,
  isLoading,
  onPromote,
}: {
  openTeams: { id: string; name: string }[];
  isLoading: boolean;
  onPromote: (teamId: string, teamName: string) => void;
}) {
  if (openTeams.length === 0) {
    return (
      <Button size="sm" variant="bordered" isDisabled>
        No open slot
      </Button>
    );
  }
  if (openTeams.length === 1) {
    const team = openTeams[0];
    return (
      <Button
        size="sm"
        variant="bordered"
        color="primary"
        isLoading={isLoading}
        onPress={() => onPromote(team.id, team.name)}
      >
        Force-promote → {team.name}
      </Button>
    );
  }
  return (
    <Dropdown>
      <DropdownTrigger>
        <Button size="sm" variant="bordered" color="primary" isLoading={isLoading} endContent={<ChevronDown size={12} />}>
          Force-promote
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="Force-promote to team"
        onAction={(key) => {
          const team = openTeams.find((t) => t.id === String(key));
          if (team) onPromote(team.id, team.name);
        }}
      >
        {openTeams.map((team) => (
          <DropdownItem key={team.id}>{team.name}</DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}

interface EventDetailDrawerProps {
  event: Event;
  canManage: boolean;
  actor: EventActor;
  userData: User | null;
  /**
   * [Phase 2 / waitlist plan §3.7/§5.3] The viewer's own shift history, fed
   * straight into `getTierAccess` for the tier callout below. Optional and
   * defaulted to `EMPTY_SHIFT_STATS` so this drawer never crashes if the
   * events-page wiring for this prop lands after this file does.
   */
  viewerStats?: MemberShiftStats;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onNotify: () => void;
  onToast: (ok: boolean, msg: string) => void;
}

export default function EventDetailDrawer({
  event,
  canManage,
  actor,
  userData,
  viewerStats = EMPTY_SHIFT_STATS,
  onClose,
  onEdit,
  onDelete,
  onNotify,
  onToast,
}: EventDetailDrawerProps) {
  const [requests, setRequests] = useState<ShiftRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (!event.id) return;
    setLoadingRequests(true);
    const unsub = subscribeEventRequests(event.id, (r) => {
      setRequests(r);
      setLoadingRequests(false);
    });
    return () => unsub();
  }, [event.id]);

  // [Phase 1 / waitlist plan §3.6, §5.4] Opportunistic expiry sweep — once per
  // drawer open (guarded on event.id, NOT re-run on every onSnapshot tick from
  // the effect above), and only for managers. Completely silent: no toast, no
  // spinner. Any write it makes flows back through the subscription above and
  // re-renders the queue naturally; swallow any throw.
  const sweptEventIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canManage || !event.id) return;
    if (sweptEventIdRef.current === event.id) return;
    sweptEventIdRef.current = event.id;
    sweepExpiredOffers(event, actor).catch((e) => {
      console.error('sweepExpiredOffers failed:', e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, canManage]);

  /** §4.3 — resolved once per event so every TeamCard and the waitlist panel agree on scope/notice/cancellation policy. */
  const policy = useMemo(() => resolveEventPolicy(event), [event]);

  /**
   * [Phase 2 / waitlist plan §3.7/§5.3] Resolved once per drawer, exactly like
   * `policy` above, so every `TeamCard` on this event agrees on the same
   * eligibility read instead of each card re-deriving it against a slightly
   * different `now`.
   */
  const tierAccess: TierAccess = useMemo(
    () => getTierAccess(event, userData, viewerStats),
    [event, userData, viewerStats],
  );
  const tierGeneralOpensAt = useMemo(
    () => toJsDate(event.accessTier?.generalOpensAt),
    [event.accessTier?.generalOpensAt],
  );
  // Rendered whenever the event is tiered AND general access hasn't opened
  // yet — for EVERY viewer, managers included (§5.7): visibility of the
  // policy is unconditional, only the button gating (team-card.tsx) bypasses
  // for a manager.
  const showTierCallout =
    !!event.accessTier?.enabled && !!tierGeneralOpensAt && Date.now() < tierGeneralOpensAt.getTime();
  const tierWindowsSorted = useMemo(() => {
    const tiers = event.accessTier?.tiers ?? [];
    return [...tiers].sort((a, b) => {
      const da = toJsDate(a.opensAt)?.getTime() ?? Infinity;
      const db = toJsDate(b.opensAt)?.getTime() ?? Infinity;
      return da - db;
    });
  }, [event.accessTier?.tiers]);
  // "See all access dates" disclosure — collapsed by default (§5.3): the
  // viewer-specific line above it already answers the one question most
  // members have, so the full schedule is opt-in detail.
  const [showTierSchedule, setShowTierSchedule] = useState(false);

  // [Phase 0 / waitlist plan §2.1] Widened beyond pending/approved — a member
  // with a live waitlisted or offered entry must see IT as their request (and
  // the offer-response affordance, once Phase 1 adds it), not an "Request a
  // slot" button that would create a duplicate. This is also the value the
  // offer-response modal (§5.2) will key off.
  const myActiveRequest = useMemo(
    () =>
      requests.find(
        (r) =>
          r.userId === actor.uid &&
          (r.status === 'pending' || r.status === 'approved' || r.status === 'waitlisted' || r.status === 'offered'),
      ),
    [requests, actor.uid],
  );
  const pending = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);
  const approved = useMemo(() => requests.filter((r) => r.status === 'approved'), [requests]);
  // [Phase 0 / waitlist plan §2.1] `waitlisted`/`offered` entries deliberately
  // do NOT get folded into `pending` or `approved` above — they need a
  // separate queue panel (§5.4) with different actions (promote/extend vs.
  // approve/reject). Not built in Phase 0 (no such docs exist yet); this
  // comment exists so nobody "fixes" the two filters above into `!==
  // 'rejected' && !== 'cancelled'` and silently lands queue entries in the
  // approve/reject inbox.

  /**
   * Whether the viewer's OWN approved request already has a check-in stamp.
   * [Phase 0 / waitlist plan §2.1] `=== 'approved'` here is correct as-is —
   * only an approved seat can ever be checked in, so widening `myActiveRequest`
   * above to include waitlisted/offered doesn't change this gate.
   */
  const viewerCheckedIn = !!(myActiveRequest?.status === 'approved' && myActiveRequest.attendance?.checkedInAt);

  const access = useMemo(
    () =>
      getAttendanceAccess({
        event,
        viewerRole: userData?.role,
        viewerUid: actor.uid,
        viewerCheckedIn,
      }),
    [event, userData?.role, actor.uid, viewerCheckedIn],
  );

  /** Approved requests scoped to what this viewer may see, with the viewer's own
   *  row sorted to the top when they're gated on checking themselves in first. */
  const scopedApproved = useMemo(() => {
    const list =
      access.scopeTeamIds == null ? approved : approved.filter((r) => access.scopeTeamIds!.includes(r.teamId));
    if (!access.gatedOnSelfCheckIn) return list;
    return [...list].sort((a, b) => {
      const aSelf = a.userId === actor.uid ? 0 : 1;
      const bSelf = b.userId === actor.uid ? 0 : 1;
      return aSelf - bSelf;
    });
  }, [access, approved, actor.uid]);

  const [arrivalDrafts, setArrivalDrafts] = useState<Record<string, string>>({});
  const [departureDrafts, setDepartureDrafts] = useState<Record<string, string>>({});
  const [attendanceSavingId, setAttendanceSavingId] = useState<string | null>(null);
  const [endingShifts, setEndingShifts] = useState(false);

  // [Phase 1 / waitlist plan §5.4] Manager waitlist queue panel state.
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [skippingId, setSkippingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [emailingQueue, setEmailingQueue] = useState(false);
  const { notificationDelivery } = useOrgConfig();
  // Ticks the offer countdown chips / re-evaluates resolveOfferState while any
  // offer is live, so the panel doesn't freeze a stale "expires in" reading
  // between Firestore snapshot updates. Cosmetic only — the real expiry
  // enforcement is the sweep effect + resolveOfferState, not this timer.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!canManage) return;
    if (!requests.some((r) => r.status === 'offered')) return;
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [canManage, requests]);

  type MobilePage = 'details' | 'teams' | 'waitlist' | 'attendance' | 'requests';
  const [mobilePage, setMobilePage] = useState<MobilePage>('details');

  const eventDay = useMemo(() => toJsDate(event.date), [event.date]);
  const callDateTime = useMemo(() => eventCallDateTime(event), [event]);
  const endDateTime = useMemo(() => eventEndDateTime(event), [event]);

  /** The "Arrived at" time input value: the in-progress edit, else the existing check-in, else now. */
  const getArrivalDraft = (req: ShiftRequest): string => {
    if (req.id && arrivalDrafts[req.id] !== undefined) return arrivalDrafts[req.id];
    const existing = toJsDate(req.attendance?.checkedInAt);
    return toHHmm(existing ?? new Date());
  };

  /** The "Left at" time input value: the in-progress edit, else the existing departure, else now. */
  const getDepartureDraft = (req: ShiftRequest): string => {
    if (req.id && departureDrafts[req.id] !== undefined) return departureDrafts[req.id];
    const existing = toJsDate(req.attendance?.shiftEndAt);
    return toHHmm(existing ?? new Date());
  };

  const handleCheckIn = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      const { minutesLate } = await checkInMember(event, req, actor);
      onToast(true, `${req.userName} checked in${minutesLate > 0 ? ` — late by ${minutesLate}m` : ''}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to check in');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleCheckOut = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      const { leftEarly, minutesEarly } = await checkOutMember(event, req, actor);
      onToast(true, `${req.userName} checked out${leftEarly ? ` — left ${minutesEarly}m early` : ''}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to check out');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  /** Manager-only retro-edit: save both time inputs at once, recomputing the derived snapshots. */
  const handleSaveRetro = async (req: ShiftRequest) => {
    if (!req.id || !eventDay) return;
    const arrival = combineDayAndTime(eventDay, getArrivalDraft(req));
    if (!arrival) {
      onToast(false, 'Enter a valid arrival time');
      return;
    }
    const departure = combineDayAndTime(eventDay, getDepartureDraft(req));
    setAttendanceSavingId(req.id);
    try {
      const minutesLate = computeMinutesLate(arrival, callDateTime);
      const patch: Parameters<typeof recordAttendance>[1] = { checkedInAt: arrival, minutesLate };
      if (departure) {
        const minutesEarly = computeMinutesEarly(departure, endDateTime);
        const leftEarly = minutesEarly > 0;
        patch.shiftEndAt = departure;
        patch.leftEarly = leftEarly;
        patch.minutesEarly = leftEarly ? minutesEarly : undefined;
      }
      await recordAttendance(req, patch, actor);
      onToast(true, `${req.userName}: attendance updated`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to save attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleSetException = async (req: ShiftRequest, exception: 'no_show' | 'excused') => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      await recordAttendance(req, { exception }, actor);
      onToast(true, `${req.userName}: ${exception === 'no_show' ? 'No-show' : 'Excused'}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to record attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleClearAttendance = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      await recordAttendance(req, { checkedInAt: null, exception: null }, actor);
      onToast(true, `${req.userName}: cleared`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to clear attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleEndShifts = async () => {
    if (!event.id) return;
    setEndingShifts(true);
    try {
      // An assigned FTO ends only their own team's shifts; managers (null scope) sweep the event.
      const count = await endEventShifts(event.id, actor, access.scopeTeamIds);
      onToast(true, count > 0 ? `Ended ${count} shift${count === 1 ? '' : 's'}` : 'No checked-in shifts to end');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to end shifts');
    } finally {
      setEndingShifts(false);
    }
  };

  const handleApprove = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await approveRequest(req, actor);
      onToast(true, `Approved ${req.userName} for ${req.teamName} · ${req.role}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to approve request');
    } finally {
      setDecidingId(null);
    }
  };

  const handleReject = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await rejectRequest(req, actor, rejectReason || undefined);
      onToast(true, `Rejected ${req.userName}'s request`);
      setRejectingId(null);
      setRejectReason('');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to reject request');
    } finally {
      setDecidingId(null);
    }
  };

  /**
   * [Phase 1 / waitlist plan §3.4] `mode: 'block'` is enforced inside
   * `cancelRequest` itself (it throws) — that error surfaces through the
   * ordinary catch/toast below, never duplicated here. `mode: 'confirm'`
   * (the default) is a UI-only gate: when the cancellation falls inside the
   * notice window for a binding request, show the config-sourced
   * `memberMessage` before calling through. `{hours}` is the only
   * interpolation token the copy defines (P11 — this text must come from
   * config, never a literal).
   */
  const handleWithdraw = async () => {
    if (!myActiveRequest) return;
    if (
      (myActiveRequest.status === 'offered' || myActiveRequest.status === 'approved') &&
      policy.cancellation.mode === 'confirm' &&
      isWithinCancellationNoticeWindow(myActiveRequest, policy)
    ) {
      const message = policy.cancellation.memberMessage.replace(
        '{hours}',
        String(policy.cancellation.noticeHours),
      );
      if (!window.confirm(message)) return;
    }
    try {
      await cancelRequest(myActiveRequest, actor, event);
      onToast(true, 'Request withdrawn');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to withdraw request');
    }
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${event.name}"? This cannot be undone.`)) return;
    onDelete();
  };

  // [Phase 1 / waitlist plan §5.4] Manager waitlist queue panel — grouped by
  // `queueKeyOf` (role alone under the default `scope: 'event'`, `(teamId,
  // role)` under the legacy `scope: 'team'` opt-in) so this can never drift
  // from the promotion path's own grouping.
  const waitlistGroups = useMemo<WaitlistQueueGroup[]>(() => {
    if (!canManage) return [];
    const now = new Date(nowTick);
    // Only still-live offers count — a stale, unswept `offered` doc past its
    // respondBy reads as `resolveOfferState(...) === 'expired'` and is
    // dropped here rather than shown as an active queue row.
    const relevant = requests.filter((r) => {
      if (r.status === 'waitlisted') return true;
      if (r.status === 'offered') return resolveOfferState(r, now) === 'offered';
      return false;
    });
    const byKey = new Map<string, ShiftRequest[]>();
    for (const r of relevant) {
      const key = queueKeyOf(r, policy);
      const list = byKey.get(key);
      if (list) list.push(r);
      else byKey.set(key, [r]);
    }
    const groups: WaitlistQueueGroup[] = [];
    for (const [key, entries] of byKey) {
      entries.sort(waitlistComparator);
      const role = entries[0].role;
      const scopeTeamId = policy.scope === 'team' ? entries[0].teamId : undefined;
      const openTeams = (event.teams || [])
        .filter((team) => (scopeTeamId ? team.id === scopeTeamId : true))
        .filter((team) => {
          const ref = resolveSlotRef(team, role);
          return !!ref && !ref.slot.userId && !isSlotHeld(ref.slot, now);
        })
        .map((team) => ({ id: team.id, name: team.name }));
      groups.push({ key, role, entries, openTeams });
    }
    return groups.sort((a, b) => a.role.localeCompare(b.role));
  }, [requests, policy, event.teams, canManage, nowTick]);

  const hasAnyWaitlistEntries = waitlistGroups.some((g) => g.entries.length > 0);
  const totalWaitlistCount = waitlistGroups.reduce((sum, g) => sum + g.entries.length, 0);

  const handleForcePromote = async (req: ShiftRequest, teamId: string, teamName: string) => {
    if (!req.id) return;
    setPromotingId(req.id);
    try {
      await promoteNextFromWaitlist(event, teamId, req.role, actor, { force: true, requestId: req.id });
      onToast(true, `${req.userName} force-promoted to ${teamName}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to force-promote');
    } finally {
      setPromotingId(null);
    }
  };

  const handleToggleSkip = async (req: ShiftRequest) => {
    if (!req.id) return;
    setSkippingId(req.id);
    try {
      if (req.skippedAt) {
        await unskipWaitlistEntry(req, actor);
        onToast(true, `${req.userName}: restored to queue position`);
      } else {
        await skipWaitlistEntry(req, actor);
        onToast(true, `${req.userName}: skipped`);
      }
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to update queue entry');
    } finally {
      setSkippingId(null);
    }
  };

  const handleRemoveWaitlistEntry = async (req: ShiftRequest) => {
    if (!req.id) return;
    setRemovingId(req.id);
    try {
      await removeWaitlistEntry(req, actor);
      onToast(true, `${req.userName} removed from the queue`);
      setRemoveConfirmId(null);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to remove from queue');
    } finally {
      setRemovingId(null);
    }
  };

  /**
   * [Phase 1 / waitlist plan §6.3/§6.4] "Email the queue" — the zero-
   * infrastructure mitigation for a short-notice offer: a human with a phone
   * still beats every automated channel for a two-hour window, and this app
   * is a static export with no mail server, so the only channel available is
   * the manager's own mail client via `mailto:`. Addresses go in `bcc` and
   * `to` is left empty — a volunteer roster's email addresses must never be
   * exposed to every other recipient. `ShiftRequest` doesn't carry an email
   * (only `userId`/`userName`), so it's fetched here, on press, from `users`.
   */
  const handleEmailQueue = async () => {
    if (emailingQueue) return;
    setEmailingQueue(true);
    try {
      const userIds = Array.from(
        new Set(waitlistGroups.flatMap((g) => g.entries.map((e) => e.userId)).filter(Boolean)),
      );
      const emails: string[] = [];
      for (let i = 0; i < userIds.length; i += 30) {
        const chunk = userIds.slice(i, i + 30);
        const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
        snap.docs.forEach((d) => {
          const email = (d.data() as { email?: string }).email;
          if (email) emails.push(email);
        });
      }
      const skipped = userIds.length - emails.length;
      if (emails.length === 0) {
        onToast(false, 'No one on the waitlist has an email on file');
        return;
      }
      const subject = `${event.name} — shift slot available`;
      const when = [formatEventDate(event.date), formatTimeRange(event.callTime, event.endTime)]
        .filter(Boolean)
        .join(' · ');
      const body = `A slot has opened up for ${event.name}${when ? ` (${when})` : ''}. Open the app to claim it — first to respond gets the spot.`;
      const url = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = url;
      if (skipped > 0) {
        onToast(true, `Opened your mail client for ${emails.length} — skipped ${skipped} with no email on file`);
      }
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to email the queue');
    } finally {
      setEmailingQueue(false);
    }
  };

  const statusChip = STATUS_CHIP[event.status];

  const mobileSections = useMemo(() => {
    const sections: { key: MobilePage; label: string; badge?: number }[] = [];
    if (event.description || myActiveRequest) sections.push({ key: 'details', label: 'Details' });
    sections.push({ key: 'teams', label: 'Teams' });
    if (canManage && hasAnyWaitlistEntries) {
      sections.push({ key: 'waitlist', label: 'Waitlist', badge: totalWaitlistCount || undefined });
    }
    if (access.visible) sections.push({ key: 'attendance', label: 'Attendance' });
    if (canManage) sections.push({ key: 'requests', label: 'Requests', badge: pending.length || undefined });
    return sections;
  }, [event.description, myActiveRequest, canManage, hasAnyWaitlistEntries, totalWaitlistCount, access.visible, pending.length]);

  useEffect(() => {
    if (mobileSections.length > 0 && !mobileSections.some((s) => s.key === mobilePage)) {
      setMobilePage(mobileSections[0].key);
    }
  }, [mobileSections, mobilePage]);

  return (
    <PanelShell isOpen onClose={onClose} ariaLabel="Event detail" widthClass="w-full md:w-[560px] md:max-w-[94vw]" forceMode="modal">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex-none">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-lg text-foreground leading-tight">{event.name}</div>
              {event.eventType && <div className="text-xs text-foreground-500 mt-0.5">{event.eventType}</div>}
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex gap-1.5 flex-wrap mt-3">
            <Chip size="sm" variant="flat" color={statusChip.color}>
              {statusChip.label}
            </Chip>
            {canManage && pending.length > 0 && (
              <Chip size="sm" variant="flat" color="danger">
                {pending.length} pending
              </Chip>
            )}
          </div>

          {/* [Phase 2 / waitlist plan §5.3] Tier callout — first thing a
              viewer sees on open, ahead of the team slots, so a member hits
              the explanation before they hit the restriction. */}
          {showTierCallout && (
            <div className="bg-secondary-50 dark:bg-secondary-900/20 border border-secondary/30 rounded-large p-3 mt-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Lock size={13} className="text-secondary flex-none" />
                Priority access window
              </div>
              {event.accessTier?.rationale && (
                <p className="text-xs text-foreground-500 mt-1">{event.accessTier.rationale}</p>
              )}
              <p
                className={`text-sm font-medium mt-2 ${
                  tierAccess.eligible ? 'text-success-600 dark:text-success-400' : 'text-foreground-600'
                }`}
              >
                {tierAccess.eligible
                  ? '✓ Open to you now'
                  : tierAccess.opensForYouAt
                    ? `You can sign up from ${formatShortDate(tierAccess.opensForYouAt)}${
                        tierAccess.matchedTier ? ` (${tierAccess.matchedTier.label})` : ''
                      }`
                    : `Opens to everyone ${formatShortDate(tierGeneralOpensAt)}`}
              </p>
              <button
                type="button"
                onClick={() => setShowTierSchedule((v) => !v)}
                className="text-xs text-secondary hover:underline mt-2 inline-flex items-center gap-1"
              >
                {showTierSchedule ? 'Hide access dates' : 'See all access dates'}
                <ChevronDown
                  size={11}
                  className={`transition-transform ${showTierSchedule ? 'rotate-180' : ''}`}
                />
              </button>
              {showTierSchedule && (
                <div className="flex flex-col gap-1 mt-2">
                  {/* [§5.3] Windows already passed render struck-through/muted,
                      never hidden, so the schedule doesn't silently reorder
                      under a member who reopens the drawer later. */}
                  {tierWindowsSorted.map((w) => {
                    const opensAt = toJsDate(w.opensAt);
                    const passed = !!opensAt && opensAt.getTime() <= Date.now();
                    return (
                      <div
                        key={w.id}
                        className={`text-xs flex items-center gap-2 ${
                          passed ? 'line-through text-foreground-400' : 'text-foreground-500'
                        }`}
                      >
                        <span className="font-mono w-12 flex-none">{formatShortDate(opensAt)}</span>
                        <span>{w.label}</span>
                      </div>
                    );
                  })}
                  {tierGeneralOpensAt && (
                    <div
                      className={`text-xs flex items-center gap-2 ${
                        Date.now() >= tierGeneralOpensAt.getTime()
                          ? 'line-through text-foreground-400'
                          : 'text-foreground-500'
                      }`}
                    >
                      <span className="font-mono w-12 flex-none">{formatShortDate(tierGeneralOpensAt)}</span>
                      <span>Everyone</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5 text-sm text-foreground-500 mt-3">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays size={13} /> {formatEventDate(event.date)}
            </span>
            {formatTimeRange(event.callTime, event.endTime) && (
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} /> {formatTimeRange(event.callTime, event.endTime)}
              </span>
            )}
            {(event.venue || event.location) && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={13} /> {[event.venue, event.location].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>

          {canManage && (
            <div className="flex gap-2 flex-wrap mt-4">
              <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={onEdit}>
                Edit
              </Button>
              {event.status === 'open' && (
                <Button size="sm" variant="bordered" startContent={<BellRing size={14} />} onPress={onNotify}>
                  {event.notified ? 'Notify again' : 'Notify members'}
                </Button>
              )}
              <Button size="sm" variant="bordered" color="danger" startContent={<Trash2 size={14} />} onPress={handleDelete}>
                Delete
              </Button>
            </div>
          )}
        </div>

        {/* Mobile page switcher — real tabs, not faint pills: equal-width targets,
            a primary label and a solid underline on the active one so it's obvious
            at a glance which section you're looking at. */}
        {mobileSections.length > 1 && (
          <div className="md:hidden flex border-b border-divider bg-content1 flex-none" role="tablist">
            {mobileSections.map((s) => {
              const active = mobilePage === s.key;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMobilePage(s.key)}
                  className={`relative flex-1 min-w-0 px-1 pt-3 pb-2.5 text-[12.5px] font-semibold transition-colors duration-150 ${
                    active ? 'text-primary' : 'text-foreground-400 active:text-foreground-600'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1 truncate">
                    <span className="truncate">{s.label}</span>
                    {s.badge ? (
                      <span className="flex-none min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold leading-4">
                        {s.badge}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`absolute left-2.5 right-2.5 bottom-0 h-[3px] rounded-t-full transition-opacity duration-150 ${
                      active ? 'bg-primary opacity-100' : 'opacity-0'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {(event.description || myActiveRequest) && (
            <div className={mobilePage === 'details' ? 'block' : 'hidden md:block'}>
              <div className="flex flex-col gap-5">
                {event.description && <p className="text-sm text-foreground-600 whitespace-pre-wrap">{event.description}</p>}

                {myActiveRequest && (
                  <div className="bg-content2 rounded-large p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">
                        Your request
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {myActiveRequest.teamName} · {slotRoleLabel(myActiveRequest.role)}
                      </div>
                      {/* [Phase 0 / waitlist plan §2.1] Extended from a binary
                          approved/pending chip via the shared status→chip map
                          so waitlisted/offered/declined/expired render neutral
                          labels instead of falling into the amber "Requested"
                          bucket. Phase 1 owns richer copy (queue position,
                          offer countdown). */}
                      <Chip
                        size="sm"
                        variant="flat"
                        color={shiftRequestStatusChip(myActiveRequest.status).color}
                        className="mt-1.5"
                      >
                        {shiftRequestStatusChip(myActiveRequest.status).label}
                      </Chip>
                    </div>
                    <Button size="sm" variant="bordered" color="danger" onPress={handleWithdraw}>
                      Withdraw
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className={mobilePage === 'teams' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Teams</div>
              {(event.teams || []).map((team) => (
                <TeamCard
                  key={team.id}
                  event={event}
                  team={team}
                  userRole={userData?.role ?? null}
                  userData={userData}
                  actorUid={actor.uid}
                  actorName={actor.name}
                  myActiveRequest={myActiveRequest}
                  eventRequests={requests}
                  policy={policy}
                  tierAccess={tierAccess}
                  onRequested={() => onToast(true, 'Request sent')}
                  onError={(msg) => onToast(false, msg)}
                />
              ))}
            </div>
          </div>

          {/* [Phase 1 / waitlist plan §5.4] Manager waitlist queue panel — desktop
              order is deliberate: Teams (confirmed) -> Waitlist (queued) ->
              Attendance (showed up). Omitted entirely (not an empty-state card)
              when the event has no waitlist activity at all (§5.7) — this is a
              manager convenience panel, not a page members expect to always see. */}
          {canManage && hasAnyWaitlistEntries && (
            <div className={mobilePage === 'waitlist' ? 'block' : 'hidden md:block'}>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                    Waitlist queue
                  </div>
                  {notificationDelivery.allowManagerMailto && (
                    <Button
                      size="sm"
                      variant="light"
                      startContent={<Mail size={13} />}
                      onPress={handleEmailQueue}
                      isLoading={emailingQueue}
                    >
                      Email the queue
                    </Button>
                  )}
                </div>

                {policy.autoPromote === false && (
                  <div className="text-xs text-warning-600 bg-warning-50 dark:bg-warning-900/20 rounded-medium px-2.5 py-1.5 inline-flex items-start gap-1.5">
                    <Info size={12} className="mt-0.5 flex-none" />
                    Auto-promotion is off for this event — freed slots wait for you.
                  </div>
                )}

                {(!event.callTime || event.needsCallTime) && (
                  <div className="text-xs text-warning-600 bg-warning-50 dark:bg-warning-900/20 rounded-medium px-2.5 py-1.5 flex items-center justify-between gap-2 flex-wrap">
                    <span className="inline-flex items-start gap-1.5">
                      <Info size={12} className="mt-0.5 flex-none" /> Needs a call time before offers can be sent
                    </span>
                    <Button size="sm" variant="light" onPress={onEdit}>
                      Add call time
                    </Button>
                  </div>
                )}

                <div className="flex flex-col gap-4">
                  {waitlistGroups.map((group) => {
                    if (group.entries.length === 0) return null;
                    const now = new Date(nowTick);
                    const openSlotsLabel =
                      group.openTeams.length === 0
                        ? '0 open slots'
                        : group.openTeams.length === 1
                          ? `1 open slot — ${group.openTeams[0].name}`
                          : `${group.openTeams.length} open slots across ${group.openTeams.length} teams`;
                    return (
                      <div key={group.key} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground">{slotRoleLabel(group.role)}</span>
                          <span className="text-xs text-foreground-500">
                            {group.entries.length} waiting · {openSlotsLabel}
                          </span>
                        </div>
                        <div className="flex flex-col gap-2">
                          {group.entries.map((entry) => {
                            const liveStatus = resolveOfferState(entry, now);
                            const isOffered = liveStatus === 'offered';
                            const position = getWaitlistPosition(requests, entry, policy);
                            const experience = formatMemberExperience(entry.memberStatus, entry.joinedTerm);
                            const preferredTeamName = entry.preferredTeamId
                              ? (event.teams || []).find((t) => t.id === entry.preferredTeamId)?.name
                              : undefined;
                            const orderedOpenTeams = entry.preferredTeamId
                              ? [...group.openTeams].sort((a, b) =>
                                  a.id === entry.preferredTeamId ? -1 : b.id === entry.preferredTeamId ? 1 : 0,
                                )
                              : group.openTeams;
                            const respondBy = isOffered ? toJsDate(entry.offer?.respondBy) : null;

                            return (
                              <div key={entry.id} className="border border-divider rounded-large p-3 flex flex-col gap-2">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-foreground flex items-center gap-1.5 flex-wrap">
                                    <span className="text-foreground-400 font-mono text-xs">#{position}</span>
                                    {entry.userName}
                                    {entry.skippedAt && (
                                      <Chip size="sm" variant="flat" color="default">
                                        Skipped
                                      </Chip>
                                    )}
                                    {isOffered && (
                                      <Chip size="sm" variant="flat" color="primary">
                                        Offered {entry.offer?.teamName}
                                      </Chip>
                                    )}
                                  </div>
                                  <div className="text-xs text-foreground-500 mt-0.5">{experience}</div>
                                  {policy.honorTeamPreference !== 'ignore' && (
                                    <div className="text-xs text-foreground-400 mt-0.5">
                                      {preferredTeamName ? `prefers ${preferredTeamName}` : 'no preference'}
                                    </div>
                                  )}
                                  {isOffered && respondBy && (
                                    <div className="text-xs text-warning-600 mt-1">
                                      expires in {formatCountdown(respondBy, now)}
                                    </div>
                                  )}
                                </div>

                                <div className="flex gap-2 justify-end flex-wrap">
                                  {removeConfirmId === entry.id ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="light"
                                        onPress={() => setRemoveConfirmId(null)}
                                        isDisabled={removingId === entry.id}
                                      >
                                        Cancel
                                      </Button>
                                      <Button
                                        size="sm"
                                        color="danger"
                                        onPress={() => handleRemoveWaitlistEntry(entry)}
                                        isLoading={removingId === entry.id}
                                      >
                                        Confirm remove
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      {entry.status === 'waitlisted' && (
                                        <Button
                                          size="sm"
                                          variant="light"
                                          onPress={() => handleToggleSkip(entry)}
                                          isLoading={skippingId === entry.id}
                                        >
                                          {entry.skippedAt ? 'Unskip' : 'Skip'}
                                        </Button>
                                      )}
                                      <Button
                                        size="sm"
                                        variant="bordered"
                                        color="danger"
                                        onPress={() => setRemoveConfirmId(entry.id ?? null)}
                                      >
                                        Remove
                                      </Button>
                                      <ForcePromoteControl
                                        openTeams={orderedOpenTeams}
                                        isLoading={promotingId === entry.id}
                                        onPromote={(teamId, teamName) => handleForcePromote(entry, teamId, teamName)}
                                      />
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {access.visible && (
            <div className={mobilePage === 'attendance' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 inline-flex items-center gap-1.5">
                  <ClipboardCheck size={11} /> Attendance
                </div>
                {access.canRecordLive && (
                  <Button
                    size="sm"
                    variant="light"
                    startContent={<LogOut size={13} />}
                    onPress={handleEndShifts}
                    isLoading={endingShifts}
                    isDisabled={scopedApproved.length === 0}
                  >
                    End shift
                  </Button>
                )}
              </div>

              {access.mode === 'read-only' && access.reason && (
                <p className="text-xs text-foreground-400">{access.reason}</p>
              )}
              {access.gatedOnSelfCheckIn && access.reason && (
                <div className="text-xs text-warning-600 bg-warning-50 dark:bg-warning-900/20 rounded-medium px-2.5 py-1.5 inline-flex items-start gap-1.5">
                  <Info size={12} className="mt-0.5 flex-none" /> {access.reason}
                </div>
              )}

              {loadingRequests ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : scopedApproved.length === 0 ? (
                <p className="text-sm text-foreground-400">No confirmed members yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {scopedApproved.map((req) => {
                    const attendance = req.attendance;
                    const checkedIn = !!attendance?.checkedInAt && !attendance?.exception;
                    const hasEnded = checkedIn && !!attendance?.shiftEndAt;
                    const saving = attendanceSavingId === req.id;
                    const isSelf = req.userId === actor.uid;
                    const gatedOut = access.gatedOnSelfCheckIn && !isSelf;
                    const disabled = saving || gatedOut;

                    return (
                      <div
                        key={req.id}
                        data-testid={`attendance-row-${req.userId}`}
                        className={`border rounded-large p-3 flex flex-col gap-2.5 ${
                          access.gatedOnSelfCheckIn && isSelf
                            ? 'border-primary bg-primary-50/50 dark:bg-primary-900/10'
                            : 'border-divider'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-foreground truncate inline-flex items-center gap-1.5">
                              {req.userName}
                              {access.gatedOnSelfCheckIn && isSelf && (
                                <Chip size="sm" variant="flat" color="primary" className="h-4 text-[10px] px-1.5">
                                  You
                                </Chip>
                              )}
                            </div>
                            <div className="text-xs text-foreground-500">
                              {req.teamName} · {slotRoleLabel(req.role)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-none flex-wrap justify-end">
                            <AttendanceChips attendance={attendance} />
                          </div>
                        </div>

                        {access.mode === 'live' && (
                          <div className="flex items-end gap-2 flex-wrap">
                            {!checkedIn && !attendance?.exception && (
                              <>
                                <Button
                                  size="sm"
                                  color="primary"
                                  variant="flat"
                                  onPress={() => handleCheckIn(req)}
                                  isLoading={saving}
                                  isDisabled={gatedOut}
                                >
                                  Check in
                                </Button>
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  color="danger"
                                  onPress={() => handleSetException(req, 'no_show')}
                                  isDisabled={disabled}
                                >
                                  No-show
                                </Button>
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  onPress={() => handleSetException(req, 'excused')}
                                  isDisabled={disabled}
                                >
                                  Excused
                                </Button>
                              </>
                            )}
                            {checkedIn && !hasEnded && (
                              <Button
                                size="sm"
                                variant="bordered"
                                onPress={() => handleCheckOut(req)}
                                isLoading={saving}
                                isDisabled={gatedOut}
                              >
                                Check out
                              </Button>
                            )}
                            {access.canClear && (checkedIn || attendance?.exception) && (
                              <Button size="sm" variant="light" onPress={() => handleClearAttendance(req)} isDisabled={disabled}>
                                Clear
                              </Button>
                            )}
                          </div>
                        )}

                        {access.mode === 'retro-edit' && (
                          <div className="flex items-end gap-2 flex-wrap">
                            <Input
                              size="sm"
                              type="time"
                              label="Arrived at"
                              className="w-32"
                              value={getArrivalDraft(req)}
                              onValueChange={(v) => req.id && setArrivalDrafts((prev) => ({ ...prev, [req.id!]: v }))}
                              isDisabled={saving}
                            />
                            <Input
                              size="sm"
                              type="time"
                              label="Left at"
                              className="w-32"
                              value={getDepartureDraft(req)}
                              onValueChange={(v) => req.id && setDepartureDrafts((prev) => ({ ...prev, [req.id!]: v }))}
                              isDisabled={saving}
                            />
                            <Button size="sm" variant="bordered" onPress={() => handleSaveRetro(req)} isLoading={saving}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant={attendance?.exception === 'no_show' ? 'solid' : 'bordered'}
                              color="danger"
                              onPress={() => handleSetException(req, 'no_show')}
                              isDisabled={saving}
                            >
                              No-show
                            </Button>
                            <Button
                              size="sm"
                              variant={attendance?.exception === 'excused' ? 'solid' : 'bordered'}
                              onPress={() => handleSetException(req, 'excused')}
                              isDisabled={saving}
                            >
                              Excused
                            </Button>
                            {access.canClear && (
                              <Button size="sm" variant="light" onPress={() => handleClearAttendance(req)} isDisabled={saving}>
                                Clear
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </div>
          )}

          {canManage && (
            <div className={mobilePage === 'requests' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Pending requests</div>
              {loadingRequests ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : pending.length === 0 ? (
                <p className="text-sm text-foreground-400">No pending requests for this event.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {pending.map((req) => (
                    <div key={req.id} className="border border-divider rounded-large p-3 flex flex-col gap-2">
                      <div>
                        <div className="text-sm font-semibold text-foreground">{req.userName}</div>
                        <div className="text-xs text-foreground-500">
                          {req.teamName} · {slotRoleLabel(req.role)} · {formatMemberExperience(req.memberStatus, req.joinedTerm)}
                        </div>
                      </div>
                      {req.note && (
                        <div className="text-xs text-foreground-500 bg-content2 rounded-medium px-2 py-1.5 inline-flex items-start gap-1.5">
                          <Info size={12} className="mt-0.5 flex-none" /> {req.note}
                        </div>
                      )}
                      {rejectingId === req.id ? (
                        <div className="flex flex-col gap-2">
                          <Textarea
                            size="sm"
                            placeholder="Reason (optional)"
                            value={rejectReason}
                            onValueChange={setRejectReason}
                            minRows={1}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button size="sm" variant="light" onPress={() => setRejectingId(null)} isDisabled={decidingId === req.id}>
                              Cancel
                            </Button>
                            <Button size="sm" color="danger" onPress={() => handleReject(req)} isLoading={decidingId === req.id}>
                              Confirm reject
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            variant="bordered"
                            color="danger"
                            onPress={() => setRejectingId(req.id ?? null)}
                            isDisabled={decidingId === req.id}
                          >
                            Reject
                          </Button>
                          <Button size="sm" color="primary" onPress={() => handleApprove(req)} isLoading={decidingId === req.id}>
                            Approve
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>
          )}
        </div>
    </PanelShell>
  );
}
