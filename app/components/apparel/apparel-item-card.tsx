'use client';

import React from 'react';
import { Button, Chip } from '@heroui/react';
import {
  Shirt, Users, CircleDollarSign, Edit2, Ban, RotateCcw,
  PackageCheck, Handshake, Undo2,
} from 'lucide-react';
import { getDisplayStatus, isLoanOverdue } from '@/app/lib/apparel';
import type { ApparelCategory, ApparelItem, ApparelItemStatus } from '@/app/types';

export interface ApparelItemCardProps {
  item: ApparelItem;
  category: ApparelCategory | undefined;
  /** `effectiveUid` from `useUserRole()` — never the raw auth uid. */
  currentUserId: string | null;
  isAdmin: boolean;
  /** Disables every action button while a page-level write is in flight. */
  isBusy?: boolean;
  onClaim: (item: ApparelItem) => void;
  onRelease: (item: ApparelItem) => void;
  onJoinWaitlist: (item: ApparelItem) => void;
  onLeaveWaitlist: (item: ApparelItem) => void;
  onEdit: (item: ApparelItem) => void;
  onWithdraw: (item: ApparelItem) => void;
  onReactivate: (item: ApparelItem) => void;
  onMarkPickedUp: (item: ApparelItem) => void;
  onMarkLoaned: (item: ApparelItem) => void;
  onMarkReturned: (item: ApparelItem) => void;
  onMarkPaid: (item: ApparelItem) => void;
}

const CONDITION_LABEL: Record<ApparelItem['condition'], string> = {
  new: 'New',
  good: 'Good',
  fair: 'Fair',
  worn: 'Worn',
};

function formatDate(d?: Date): string {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dispositionLabel(item: ApparelItem): string {
  if (item.disposition === 'for_sale') return `For Sale${item.price != null ? ` $${item.price}` : ''}`;
  if (item.disposition === 'loaner') return 'Loaner';
  return 'Free';
}

function statusChip(item: ApparelItem, now: Date): { color: 'success' | 'warning' | 'danger' | 'primary' | 'default'; label: string } {
  const status = getDisplayStatus(item, now);
  if (status === 'available') return { color: 'success', label: 'Available' };
  if (status === 'claimed') {
    const until = formatDate(item.claimExpiresAt);
    return { color: 'warning', label: until ? `Claimed until ${until}` : 'Claimed' };
  }
  if (status === 'on_loan') {
    const due = formatDate(item.loanDueAt);
    if (isLoanOverdue(item, now)) return { color: 'danger', label: due ? `Overdue — due ${due}` : 'Overdue' };
    return { color: 'primary', label: due ? `On Loan — due ${due}` : 'On Loan' };
  }
  if (status === 'picked_up') return { color: 'default', label: 'Picked Up' };
  return { color: 'default', label: 'Withdrawn' };
}

export default function ApparelItemCard({
  item, category, currentUserId, isAdmin, isBusy,
  onClaim, onRelease, onJoinWaitlist, onLeaveWaitlist, onEdit, onWithdraw, onReactivate,
  onMarkPickedUp, onMarkLoaned, onMarkReturned, onMarkPaid,
}: ApparelItemCardProps) {
  const now = new Date();
  const displayStatus: ApparelItemStatus = getDisplayStatus(item, now);
  const Icon = Shirt;
  const chip = statusChip(item, now);
  const waitlistCount = item.waitlist?.length ?? 0;
  const isClaimant = currentUserId != null && item.claimedBy === currentUserId;
  const onWaitlist = currentUserId != null && (item.waitlist ?? []).some((w) => w.userId === currentUserId);
  const unpaidFlag = item.disposition === 'for_sale' && !item.isPaid;

  let primaryAction: { label: string; onClick: () => void; color?: 'primary'; variant?: 'bordered' | 'flat' } | null = null;
  if (displayStatus === 'available') {
    primaryAction = { label: 'Claim', onClick: () => onClaim(item), color: 'primary' };
  } else if (displayStatus === 'claimed' && isClaimant) {
    primaryAction = { label: 'Release', onClick: () => onRelease(item), variant: 'bordered' };
  } else if ((displayStatus === 'claimed' || displayStatus === 'on_loan') && !isClaimant) {
    primaryAction = onWaitlist
      ? { label: 'Leave Waitlist', onClick: () => onLeaveWaitlist(item), variant: 'bordered' }
      : { label: `Join Waitlist (${waitlistCount} waiting)`, onClick: () => onJoinWaitlist(item), color: 'primary', variant: 'flat' };
  }

  const handleMarkPickedUp = () => {
    if (item.disposition === 'for_sale' && !item.isPaid) {
      if (!window.confirm('This item is unpaid — mark picked up anyway?')) return;
    }
    onMarkPickedUp(item);
  };

  return (
    <div className="bg-content1 border border-divider rounded-large p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-[50px] h-[50px] rounded-[13px] bg-content2 text-foreground-500 flex items-center justify-center flex-none">
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground-500">{category?.name ?? 'Unknown'}</p>
          <p className="text-2xl font-semibold tabular-nums text-foreground leading-tight truncate">{item.sizeLabel}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip size="sm" variant="flat" color="default">{CONDITION_LABEL[item.condition] ?? item.condition}</Chip>
        <Chip size="sm" variant="flat" color="default">{dispositionLabel(item)}</Chip>
        <Chip size="sm" variant="flat" color={chip.color}>{chip.label}</Chip>
        {waitlistCount > 0 && (
          <Chip size="sm" variant="flat" color="default" startContent={<Users size={12} />}>
            {waitlistCount} waiting
          </Chip>
        )}
        {unpaidFlag && (
          <Chip size="sm" variant="flat" color="danger" startContent={<CircleDollarSign size={12} />}>
            Unpaid
          </Chip>
        )}
      </div>

      {item.description && (
        <p className="text-xs text-foreground-500 line-clamp-2">{item.description}</p>
      )}

      {primaryAction && (
        <Button
          size="sm"
          color={primaryAction.color}
          variant={primaryAction.variant ?? 'solid'}
          isDisabled={isBusy}
          onPress={primaryAction.onClick}
          className="w-full"
        >
          {primaryAction.label}
        </Button>
      )}

      {isAdmin && (
        <div className="flex flex-wrap gap-1.5 pt-3 mt-1 border-t border-divider">
          <Button
            size="sm"
            variant="light"
            startContent={<Edit2 size={13} />}
            isDisabled={isBusy || displayStatus !== 'available'}
            onPress={() => onEdit(item)}
          >
            Edit
          </Button>

          {displayStatus === 'withdrawn' ? (
            <Button
              size="sm"
              variant="light"
              color="primary"
              startContent={<RotateCcw size={13} />}
              isDisabled={isBusy}
              onPress={() => onReactivate(item)}
            >
              Reactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="light"
              color="danger"
              startContent={<Ban size={13} />}
              isDisabled={isBusy}
              onPress={() => onWithdraw(item)}
            >
              Withdraw
            </Button>
          )}

          {item.disposition !== 'loaner' && displayStatus === 'claimed' && (
            <Button
              size="sm"
              variant="light"
              startContent={<PackageCheck size={13} />}
              isDisabled={isBusy}
              onPress={handleMarkPickedUp}
            >
              Mark Picked Up
            </Button>
          )}

          {item.disposition === 'loaner' && displayStatus === 'claimed' && (
            <Button
              size="sm"
              variant="light"
              startContent={<Handshake size={13} />}
              isDisabled={isBusy}
              onPress={() => onMarkLoaned(item)}
            >
              Mark Loaned
            </Button>
          )}

          {displayStatus === 'on_loan' && (
            <Button
              size="sm"
              variant="light"
              startContent={<Undo2 size={13} />}
              isDisabled={isBusy}
              onPress={() => onMarkReturned(item)}
            >
              Mark Returned
            </Button>
          )}

          {unpaidFlag && (
            <Button
              size="sm"
              variant="light"
              color="success"
              startContent={<CircleDollarSign size={13} />}
              isDisabled={isBusy}
              onPress={() => onMarkPaid(item)}
            >
              Mark Paid
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
