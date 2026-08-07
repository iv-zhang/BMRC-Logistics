'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  User as UserAvatar,
  Chip,
  Select,
  SelectItem,
  Card,
  CardBody,
  Spinner,
  Divider,
  Switch,
  Tooltip,
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
} from '@heroui/react';
import { Users, ClipboardCheck, SquareKanban, Shield, CalendarClock, ListFilter, IdCard, Activity, Package, Boxes, CalendarDays, AlertTriangle } from 'lucide-react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase'; // Assuming your firebase config export
import { useUserRole } from '@/app/hooks/useUserRole';
import { getMemberCertStatuses } from '@/app/lib/certifications';
import CertEditorModal from '@/app/components/cert-editor-modal';
import { getMemberShiftStats, type MemberShiftStats } from '@/app/lib/events';
import { getSemesterStart } from '@/app/config/org-config';
import { getMemberActivity, type MemberActivityEntry } from '@/app/lib/member-activity';
import type { User, ShiftRequest } from '@/app/types'; // Adjust path based on your folder structure

type RoleChipColor = 'danger' | 'warning' | 'success' | 'default' | 'secondary';

const ROLE_OPTIONS: Array<{ label: string; value: User['role']; color: RoleChipColor }> = [
  { label: 'Admin', value: 'admin', color: 'danger' },
  { label: 'MedOps', value: 'medops', color: 'secondary' },
  { label: 'FTO', value: 'FTO', color: 'warning' },
  { label: 'FTO Intern', value: 'fto_intern', color: 'warning' },
  { label: 'Quartermaster', value: 'quartermaster', color: 'success' },
  { label: 'Inventory Helper', value: 'inventory_helper', color: 'success' },
  { label: 'Member', value: 'member', color: 'default' },
];

// Roles available only for non-admin viewers (medops)
const MEDOPS_AVAILABLE_ROLES = ['FTO', 'fto_intern', 'member'] as const;

const ALL_COLUMNS = [
  { name: "MEMBER", uid: "member" },
  { name: "CERTIFICATIONS", uid: "certifications" },
  { name: "CURRENT ROLE", uid: "role" },
  { name: "SHIFTS", uid: "shifts" },
];

const ROLE_FILTER_OPTIONS: Array<{ label: string; value: User['role'] | 'all' }> = [
  { label: 'All Roles', value: 'all' },
  ...ROLE_OPTIONS.map(r => ({ label: r.label, value: r.value })),
];

function toJsDateLocal(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate();
  }
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

/** Member-status editor options — see `User.memberStatus`. */
const MEMBER_STATUS_OPTIONS: Array<{ label: string; value: NonNullable<User['memberStatus']> }> = [
  { label: 'New', value: 'new' },
  { label: 'Probationary', value: 'probationary' },
  { label: 'General', value: 'general' },
];

/** Derive a display label/color for one shift's attendance record (check-in model, not the old status enum). */
function attendanceLabelAndColor(attendance: ShiftRequest['attendance']): { label: string; color: RoleChipColor } {
  if (attendance?.exception === 'no_show') return { label: 'No-show', color: 'danger' };
  if (attendance?.exception === 'excused') return { label: 'Excused', color: 'default' };
  if (attendance?.checkedInAt) {
    const late = attendance.minutesLate ?? 0;
    return late > 0 ? { label: `Late ${late}m`, color: 'warning' } : { label: 'Checked in', color: 'success' };
  }
  return { label: 'Unrecorded', color: 'default' };
}

export default function RosterPage() {
  const router = useRouter();
  const { role, userData, loading: roleLoading } = useUserRole();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [certModalUser, setCertModalUser] = useState<User | null>(null);
  const [roleFilter, setRoleFilter] = useState<User['role'] | 'all'>('all');
  const [requestsByUser, setRequestsByUser] = useState<Map<string, ShiftRequest[]>>(new Map());
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailModalUserId, setDetailModalUserId] = useState<string | null>(null);
  const semesterStart = React.useMemo(() => getSemesterStart(), []);

  // Access control: only admin, quartermaster, and medops can view
  const isEventManager = role === 'admin' || role === 'quartermaster' || role === 'medops';
  const canEditAllRoles = role === 'admin' || role === 'quartermaster';
  const isMedOps = role === 'medops';

  // Redirect if not authorized
  useEffect(() => {
    if (!roleLoading && !isEventManager) {
      router.push('/dashboard');
    }
  }, [roleLoading, isEventManager, router]);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const querySnapshot = await getDocs(collection(db, 'users'));
        const userList: User[] = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as User[];
        setUsers(userList);
      } catch (error) {
        console.error("Error fetching roster:", error);
      } finally {
        setLoading(false);
      }
    };

    if (!roleLoading && isEventManager) {
      fetchUsers();
    }
  }, [roleLoading, isEventManager]);

  useEffect(() => {
    const fetchShiftRequests = async () => {
      try {
        const querySnapshot = await getDocs(collection(db, 'shift_requests'));
        const map = new Map<string, ShiftRequest[]>();
        querySnapshot.docs.forEach(d => {
          const req = { id: d.id, ...d.data() } as ShiftRequest;
          if (!req.userId) return;
          const existing = map.get(req.userId);
          if (existing) {
            existing.push(req);
          } else {
            map.set(req.userId, [req]);
          }
        });
        setRequestsByUser(map);
      } catch (error) {
        console.error("Error fetching shift requests:", error);
      }
    };

    if (!roleLoading && isEventManager) {
      fetchShiftRequests();
    }
  }, [roleLoading, isEventManager]);

  const handleRoleChange = React.useCallback(async (userId: string, newRole: User['role']) => {
    // MedOps can only assign FTO or member roles
    if (isMedOps && !(MEDOPS_AVAILABLE_ROLES as readonly (typeof newRole)[]).includes(newRole)) {
      alert('MedOps can only assign FTO or Member roles.');
      return;
    }

    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { role: newRole });

      // Update local state to reflect change immediately
      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, role: newRole } : u
      ));
    } catch (error) {
      console.error("Error updating role:", error);
      alert("Failed to update role. Check console.");
    } finally {
      setUpdatingId(null);
    }
  }, [isMedOps]);

  const handleCertModalOpen = (user: User) => {
    setCertModalUser(user);
    setCertModalOpen(true);
  };

  const handleCertModalSuccess = async () => {
    // Refresh the user data
    if (certModalUser) {
      try {
        const snap = await getDocs(collection(db, 'users'));
        const updated = snap.docs.find(d => d.id === certModalUser.id);
        if (updated) {
          const userData = {
            id: updated.id,
            ...updated.data()
          } as User;
          setUsers(prev => prev.map(u => u.id === certModalUser.id ? userData : u));
        }
      } catch (error) {
        console.error('Error refreshing user data:', error);
      }
    }
  };

  const handleDetailModalOpen = (user: User) => {
    setDetailModalUserId(user.id);
    setDetailModalOpen(true);
  };

  const handleCanAuditToggle = async (userId: string, currentValue: boolean) => {
    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { canAudit: !currentValue });
      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, canAudit: !currentValue } : u
      ));
    } catch (error) {
      console.error("Error updating audit access:", error);
      alert("Failed to update audit access. Check console.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleMemberStatusChange = React.useCallback(async (userId: string, status: NonNullable<User['memberStatus']>) => {
    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { memberStatus: status });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, memberStatus: status } : u));
    } catch (error) {
      console.error('Error updating member status:', error);
      alert('Failed to update member status. Check console.');
    } finally {
      setUpdatingId(null);
    }
  }, []);

  const handleJoinedTermChange = React.useCallback(async (userId: string, term: string) => {
    const trimmed = term.trim();
    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { joinedTerm: trimmed || null });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, joinedTerm: trimmed || undefined } : u));
    } catch (error) {
      console.error('Error updating joined term:', error);
      alert('Failed to update joined term. Check console.');
    } finally {
      setUpdatingId(null);
    }
  }, []);

  const handleCommitteeToggle = async (userId: string, currentValue: boolean) => {
    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { isCommitteeMember: !currentValue });
      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, isCommitteeMember: !currentValue } : u
      ));
    } catch (error) {
      console.error("Error updating committee membership:", error);
      alert("Failed to update committee membership. Check console.");
    } finally {
      setUpdatingId(null);
    }
  };

  const renderCell = React.useCallback((user: User, columnKey: React.Key) => {
    const cellValue = user[columnKey as keyof User];

    switch (columnKey) {
      case "member":
        return (
          <UserAvatar
            avatarProps={{ radius: "lg", src: "" }} // Add avatar URL if available in User type
            description={user.email}
            name={user.fullName}
          >
            {user.email}
          </UserAvatar>
        );
      case "certifications":
        const certStatuses = getMemberCertStatuses(user);
        const emtColor = certStatuses.emt === 'valid' ? 'success' : certStatuses.emt === 'expired' ? 'danger' : 'default';
        const cprColor = certStatuses.cpr === 'valid' ? 'success' : certStatuses.cpr === 'expired' ? 'danger' : 'default';
        const getDateStr = (d: unknown) => {
          if (!d) return '';
          if (d instanceof Date) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          if (typeof d === 'object' && d !== null && 'toDate' in d) return (d as unknown as { toDate(): Date }).toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return new Date(String(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        };
        const emtLabel = certStatuses.emt === 'valid'
          ? `EMT (${user.certifications?.emt?.expiresOn ? getDateStr(user.certifications.emt.expiresOn) : ''})`
          : 'EMT';
        const cprLabel = certStatuses.cpr === 'valid'
          ? `CPR (${user.certifications?.cpr?.expiresOn ? getDateStr(user.certifications.cpr.expiresOn) : ''})`
          : 'CPR';
        return (
          <div className="flex items-center gap-2">
            <Chip size="sm" variant="flat" color={emtColor}>
              {emtLabel}
            </Chip>
            <Chip size="sm" variant="flat" color={cprColor}>
              {cprLabel}
            </Chip>
          </div>
        );
      case "role": {
        const roleConfig = ROLE_OPTIONS.find(r => r.value === user.role)
          ?? ROLE_OPTIONS.find(r => r.value === 'member')!;
        return (
          <Chip color={roleConfig.color} size="sm" variant="flat">
            {roleConfig.label}
          </Chip>
        );
      }
      case "shifts": {
        const stats = getMemberShiftStats(requestsByUser.get(user.id) ?? [], semesterStart);
        return (
          <div className="inline-flex items-center gap-1.5 bg-content2 rounded-large px-2.5 py-1.5">
            <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{stats.shiftsThisSemester}</span>
            <span className="text-[11px] text-foreground-400 font-medium">this sem</span>
            <span className="text-foreground-300">&middot;</span>
            <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500">{stats.shiftsAllTime}</span>
            <span className="text-[11px] text-foreground-400 font-medium">all-time</span>
            {stats.noShow > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-danger-50 dark:bg-danger-900/30 text-danger">
                {stats.noShow} NS
              </span>
            )}
            {stats.lateCount > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning">
                {stats.lateCount} late
              </span>
            )}
          </div>
        );
      }
      default:
        return String(cellValue ?? '');
    }
  }, [requestsByUser, semesterStart]);

  if (loading || roleLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  const columns = ALL_COLUMNS;

  const filteredUsers = roleFilter === 'all' ? users : users.filter(u => u.role === roleFilter);
  const detailModalUser = detailModalUserId ? users.find(u => u.id === detailModalUserId) ?? null : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <Users className="text-primary" size={26} />
              Team Roster
            </h1>
            <p className="text-foreground-500">
              Manage member permissions and roles.
              {roleFilter !== 'all' && (
                <span className="ml-1.5 text-foreground-400">
                  Showing <span className="font-semibold text-foreground tabular-nums">{filteredUsers.length}</span> of <span className="tabular-nums">{users.length}</span>.
                </span>
              )}
            </p>
          </div>
          <Select
            aria-label="Filter by role"
            placeholder="Filter by role"
            selectedKeys={[roleFilter]}
            className="w-52"
            size="sm"
            startContent={<ListFilter size={15} className="text-foreground-400" />}
            onChange={(e) => {
              if (e.target.value) {
                setRoleFilter(e.target.value as User['role'] | 'all');
              }
            }}
          >
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} textValue={opt.label}>
                {opt.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <Divider />

        <Card className="border border-divider shadow-lg rounded-xl">
          <CardBody className="p-0">
            <Table
              aria-label="Team Roster Table — click a row to view and edit a member"
              shadow="none"
              removeWrapper
              selectionMode="none"
              onRowAction={(key) => {
                const clicked = filteredUsers.find(u => u.id === key);
                if (clicked) handleDetailModalOpen(clicked);
              }}
            >
              <TableHeader columns={columns}>
                {(column) => (
                  <TableColumn key={column.uid}>
                    {column.name}
                  </TableColumn>
                )}
              </TableHeader>
              <TableBody items={filteredUsers} emptyContent={"No members found."}>
                {(item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer transition-colors hover:bg-content2/60"
                  >
                    {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>

      {certModalUser && userData && (
        <CertEditorModal
          isOpen={certModalOpen}
          onOpenChange={setCertModalOpen}
          member={certModalUser}
          actorName={userData.fullName}
          actorUid={userData.id}
          onSuccess={handleCertModalSuccess}
        />
      )}

      {detailModalUser && (
        <MemberDetailModal
          isOpen={detailModalOpen}
          onOpenChange={setDetailModalOpen}
          member={detailModalUser}
          requests={requestsByUser.get(detailModalUser.id) ?? []}
          semesterStart={semesterStart}
          canEditAllRoles={canEditAllRoles}
          isMedOps={isMedOps}
          updatingId={updatingId}
          onRoleChange={handleRoleChange}
          onCanAuditToggle={handleCanAuditToggle}
          onCommitteeToggle={handleCommitteeToggle}
          onMemberStatusChange={handleMemberStatusChange}
          onJoinedTermChange={handleJoinedTermChange}
          onEditCerts={handleCertModalOpen}
        />
      )}
    </div>
  );
}

/** Stats cards + attendance breakdown + recent shift history. Rendered as a section inside MemberDetailModal. */
function ShiftStatsSection({ requests, semesterStart }: { requests: ShiftRequest[]; semesterStart: Date }) {
  const stats: MemberShiftStats = getMemberShiftStats(requests, semesterStart);

  const recentShifts = requests
    .filter(r => r.status === 'approved')
    .map(r => ({ req: r, date: toJsDateLocal(r.eventDate) }))
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-3">
        <div className="flex-1 bg-content2 rounded-large p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">This Semester</div>
          <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
            {stats.shiftsThisSemester}
          </div>
          <div className="text-xs text-foreground-400 mt-0.5">{stats.hoursThisSemester}h volunteered</div>
        </div>
        <div className="flex-1 bg-content2 rounded-large p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">All-Time</div>
          <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground-600">
            {stats.shiftsAllTime}
          </div>
          <div className="text-xs text-foreground-400 mt-0.5">{stats.hoursAllTime}h volunteered</div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Attendance</div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
            <span className="w-2 h-2 rounded-sm bg-success flex-none" />
            <span className="font-mono font-semibold tabular-nums text-success">{stats.checkedIn}</span>
            <span className="text-xs text-success/80 font-medium">checked in</span>
          </div>
          <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
            <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
            <span className="font-mono font-semibold tabular-nums text-warning">{stats.lateCount}</span>
            <span className="text-xs text-warning/80 font-medium">
              late{stats.totalMinutesLate > 0 ? ` (${stats.totalMinutesLate}m total)` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
            <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
            <span className="font-mono font-semibold tabular-nums text-danger">{stats.noShow}</span>
            <span className="text-xs text-danger/80 font-medium">no-show</span>
          </div>
          <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
            <span className="font-mono font-semibold tabular-nums text-foreground">{stats.excused}</span>
            <span className="text-xs text-foreground-400">excused</span>
          </div>
          <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
            <span className="font-mono font-semibold tabular-nums text-foreground">{stats.unrecorded}</span>
            <span className="text-xs text-foreground-400">unrecorded</span>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Recent Shifts</div>
        {recentShifts.length === 0 ? (
          <p className="text-sm text-foreground-400">No approved shifts on record.</p>
        ) : (
          <div className="bg-content1 border border-divider rounded-large divide-y divide-divider">
            {recentShifts.map(({ req, date }) => {
              const { label, color } = attendanceLabelAndColor(req.attendance);
              return (
                <div key={req.id ?? `${req.eventId}-${req.userId}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{req.eventName}</p>
                    <p className="text-xs text-foreground-400">
                      {date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date'}
                    </p>
                  </div>
                  <Chip size="sm" variant="flat" color={color}>{label}</Chip>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const ACTIVITY_KIND_ICON: Record<MemberActivityEntry['kind'], React.ComponentType<{ size?: number; className?: string }>> = {
  statpack: Package,
  audit: ClipboardCheck,
  inventory: Boxes,
  shift: CalendarDays,
  report: AlertTriangle,
};

/** Lazy-loaded, time-sorted activity feed across statpacks/audits/inventory/shifts/reports. Rendered as a section inside MemberDetailModal. */
function MemberActivitySection({ isOpen, memberId }: { isOpen: boolean; memberId: string }) {
  const [activity, setActivity] = React.useState<MemberActivityEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!isOpen) {
      setActivity(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getMemberActivity(memberId)
      .then((entries) => {
        if (!cancelled) setActivity(entries);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, memberId]);

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2 inline-flex items-center gap-1">
        <Activity size={12} /> Activity
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner size="sm" />
        </div>
      ) : !activity || activity.length === 0 ? (
        <p className="text-sm text-foreground-400">No recorded activity yet.</p>
      ) : (
        <div className="bg-content2 rounded-large divide-y divide-divider max-h-64 overflow-y-auto">
          {activity.map((entry, idx) => {
            const Icon = ACTIVITY_KIND_ICON[entry.kind];
            return (
              <div key={idx} className="flex items-center gap-3 px-3 py-2.5">
                <Icon size={14} className="text-foreground-400 flex-none" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{entry.title}</p>
                  {entry.detail && (
                    <p className="text-xs text-foreground-400 truncate">{entry.detail}</p>
                  )}
                </div>
                <span className="text-xs text-foreground-400 flex-none">
                  {entry.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface MemberDetailModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  member: User;
  requests: ShiftRequest[];
  semesterStart: Date;
  canEditAllRoles: boolean;
  isMedOps: boolean;
  updatingId: string | null;
  onRoleChange: (userId: string, newRole: User['role']) => void;
  onCanAuditToggle: (userId: string, currentValue: boolean) => void;
  onCommitteeToggle: (userId: string, currentValue: boolean) => void;
  onMemberStatusChange: (userId: string, status: NonNullable<User['memberStatus']>) => void;
  onJoinedTermChange: (userId: string, term: string) => void;
  onEditCerts: (user: User) => void;
}

/** The single click-target for a roster row: role assignment, certifications, audit/committee access, and shift history — all in one modal. */
function MemberDetailModal({
  isOpen,
  onOpenChange,
  member,
  requests,
  semesterStart,
  canEditAllRoles,
  isMedOps,
  updatingId,
  onRoleChange,
  onCanAuditToggle,
  onCommitteeToggle,
  onMemberStatusChange,
  onJoinedTermChange,
  onEditCerts,
}: MemberDetailModalProps) {
  const isUpdating = updatingId === member.id;
  // Both admin/quartermaster and medops staff events, so both may set the
  // experience tier used to auto-fill shift requests (see team-card.tsx).
  const canEditMemberStatus = canEditAllRoles || isMedOps;
  const [joinedTermDraft, setJoinedTermDraft] = React.useState(member.joinedTerm ?? '');
  React.useEffect(() => setJoinedTermDraft(member.joinedTerm ?? ''), [member.id, member.joinedTerm]);

  const certStatuses = getMemberCertStatuses(member);
  const emtColor = certStatuses.emt === 'valid' ? 'success' : certStatuses.emt === 'expired' ? 'danger' : 'default';
  const cprColor = certStatuses.cpr === 'valid' ? 'success' : certStatuses.cpr === 'expired' ? 'danger' : 'default';
  const getDateStr = (d: unknown) => {
    if (!d) return '';
    if (d instanceof Date) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (typeof d === 'object' && d !== null && 'toDate' in d) return (d as unknown as { toDate(): Date }).toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return new Date(String(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const emtLabel = certStatuses.emt === 'valid'
    ? `EMT (${member.certifications?.emt?.expiresOn ? getDateStr(member.certifications.emt.expiresOn) : ''})`
    : 'EMT';
  const cprLabel = certStatuses.cpr === 'valid'
    ? `CPR (${member.certifications?.cpr?.expiresOn ? getDateStr(member.certifications.cpr.expiresOn) : ''})`
    : 'CPR';

  const availableRoles = canEditAllRoles
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter(r => (MEDOPS_AVAILABLE_ROLES as readonly (typeof r.value)[]).includes(r.value));

  const inheritsAudit = member.role === 'admin' || member.role === 'quartermaster';
  const inheritsCommittee = member.role === 'admin' || member.role === 'quartermaster';

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-foreground">
                <CalendarClock size={18} className="text-primary" />
                {member.fullName}
              </span>
              <span className="text-xs font-normal text-foreground-400">{member.email}</span>
            </ModalHeader>
            <ModalBody className="gap-5 pb-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Role</div>
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label="Change Role"
                      placeholder="Assign Role"
                      selectedKeys={[member.role]}
                      className="max-w-xs"
                      size="sm"
                      isDisabled={isUpdating}
                      onChange={(e) => {
                        if (e.target.value) {
                          onRoleChange(member.id, e.target.value as User['role']);
                        }
                      }}
                    >
                      {availableRoles.map((role) => (
                        <SelectItem key={role.value} textValue={role.label}>
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full bg-${role.color}-500 opacity-70`}></span>
                            {role.label}
                          </div>
                        </SelectItem>
                      ))}
                    </Select>
                    {isUpdating && <Spinner size="sm" />}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Certifications</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Chip size="sm" variant="flat" color={emtColor}>{emtLabel}</Chip>
                    <Chip size="sm" variant="flat" color={cprColor}>{cprLabel}</Chip>
                    <Button
                      size="sm"
                      variant="light"
                      startContent={<Shield size={14} />}
                      onPress={() => onEditCerts(member)}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              </div>

              {/* TODO: bulk import member status/joinedTerm from roster spreadsheet — this per-member editor is the only way to set it for now. */}
              {canEditMemberStatus && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2 inline-flex items-center gap-1">
                      <IdCard size={12} /> Experience
                    </div>
                    <Select
                      aria-label="Member status"
                      selectedKeys={[member.memberStatus ?? 'general']}
                      className="max-w-xs"
                      size="sm"
                      isDisabled={isUpdating}
                      onChange={(e) => {
                        if (e.target.value) {
                          onMemberStatusChange(member.id, e.target.value as NonNullable<User['memberStatus']>);
                        }
                      }}
                    >
                      {MEMBER_STATUS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} textValue={opt.label}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Joined Term</div>
                    <Input
                      aria-label="Joined term"
                      placeholder="e.g. Fall 2025"
                      className="max-w-xs"
                      size="sm"
                      isDisabled={isUpdating}
                      value={joinedTermDraft}
                      onValueChange={setJoinedTermDraft}
                      onBlur={() => {
                        if (joinedTermDraft !== (member.joinedTerm ?? '')) {
                          onJoinedTermChange(member.id, joinedTermDraft);
                        }
                      }}
                    />
                  </div>
                </div>
              )}

              {!isMedOps && (
                <div className="flex items-center gap-6 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Tooltip content={inheritsAudit ? `${member.role} role always has audit access` : (member.canAudit ? 'Can perform supply audits' : 'No audit access')}>
                      <Switch
                        size="sm"
                        color="secondary"
                        isSelected={inheritsAudit || (member.canAudit === true)}
                        isDisabled={inheritsAudit || isUpdating}
                        onValueChange={() => onCanAuditToggle(member.id, member.canAudit === true)}
                        startContent={<ClipboardCheck size={14} />}
                      >
                        <span className="text-xs text-foreground-500">Audit access</span>
                      </Switch>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-2">
                    <Tooltip content={inheritsCommittee ? `${member.role} role is always on the committee` : (member.isCommitteeMember ? 'On the Logistics Committee (sees the Committee Board)' : 'Not on the Logistics Committee')}>
                      <Switch
                        size="sm"
                        color="secondary"
                        isSelected={inheritsCommittee || (member.isCommitteeMember === true)}
                        isDisabled={inheritsCommittee || isUpdating}
                        onValueChange={() => onCommitteeToggle(member.id, member.isCommitteeMember === true)}
                        startContent={<SquareKanban size={14} />}
                      >
                        <span className="text-xs text-foreground-500">Committee</span>
                      </Switch>
                    </Tooltip>
                  </div>
                  {isUpdating && <Spinner size="sm" />}
                </div>
              )}

              <Divider />

              <ShiftStatsSection requests={requests} semesterStart={semesterStart} />

              <Divider />

              <MemberActivitySection isOpen={isOpen} memberId={member.id} />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>Close</Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
