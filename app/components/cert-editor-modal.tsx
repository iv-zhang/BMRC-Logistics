'use client';

import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Spinner,
} from '@heroui/react';
import { updateMemberCertification, CERT_LABELS } from '@/app/lib/certifications';
import type { User } from '@/app/types';

interface CertEditorModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  member: User;
  actorName: string;
  actorUid: string;
  onSuccess?: () => void;
}

export default function CertEditorModal({
  isOpen,
  onOpenChange,
  member,
  actorName,
  actorUid,
  onSuccess,
}: CertEditorModalProps) {
  const [emtDate, setEmtDate] = useState<string>('');
  const [emtNumber, setEmtNumber] = useState<string>('');
  const [cprDate, setCprDate] = useState<string>('');
  const [cprNumber, setCprNumber] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize form from member data when modal opens
  useEffect(() => {
    if (isOpen && member.certifications) {
      const emtExp = member.certifications.emt?.expiresOn;
      const cprExp = member.certifications.cpr?.expiresOn;

      if (emtExp) {
        const d = emtExp instanceof Date ? emtExp : (typeof emtExp === 'object' && emtExp !== null && 'toDate' in emtExp ? (emtExp as unknown as { toDate(): Date }).toDate() : new Date(String(emtExp)));
        setEmtDate(d.toISOString().split('T')[0]);
      } else {
        setEmtDate('');
      }

      if (cprExp) {
        const d = cprExp instanceof Date ? cprExp : (typeof cprExp === 'object' && cprExp !== null && 'toDate' in cprExp ? (cprExp as unknown as { toDate(): Date }).toDate() : new Date(String(cprExp)));
        setCprDate(d.toISOString().split('T')[0]);
      } else {
        setCprDate('');
      }

      setEmtNumber(member.certifications.emt?.number || '');
      setCprNumber(member.certifications.cpr?.number || '');
      setError(null);
    }
  }, [isOpen, member]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // Update EMT
      if (emtDate || member.certifications?.emt) {
        await updateMemberCertification(member.id, 'emt', {
          expiresOn: emtDate ? new Date(emtDate) : null,
          number: emtNumber || undefined,
        }, {
          uid: actorUid,
          name: actorName,
        });
      }

      // Update CPR
      if (cprDate || member.certifications?.cpr) {
        await updateMemberCertification(member.id, 'cpr', {
          expiresOn: cprDate ? new Date(cprDate) : null,
          number: cprNumber || undefined,
        }, {
          uid: actorUid,
          name: actorName,
        });
      }

      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update certifications');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          Edit Certifications: {member.fullName}
        </ModalHeader>
        <ModalBody className="gap-4">
          {error && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {/* EMT Section */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{CERT_LABELS.emt}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Expiration Date"
                type="date"
                value={emtDate}
                onChange={(e) => setEmtDate(e.target.value)}
                isDisabled={saving}
              />
              <Input
                label="Cert Number (optional)"
                value={emtNumber}
                onChange={(e) => setEmtNumber(e.target.value)}
                isDisabled={saving}
              />
            </div>
          </div>

          {/* CPR Section */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{CERT_LABELS.cpr}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Expiration Date"
                type="date"
                value={cprDate}
                onChange={(e) => setCprDate(e.target.value)}
                isDisabled={saving}
              />
              <Input
                label="Cert Number (optional)"
                value={cprNumber}
                onChange={(e) => setCprNumber(e.target.value)}
                isDisabled={saving}
              />
            </div>
          </div>

          <div className="text-xs text-foreground-400 mt-2">
            Leave a field blank to mark that certification as missing.
          </div>
        </ModalBody>
        <ModalFooter>
          <Button
            color="default"
            variant="light"
            onPress={() => onOpenChange(false)}
            isDisabled={saving}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            onPress={handleSave}
            isDisabled={saving}
            startContent={saving && <Spinner size="sm" color="current" />}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
