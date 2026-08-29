'use client';

/**
 * One team's slot layout within the event detail drawer: the FTO slot, the
 * EMT slots, and (member view) a single "Request FTO"/"Request EMT" control
 * shown below each role's slots when at least one slot is open and the
 * viewer is eligible. See `app/lib/events.ts` for the eligibility/placement
 * rules this defers to.
 *
 * [Phase 1 / waitlist plan §5.1] When a role has no open slot on this team,
 * `renderRequestControl` no longer bails out — it renders the waitlist
 * affordance instead (join / queued position / offer-pending / full). The
 * queue is per EVENT + ROLE by default (`policy.scope === 'event'`), so a
 * queue entry for a role is shared across every team card on the event; see
 * `queueKeyOf` (app/lib/events.ts).
 *
 * [Phase 2 / waitlist plan §5.3] `tierAccess` (resolved once in the drawer,
 * never re-derived per card) is a second gate ahead of BOTH the direct-request
 * and waitlist-join affordances — `renderRequestControl` checks it before the
 * cert-eligibility check and short-circuits with whichever disabled reason
 * applies first, tier being the coarser restriction. A manager's `tierAccess`
 * is always `eligible: true` (the bypass lives in `getTierAccess` itself), so
 * this never blocks a manager.
 */

import { useState } from 'react';
import { Button, Chip, Textarea, Tooltip } from '@heroui/react';
import { UserRound, ShieldCheck, Users, GraduationCap } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  canRequestRole,
  requestShift,
  joinWaitlist,
  leaveWaitlist,
  teamHasIntern,
  slotRoleLabel,
  isEventManagerRole,
  isSlotHeld,
  queueKeyOf,
  getWaitlistPosition,
  getShiftStartInstant,
  describeTierBlock,
  type EventActor,
  type ShiftRequester,
  type TierAccess,
} from '@/app/lib/events';
import { getWaitlistConfig, type ResolvedEventPolicy } from '@/app/config/org-config';
import { canSignUpForShifts, getShiftBlockReason } from '@/app/lib/certifications';
import type { Event, EventTeam, SlotRole, User, ShiftRequest, TeamSlot } from '@/app/types';

interface TeamCardProps {
  event: Event;
  team: EventTeam;
  userRole: string | null;
  userData: User | null;
  actorUid: string | null;
  actorName: string;
  /** The viewer's own active (pending/approved) request for this event, if any — blocks new requests. */
  myActiveRequest: ShiftRequest | undefined;
  /** All shift_requests for this event (not just the viewer's) — needed to derive queue position. */
  eventRequests: ShiftRequest[];
  /** Resolved once per drawer by resolveEventPolicy(event), not per card. */
  policy: ResolvedEventPolicy;
  /** Resolved once per drawer by getTierAccess(event, userData, viewerStats), not per card. */
  tierAccess: TierAccess;
  onRequested: () => void;
  onError: (msg: string) => void;
}

/**
 * [Phase 1 / waitlist plan §5.4] `heldBy` is manager-only decoration: an
 * outstanding offer holds a slot (`TeamSlot.heldUntil` live) without yet
 * placing anyone in it, so a plain "Open" reading could invite a manager to
 * double-book it in person. A regular member still just sees "Open".
 */
function SlotRow({ filled, name, heldBy }: { filled: boolean; name?: string; heldBy?: string }) {
  if (!filled && heldBy) {
    return (
      <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 rounded-large px-3 py-2">
        <UserRound size={14} className="text-warning flex-none" />
        <span className="text-sm font-medium text-warning">Offer pending — {heldBy}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-content2 rounded-large px-3 py-2">
      <UserRound size={14} className="text-foreground-400 flex-none" />
      <span className={`text-sm ${filled ? 'font-medium text-foreground' : 'text-foreground-400'}`}>
        {filled ? name : 'Open'}
      </span>
    </div>
  );
}

export default function TeamCard({
  event,
  team,
  userRole,
  userData,
  actorUid,
  actorName,
  myActiveRequest,
  eventRequests,
  policy,
  tierAccess,
  onRequested,
  onError,
}: TeamCardProps) {
  const [openControl, setOpenControl] = useState<{ role: SlotRole; mode: 'request' | 'waitlist' } | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** id of the shift_requests doc a queue action (prefer/leave) is in flight for. */
  const [queueActionId, setQueueActionId] = useState<string | null>(null);

  const eventOpen = event.status === 'open';
  const blockReason = getShiftBlockReason(userData);
  const canSignUp = canSignUpForShifts(userData);
  const canManage = isEventManagerRole(userRole);
  const emtFilled = team.emtSlots.filter((s) => s.userId).length;
  /**
   * [Phase 1 / waitlist plan §3.5] "Open" means open to a NEW claim, so a slot
   * soft-held by an outstanding offer (`heldUntil` still in the future) is not
   * open — `requestShift` uses exactly this definition when it decides whether
   * to create a `pending` request or a queue entry. Deriving it differently
   * here would put a primary "Request EMT" button on a held seat and then
   * silently queue whoever pressed it. An EXPIRED hold reads as open again with
   * no release write, per `TeamSlot.heldUntil`.
   */
  const slotIsOpen = (slot?: TeamSlot): boolean => !!slot && !slot.userId && !isSlotHeld(slot);
  const emtHasOpenSlot = team.emtSlots.some(slotIsOpen);
  // [P11] Member-facing waitlist copy is config, never a code literal.
  const waitlistCopy = getWaitlistConfig().copy;

  /**
   * [Phase 2 / waitlist plan §5.3] `tierAccess.eligible` is already `true`
   * unconditionally for a manager (the bypass lives in `getTierAccess`), so
   * `tierOpen` doubles as "is this event open to THIS viewer's tier" for
   * members and "always true" for managers with no separate role check here.
   */
  const tierOpen = tierAccess.eligible;
  const tierReason = tierOpen ? null : describeTierBlock(tierAccess, event);

  const heldByFor = (slot: TeamSlot): string | undefined => {
    if (!canManage || slot.userId || !isSlotHeld(slot)) return undefined;
    const held = eventRequests.find((r) => r.id === slot.requestId && r.status === 'offered');
    return held?.userName;
  };

  const buildActor = (): EventActor => ({ uid: actorUid ?? '', name: actorName, role: userRole ?? undefined });

  const submitRequest = async (role: SlotRole) => {
    if (!actorUid) return;
    setSubmitting(true);
    try {
      const requester: ShiftRequester = {
        uid: actorUid,
        name: actorName,
        role: userRole,
        certifications: userData?.certifications,
        memberStatus: userData?.memberStatus,
        joinedTerm: userData?.joinedTerm,
        // [Phase 2 / waitlist plan §3.7] These two exist ONLY so the server-side
        // tier gate in `requestShift` can evaluate `minTenureDays`,
        // `minSemesters` and `requireCommitteeMember`. Those criteria fail
        // CLOSED on a missing value, so omitting them here does not loosen the
        // gate — it locks every member out of a tenure-gated event while the
        // button beside them says they are eligible, because the UI reads the
        // full `User` and only this projection is missing the fields.
        joinedOn: userData?.joinedOn,
        isCommitteeMember: userData?.isCommitteeMember,
      };
      await requestShift(event, team.id, role, requester, { note: note || undefined });
      setOpenControl(null);
      setNote('');
      onRequested();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to request shift');
    } finally {
      setSubmitting(false);
    }
  };

  const submitWaitlist = async (role: SlotRole) => {
    if (!actorUid) return;
    setSubmitting(true);
    try {
      const requester: ShiftRequester = {
        uid: actorUid,
        name: actorName,
        role: userRole,
        certifications: userData?.certifications,
        memberStatus: userData?.memberStatus,
        joinedTerm: userData?.joinedTerm,
        // [Phase 2 / waitlist plan §3.7] These two exist ONLY so the server-side
        // tier gate in `requestShift` can evaluate `minTenureDays`,
        // `minSemesters` and `requireCommitteeMember`. Those criteria fail
        // CLOSED on a missing value, so omitting them here does not loosen the
        // gate — it locks every member out of a tenure-gated event while the
        // button beside them says they are eligible, because the UI reads the
        // full `User` and only this projection is missing the fields.
        joinedOn: userData?.joinedOn,
        isCommitteeMember: userData?.isCommitteeMember,
      };
      await joinWaitlist(event, role, requester, { note: note || undefined, preferredTeamId: team.id });
      setOpenControl(null);
      setNote('');
      onRequested();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to join waitlist');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * [Seam — see report] There is no lib helper for a single-field
   * `preferredTeamId` update (adding one to app/lib/events.ts is outside this
   * file's set), so this is a one-off write, matching the same inline
   * `updateDoc` pattern already used elsewhere in app/components (e.g.
   * onboarding-tour.tsx) for a single-field update.
   */
  const handlePreferTeam = async (entry: ShiftRequest) => {
    if (!entry.id) return;
    setQueueActionId(entry.id);
    try {
      await updateDoc(doc(db, 'shift_requests', entry.id), { preferredTeamId: team.id });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to update team preference');
    } finally {
      setQueueActionId(null);
    }
  };

  const handleLeaveWaitlist = async (entry: ShiftRequest) => {
    if (!entry.id) return;
    setQueueActionId(entry.id);
    try {
      await leaveWaitlist(entry, buildActor());
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to leave waitlist');
    } finally {
      setQueueActionId(null);
    }
  };

  /**
   * [Phase 2 / waitlist plan §5.3] The tier-blocked disabled affordance —
   * visually the exact same Tooltip+disabled-Button+reason-line pattern used
   * for a cert block below, just a different reason string and button label
   * (whichever button — direct request or waitlist join — would otherwise
   * have appeared here).
   */
  const renderTierBlocked = (buttonLabel: string, color: 'primary' | 'warning') => {
    const button = (
      <Button size="sm" variant="flat" color={color} isDisabled className="w-full mt-1.5">
        {buttonLabel}
      </Button>
    );
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        <Tooltip content={tierReason ?? ''}>{button}</Tooltip>
        <p className="text-[11px] text-warning-600 dark:text-warning-400 leading-snug">{tierReason}</p>
      </div>
    );
  };

  const renderRequestControl = (role: SlotRole, hasOpenSlot: boolean) => {
    if (!eventOpen || myActiveRequest) return null;
    if (!canRequestRole(userRole, role)) return null;

    if (hasOpenSlot) {
      // [Phase 2 / waitlist plan §5.3] Tier gate checked BEFORE the cert gate
      // below — it's the coarser restriction; no point telling someone their
      // certs are fine when the event isn't even open to them yet.
      if (!tierOpen) {
        return renderTierBlocked(`Request ${slotRoleLabel(role)}`, 'primary');
      }
      // --- Direct request — unchanged from pre-Phase-1 behavior ---
      if (openControl && openControl.role === role && openControl.mode === 'request') {
        return (
          <div className="flex flex-col gap-2 bg-content2 rounded-large p-3 mt-1.5">
            <Textarea size="sm" placeholder="Optional note" value={note} onValueChange={setNote} minRows={1} />
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="light" onPress={() => { setOpenControl(null); setNote(''); }} isDisabled={submitting}>
                Cancel
              </Button>
              <Button size="sm" color="primary" onPress={() => submitRequest(role)} isLoading={submitting}>
                Confirm
              </Button>
            </div>
          </div>
        );
      }

      const button = (
        <Button
          size="sm"
          variant="flat"
          color="primary"
          isDisabled={!canSignUp}
          onPress={() => setOpenControl({ role, mode: 'request' })}
          className="w-full mt-1.5"
        >
          Request {slotRoleLabel(role)}
        </Button>
      );

      if (!canSignUp && blockReason) {
        return (
          <div className="mt-1.5 flex flex-col gap-1">
            <Tooltip content={blockReason}>{button}</Tooltip>
            <p className="text-[11px] text-warning-600 dark:text-warning-400 leading-snug">{blockReason}</p>
          </div>
        );
      }
      return button;
    }

    // --- Waitlist branch (§5.1) ---
    if (!policy.waitlistEnabled) return null;

    const queueKey = queueKeyOf({ eventId: event.id ?? '', role, teamId: team.id }, policy);
    const myQueueEntry = eventRequests.find(
      (r) =>
        r.userId === actorUid &&
        (r.status === 'waitlisted' || r.status === 'offered') &&
        queueKeyOf(r, policy) === queueKey,
    );

    // An outstanding offer is surfaced by the offer modal/dashboard — a
    // second competing CTA here would be the failure mode to avoid.
    if (myQueueEntry && myQueueEntry.status === 'offered') return null;

    if (myQueueEntry && myQueueEntry.status === 'waitlisted') {
      const position = getWaitlistPosition(eventRequests, myQueueEntry, policy);
      // Event-scoped queue -> the chip must read as event-level ("#2 in line
      // for EMT"), never a bare position that implies a per-team queue.
      const queuedLabel = `${waitlistCopy.queuedLabel.replace('{position}', String(position))} for ${slotRoleLabel(role)}`;
      const isPreferred = myQueueEntry.preferredTeamId === team.id;
      return (
        <div className="flex flex-col gap-2 bg-content2 rounded-large p-3 mt-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip size="sm" variant="flat" color="warning">{queuedLabel}</Chip>
            {policy.honorTeamPreference !== 'ignore' &&
              (isPreferred ? (
                <span className="text-xs text-foreground-400 font-medium">Preferred</span>
              ) : (
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => handlePreferTeam(myQueueEntry)}
                  isLoading={queueActionId === myQueueEntry.id}
                >
                  Prefer this team
                </Button>
              ))}
          </div>
          {/* [§5.7] A cert that lapsed while queued doesn't auto-drop the
              entry — surface the same amber reason inline so the member
              (and, via the drawer's queue panel, a manager) can see it. */}
          {!canSignUp && blockReason && (
            <p className="text-[11px] text-warning-600 dark:text-warning-400 leading-snug">{blockReason}</p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="light"
              color="danger"
              onPress={() => handleLeaveWaitlist(myQueueEntry)}
              isLoading={queueActionId === myQueueEntry.id}
            >
              Leave waitlist
            </Button>
          </div>
        </div>
      );
    }

    // [Phase 2 / waitlist plan §5.3 T4] A member with no live queue entry yet
    // is gated the same way a direct request is — joining is a back door into
    // signup, so it can't be open before the tier is. An EXISTING entry
    // (handled above) is never affected: viewing your position or leaving the
    // queue always stays available.
    if (!tierOpen) {
      return renderTierBlocked(waitlistCopy.joinButtonLabel, 'warning');
    }

    const queueLength = eventRequests.filter(
      (r) => r.status === 'waitlisted' && queueKeyOf(r, policy) === queueKey,
    ).length;
    if (policy.maxQueueLength > 0 && queueLength >= policy.maxQueueLength) {
      return (
        <Button size="sm" variant="flat" color="warning" isDisabled className="w-full mt-1.5">
          Waitlist is full ({policy.maxQueueLength}).
        </Button>
      );
    }

    const shiftStart = getShiftStartInstant(event, policy.scope === 'team' ? team : undefined);
    if (!policy.allowQueueAfterShiftStart && shiftStart && shiftStart.getTime() <= Date.now()) {
      return null;
    }

    if (openControl && openControl.role === role && openControl.mode === 'waitlist') {
      return (
        <div className="flex flex-col gap-2 bg-content2 rounded-large p-3 mt-1.5">
          <Textarea size="sm" placeholder="Optional note" value={note} onValueChange={setNote} minRows={1} />
          {policy.scope === 'event' && (
            <p className="text-[11px] text-foreground-400 leading-snug">{waitlistCopy.preferenceHint}</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="light" onPress={() => { setOpenControl(null); setNote(''); }} isDisabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" color="warning" onPress={() => submitWaitlist(role)} isLoading={submitting}>
              Confirm
            </Button>
          </div>
        </div>
      );
    }

    const joinButton = (
      <Button
        size="sm"
        variant="flat"
        color="warning"
        isDisabled={!canSignUp}
        onPress={() => setOpenControl({ role, mode: 'waitlist' })}
        className="w-full mt-1.5"
      >
        {waitlistCopy.joinButtonLabel}
      </Button>
    );

    if (!canSignUp && blockReason) {
      return (
        <div className="mt-1.5 flex flex-col gap-1">
          <Tooltip content={blockReason}>{joinButton}</Tooltip>
          <p className="text-[11px] text-warning-600 dark:text-warning-400 leading-snug">{blockReason}</p>
        </div>
      );
    }
    return joinButton;
  };

  return (
    <div className="border border-divider rounded-large p-4 flex flex-col gap-3">
      <div className="text-sm font-semibold text-foreground">{team.name}</div>

      <div className="border border-divider rounded-large p-2.5 flex flex-col gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1">
            <ShieldCheck size={11} /> FTO
          </div>
          <SlotRow filled={!!team.ftoSlot?.userId} name={team.ftoSlot?.userName} heldBy={heldByFor(team.ftoSlot)} />
          {renderRequestControl('FTO', slotIsOpen(team.ftoSlot ?? {}))}
        </div>

        {teamHasIntern(team) && (
          <div className="pl-2.5 ml-1 border-l-2 border-divider">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1.5">
              <GraduationCap size={11} /> FTO Intern
              <span className="text-[10px] font-normal normal-case tracking-normal text-foreground-400">(supervised)</span>
            </div>
            <SlotRow
              filled={!!team.ftoInternSlot?.userId}
              name={team.ftoInternSlot?.userName}
              heldBy={heldByFor(team.ftoInternSlot ?? {})}
            />
            {renderRequestControl('FTO_INTERN', slotIsOpen(team.ftoInternSlot ?? {}))}
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1">
          <Users size={11} /> EMT ({emtFilled}/{team.emtCount})
        </div>
        <div className="flex flex-col gap-1.5">
          {team.emtSlots.map((slot, idx) => (
            <SlotRow key={idx} filled={!!slot.userId} name={slot.userName} heldBy={heldByFor(slot)} />
          ))}
        </div>
        {renderRequestControl('EMT', emtHasOpenSlot)}
      </div>
    </div>
  );
}
