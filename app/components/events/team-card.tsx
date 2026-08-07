'use client';

/**
 * One team's slot layout within the event detail drawer: the FTO slot, the
 * EMT slots, and (member view) a single "Request FTO"/"Request EMT" control
 * shown below each role's slots when at least one slot is open and the
 * viewer is eligible. See `app/lib/events.ts` for the eligibility/placement
 * rules this defers to.
 */

import { useState } from 'react';
import { Button, Textarea, Tooltip } from '@heroui/react';
import { UserRound, ShieldCheck, Users, GraduationCap } from 'lucide-react';
import { canRequestRole, requestShift, teamHasIntern, slotRoleLabel, type ShiftRequester } from '@/app/lib/events';
import { canSignUpForShifts, getShiftBlockReason } from '@/app/lib/certifications';
import type { Event, EventTeam, SlotRole, User, ShiftRequest } from '@/app/types';

interface TeamCardProps {
  event: Event;
  team: EventTeam;
  userRole: string | null;
  userData: User | null;
  actorUid: string | null;
  actorName: string;
  /** The viewer's own active (pending/approved) request for this event, if any — blocks new requests. */
  myActiveRequest: ShiftRequest | undefined;
  onRequested: () => void;
  onError: (msg: string) => void;
}

function SlotRow({ filled, name }: { filled: boolean; name?: string }) {
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
  onRequested,
  onError,
}: TeamCardProps) {
  const [openRole, setOpenRole] = useState<SlotRole | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const eventOpen = event.status === 'open';
  const blockReason = getShiftBlockReason(userData);
  const canSignUp = canSignUpForShifts(userData);
  const emtFilled = team.emtSlots.filter((s) => s.userId).length;
  const emtHasOpenSlot = team.emtSlots.some((s) => !s.userId);

  const submit = async (role: SlotRole) => {
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
      };
      await requestShift(event, team.id, role, requester, note || undefined);
      setOpenRole(null);
      setNote('');
      onRequested();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to request shift');
    } finally {
      setSubmitting(false);
    }
  };

  const renderRequestControl = (role: SlotRole, hasOpenSlot: boolean) => {
    if (!eventOpen || !hasOpenSlot || myActiveRequest) return null;
    if (!canRequestRole(userRole, role)) return null;

    if (openRole === role) {
      return (
        <div className="flex flex-col gap-2 bg-content2 rounded-large p-3 mt-1.5">
          <Textarea size="sm" placeholder="Optional note" value={note} onValueChange={setNote} minRows={1} />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="light" onPress={() => setOpenRole(null)} isDisabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" color="primary" onPress={() => submit(role)} isLoading={submitting}>
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
        onPress={() => setOpenRole(role)}
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
  };

  return (
    <div className="border border-divider rounded-large p-4 flex flex-col gap-3">
      <div className="text-sm font-semibold text-foreground">{team.name}</div>

      <div className="border border-divider rounded-large p-2.5 flex flex-col gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1">
            <ShieldCheck size={11} /> FTO
          </div>
          <SlotRow filled={!!team.ftoSlot?.userId} name={team.ftoSlot?.userName} />
          {renderRequestControl('FTO', !team.ftoSlot?.userId)}
        </div>

        {teamHasIntern(team) && (
          <div className="pl-2.5 ml-1 border-l-2 border-divider">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1.5">
              <GraduationCap size={11} /> FTO Intern
              <span className="text-[10px] font-normal normal-case tracking-normal text-foreground-400">(supervised)</span>
            </div>
            <SlotRow filled={!!team.ftoInternSlot?.userId} name={team.ftoInternSlot?.userName} />
            {renderRequestControl('FTO_INTERN', !team.ftoInternSlot?.userId)}
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-1 flex items-center gap-1">
          <Users size={11} /> EMT ({emtFilled}/{team.emtCount})
        </div>
        <div className="flex flex-col gap-1.5">
          {team.emtSlots.map((slot, idx) => (
            <SlotRow key={idx} filled={!!slot.userId} name={slot.userName} />
          ))}
        </div>
        {renderRequestControl('EMT', emtHasOpenSlot)}
      </div>
    </div>
  );
}
