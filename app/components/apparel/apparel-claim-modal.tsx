'use client';

import React, { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { AlertTriangle, Shirt } from 'lucide-react';
import { claimApparelItem, HOLD_DURATION_MS } from '@/app/lib/apparel';
import type { ApparelCategory, ApparelItem } from '@/app/types';

export interface ApparelClaimModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: ApparelItem | null;
  category: ApparelCategory | undefined;
  /** `{ id: effectiveUid, fullName: userData?.fullName }` — never the raw auth uid. */
  member: { id: string; fullName?: string };
  /** Optional hook for the caller (e.g. a success toast); the real UI update comes from the page's onSnapshot. */
  onClaimed?: () => void;
}

const CONDITION_LABEL: Record<ApparelItem['condition'], string> = {
  new: 'New',
  good: 'Good',
  fair: 'Fair',
  worn: 'Worn',
};

const HOLD_DAYS = HOLD_DURATION_MS / (24 * 60 * 60 * 1000);

export default function ApparelClaimModal({ isOpen, onClose, item, category, member, onClaimed }: ApparelClaimModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) setError('');
  }, [isOpen, item?.id]);

  const handleConfirm = async () => {
    if (!item?.id) return;
    setSubmitting(true);
    setError('');
    try {
      await claimApparelItem(item.id, member);
      onClaimed?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to claim this item.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!item) return null;
  const Icon = Shirt;

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} placement="center" size="sm">
      <ModalContent>
        <ModalHeader>Claim item</ModalHeader>
        <ModalBody>
          <div className="flex items-center gap-3 bg-content2 rounded-large p-3">
            <div className="w-9 h-9 rounded-[9px] bg-content1 text-foreground-500 flex items-center justify-center flex-none">
              <Icon size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">
                {category?.name ?? 'item'} — {item.sizeLabel}
              </p>
              <p className="text-xs text-foreground-500">{CONDITION_LABEL[item.condition] ?? item.condition} condition</p>
            </div>
          </div>
          <p className="text-sm text-foreground-600">
            You&apos;ll have <span className="font-semibold text-foreground">{HOLD_DAYS} days</span> to pick this up before the hold expires and it becomes available to others.
          </p>
          {error && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
              <AlertTriangle size={12} className="flex-none" />
              {error}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={onClose} isDisabled={submitting}>Cancel</Button>
          <Button color="primary" isLoading={submitting} onPress={handleConfirm}>Confirm claim</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
