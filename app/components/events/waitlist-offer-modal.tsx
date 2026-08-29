'use client';

/**
 * [Phase 1 / waitlist plan §5.2] Accept/decline UI for one live waitlist
 * offer (`ShiftRequest.status === 'offered'`, `offer` set). This is a fixed
 * contract imported by the dashboard "Shift Offers" card and by the
 * `?offer=` deep-link handler in app/events/page.tsx — do not change the
 * exported `WaitlistOfferModalProps` shape.
 *
 * `placement="center"` (matches event-editor-modal.tsx): this is a single
 * time-boxed decision, not a browsing surface, so it is deliberately not a
 * drawer/PanelShell.
 */

import { useEffect, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Chip } from '@heroui/react';
import { ShieldCheck, Clock } from 'lucide-react';
import { acceptOffer, declineOffer, resolveOfferState, slotRoleLabel, type EventActor } from '@/app/lib/events';
import { getWaitlistConfig } from '@/app/config/org-config';
import { formatEventDate, formatTimeRange } from './event-utils';
import type { Event, ShiftRequest } from '@/app/types';

export interface WaitlistOfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** status 'offered', offer set. */
  request: ShiftRequest;
  event: Event;
  actor: EventActor;
  onDecided: (ok: boolean, msg: string) => void;
}

/** `mm:ss` under an hour, else `Xh Ym`. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** default -> warning under 30min -> danger under 5min. */
function countdownColor(ms: number): 'default' | 'warning' | 'danger' {
  const minutes = ms / 60_000;
  if (minutes < 5) return 'danger';
  if (minutes < 30) return 'warning';
  return 'default';
}

export default function WaitlistOfferModal({
  isOpen,
  onClose,
  request,
  event,
  actor,
  onDecided,
}: WaitlistOfferModalProps): React.JSX.Element | null {
  // `now` drives both the live countdown and the expiry check; seeding it
  // lazily (not on the initial render pass alone) means an already-expired
  // offer resolves to the static state on the very first render — never a
  // countdown that opens already negative (§5.7).
  const [now, setNow] = useState(() => Date.now());
  const [acting, setActing] = useState<'accept' | 'decline' | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isOpen]);

  if (!isOpen) return null;
  const offer = request.offer;
  if (!offer) return null;

  const cancelled = event.status === 'cancelled';
  const remainingMs = offer.respondBy.toMillis() - now;
  const resolvedStatus = resolveOfferState(request, new Date(now));
  // Countdown hits zero (or a lazy sweep elsewhere already resolved it) ->
  // disable both actions immediately, no round trip required.
  const expired = resolvedStatus === 'expired' || remainingMs <= 0;

  const handleAccept = async () => {
    setActing('accept');
    try {
      await acceptOffer(request, actor);
      onDecided(true, `Confirmed: ${offer.teamName} · ${slotRoleLabel(request.role)}`);
      onClose();
    } catch (e) {
      onDecided(false, e instanceof Error ? e.message : 'Failed to accept offer');
    } finally {
      setActing(null);
    }
  };

  const handleDecline = async () => {
    setActing('decline');
    try {
      await declineOffer(request, actor);
      onDecided(true, 'Offer declined');
      onClose();
    } catch (e) {
      onDecided(false, e instanceof Error ? e.message : 'Failed to decline offer');
    } finally {
      setActing(null);
    }
  };

  // [P11 / R2] Notice-class copy is config, never a code literal —
  // `{cancelHours}` interpolates from the FROZEN `offer.policy`, not live
  // config, so the offer stays explicable months later (P3).
  const copy = getWaitlistConfig().copy;
  const noticeCopy =
    offer.noticeClass === 'long'
      ? copy.offerLongNotice.replace('{cancelHours}', String(offer.policy.cancellationNoticeHours))
      : copy.offerShortNotice.replace('{cancelHours}', String(offer.policy.cancellationNoticeHours));

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} placement="center" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col items-start gap-0.5">
          <span className="text-base font-semibold text-foreground">{request.eventName}</span>
          <span className="text-xs font-normal text-foreground-500">
            {offer.teamName} · {slotRoleLabel(request.role)}
          </span>
          <span className="text-xs font-normal text-foreground-500">
            {formatEventDate(event.date)}
            {event.callTime ? ` · ${formatTimeRange(event.callTime, event.endTime)}` : ''}
          </span>
        </ModalHeader>
        <ModalBody className="gap-4">
          {cancelled ? (
            <div className="bg-content2 rounded-large p-3 text-sm text-foreground-500">
              This event was cancelled.
            </div>
          ) : expired ? (
            <Chip size="sm" variant="flat" color="default">Offer expired</Chip>
          ) : (
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-foreground-400 flex-none" />
              <Chip size="sm" variant="flat" color={countdownColor(remainingMs)}>
                {formatCountdown(remainingMs)}
              </Chip>
            </div>
          )}

          {!cancelled && (
            <div className="bg-content2 rounded-large p-3 flex items-start gap-2">
              {offer.noticeClass === 'long' && (
                <ShieldCheck size={15} className="text-foreground-500 mt-0.5 flex-none" />
              )}
              <p className="text-sm text-foreground-600">{noticeCopy}</p>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          {cancelled || expired ? (
            <Button variant="light" onPress={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="bordered"
                color="danger"
                onPress={handleDecline}
                isLoading={acting === 'decline'}
                isDisabled={acting === 'accept'}
              >
                Decline
              </Button>
              <Button
                color="primary"
                onPress={handleAccept}
                isLoading={acting === 'accept'}
                isDisabled={acting === 'decline'}
              >
                Accept
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
