'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Switch,
  Spinner,
  Input,
} from '@heroui/react';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from '@/firebase';
import { setAuditPermission } from '@/app/lib/audit-helpers';
import { Shield, Search } from 'lucide-react';

interface AuditPermissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminUser: { id: string; name: string };
}

interface MemberRow {
  id: string;
  fullName: string;
  email: string;
  role: string;
  canAudit: boolean;
}

/**
 * Admin modal to grant/revoke audit permissions for members.
 * Only admins should be able to open this.
 */
export default function AuditPermissionModal({
  isOpen,
  onClose,
  adminUser,
}: AuditPermissionModalProps) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'users'), orderBy('fullName'));
      const snap = await getDocs(q);
      const rows: MemberRow[] = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          fullName: (data.fullName as string) || (data.email as string) || 'Unknown',
          email: (data.email as string) || '',
          role: (data.role as string) || 'member',
          canAudit: data.canAudit === true,
        };
      });
      // Only show members who aren't already admins/quartermasters
      setMembers(
        rows.filter(
          (m) => !['admin', 'quartermaster', 'inventory_helper'].includes(m.role)
        )
      );
    } catch (e) {
      console.error('Failed to load members:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadMembers();
  }, [isOpen, loadMembers]);

  async function toggleAuditAccess(memberId: string, currentValue: boolean) {
    setUpdating(memberId);
    try {
      await setAuditPermission(memberId, !currentValue, adminUser);
      setMembers((prev) =>
        prev.map((m) =>
          m.id === memberId ? { ...m, canAudit: !currentValue } : m
        )
      );
    } catch (e) {
      console.error('Failed to update audit permission:', e);
      alert('Failed to update permission. Try again.');
    }
    setUpdating(null);
  }

  const filtered = search
    ? members.filter(
        (m) =>
          m.fullName.toLowerCase().includes(search.toLowerCase()) ||
          m.email.toLowerCase().includes(search.toLowerCase())
      )
    : members;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Shield size={20} />
          Manage Audit Permissions
        </ModalHeader>

        <ModalBody>
          <p className="text-sm text-default-500 mb-3">
            Admins, quartermasters, and inventory helpers always have audit access.
            Toggle audit access for regular members and FTOs below.
          </p>

          <Input
            placeholder="Search members..."
            value={search}
            onValueChange={setSearch}
            startContent={<Search size={16} />}
            size="sm"
            className="mb-3"
          />

          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-default-500 text-center py-4">
              {search ? 'No members match your search' : 'No eligible members found'}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((member) => (
                <Card key={member.id} className="shadow-none border">
                  <CardBody className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">
                          {member.fullName}
                        </div>
                        <div className="text-xs text-default-400 truncate">
                          {member.email} · {member.role}
                        </div>
                      </div>
                      <Switch
                        size="sm"
                        isSelected={member.canAudit}
                        isDisabled={updating === member.id}
                        onValueChange={() =>
                          toggleAuditAccess(member.id, member.canAudit)
                        }
                        classNames={{
                          wrapper: member.canAudit ? 'bg-success' : '',
                        }}
                      >
                        {updating === member.id ? (
                          <Spinner size="sm" />
                        ) : (
                          <span className="text-xs">
                            {member.canAudit ? 'Can Audit' : 'No Access'}
                          </span>
                        )}
                      </Switch>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
