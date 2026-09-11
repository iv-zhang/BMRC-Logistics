'use client';

import React, { useState } from 'react';
import {
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { Statpack } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import { getPackShortages, formatShortage } from '@/app/lib/statpack-shortages';
import { overrideStatpackReady } from '@/app/lib/statpacks';

interface StatpackReadyOverrideProps {
  pack: Statpack;
  size?: 'sm' | 'md';
}

/**
 * Self-gating "Mark ready" override button + confirmation modal. Renders
 * nothing unless the current user is admin/quartermaster and the pack is
 * eligible (not checked out, not already Ready, not an expired-items status).
 */
export default function StatpackReadyOverride({ pack, size = 'sm' }: StatpackReadyOverrideProps) {
  const { role, userData, user, effectiveUid } = useUserRole();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = role === 'admin' || role === 'quartermaster';
  const eligible = isAdmin && !pack.isCheckedOut && pack.status !== 'Ready' && !pack.status.includes('Expired');

  if (!eligible) return null;

  const shortages = getPackShortages(pack);

  const handleClose = () => {
    setNote('');
    setError(null);
    onClose();
  };

  const handleConfirm = async () => {
    if (!effectiveUid) {
      setError('No active user — sign in again to override.');
      return;
    }
    const name = userData?.fullName ?? user?.displayName ?? user?.email ?? 'Admin';
    setSaving(true);
    setError(null);
    try {
      await overrideStatpackReady(pack, { uid: effectiveUid, name }, note || undefined);
      setSaving(false);
      handleClose();
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Failed to override statpack status');
    }
  };

  return (
    <>
      <Button
        size={size}
        variant="flat"
        color="warning"
        startContent={<ShieldCheck size={14} />}
        onPress={onOpen}
      >
        Mark ready
      </Button>

      <Modal isOpen={isOpen} onOpenChange={(open) => (open ? onOpen() : handleClose())} placement="center" size="md">
        <ModalContent>
          <ModalHeader>
            <div className="flex flex-col">
              <span>Override to Ready — {pack.name}</span>
            </div>
          </ModalHeader>
          <ModalBody>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-foreground-500">
                The pack will show Ready and can be checked out. Missing and low items stay flagged
                until restocked; the next check-in or audit recalculates status.
              </p>

              {shortages.total > 0 ? (
                <div className="flex flex-col gap-2">
                  {shortages.out.length > 0 && (
                    <div className="bg-danger-50 dark:bg-danger-950/20 rounded-large p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-danger mb-1.5">
                        Out
                      </p>
                      <ul className="flex flex-col gap-1">
                        {shortages.out.map((s) => (
                          <li key={s.itemId} className="text-sm text-foreground">
                            {formatShortage(s)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {shortages.low.length > 0 && (
                    <div className="bg-warning-50 dark:bg-warning-950/20 rounded-large p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-warning mb-1.5">
                        Low
                      </p>
                      <ul className="flex flex-col gap-1">
                        {shortages.low.map((s) => (
                          <li key={s.itemId} className="text-sm text-foreground">
                            {formatShortage(s)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-foreground-500">
                  No count shortages recorded — status was set by {pack.status}.
                </p>
              )}

              <Textarea
                label="Note (optional)"
                placeholder="Why override this pack to Ready?"
                value={note}
                onValueChange={setNote}
                minRows={2}
              />

              {error && (
                <div className="flex items-center gap-2 text-sm text-danger">
                  <AlertTriangle size={14} className="flex-none" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} isDisabled={saving}>
              Cancel
            </Button>
            <Button color="warning" onPress={handleConfirm} isLoading={saving}>
              Mark ready
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
