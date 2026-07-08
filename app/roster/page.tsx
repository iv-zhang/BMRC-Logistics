'use client';

import React, { useEffect, useState } from 'react';
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
  Tooltip
} from '@heroui/react';
import { Users, ClipboardCheck, SquareKanban } from 'lucide-react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase'; // Assuming your firebase config export
import type { User } from '@/app/types'; // Adjust path based on your folder structure

type RoleChipColor = 'danger' | 'warning' | 'success' | 'default';

const ROLE_OPTIONS: Array<{ label: string; value: User['role']; color: RoleChipColor }> = [
  { label: 'Admin', value: 'admin', color: 'danger' },
  { label: 'FTO', value: 'FTO', color: 'warning' },
  { label: 'Quartermaster', value: 'quartermaster', color: 'success' },
  { label: 'Inventory Helper', value: 'inventory_helper', color: 'success' },
  { label: 'Member', value: 'member', color: 'default' },
];

const COLUMNS = [
  { name: "MEMBER", uid: "member" },
  { name: "CURRENT ROLE", uid: "role" },
  { name: "AUDIT ACCESS", uid: "audit" },
  { name: "COMMITTEE", uid: "committee" },
  { name: "DELEGATE ROLE", uid: "actions" },
];

export default function RosterPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

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

    fetchUsers();
  }, []);

  const handleRoleChange = async (userId: string, newRole: User['role']) => {
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
            avatarProps={{radius: "lg", src: ""}} // Add avatar URL if available in User type
            description={user.email}
            name={user.fullName}
          >
            {user.email}
          </UserAvatar>
        );
      case "role":
        const roleConfig = ROLE_OPTIONS.find(r => r.value === user.role) || ROLE_OPTIONS[3];
        return (
          <Chip className="capitalize" color={roleConfig.color} size="sm" variant="flat">
            {user.role}
          </Chip>
        );
      case "audit":
        // Admins and quartermasters always have audit access (no toggle needed)
        const inheritsAudit = user.role === 'admin' || user.role === 'quartermaster';
        return (
          <div className="flex items-center gap-2">
            <Tooltip content={inheritsAudit ? `${user.role} role always has audit access` : (user.canAudit ? 'Can perform supply audits' : 'No audit access')}>
              <Switch
                size="sm"
                color="secondary"
                isSelected={inheritsAudit || (user.canAudit === true)}
                isDisabled={inheritsAudit || updatingId === user.id}
                onValueChange={() => handleCanAuditToggle(user.id, user.canAudit === true)}
                startContent={<ClipboardCheck size={14} />}
              />
            </Tooltip>
            {updatingId === user.id && <Spinner size="sm" />}
          </div>
        );
      case "committee":
        // Admins and quartermasters are always on the Logistics Committee (no toggle needed)
        const inheritsCommittee = user.role === 'admin' || user.role === 'quartermaster';
        return (
          <div className="flex items-center gap-2">
            <Tooltip content={inheritsCommittee ? `${user.role} role is always on the committee` : (user.isCommitteeMember ? 'On the Logistics Committee (sees the Committee Board)' : 'Not on the Logistics Committee')}>
              <Switch
                size="sm"
                color="secondary"
                isSelected={inheritsCommittee || (user.isCommitteeMember === true)}
                isDisabled={inheritsCommittee || updatingId === user.id}
                onValueChange={() => handleCommitteeToggle(user.id, user.isCommitteeMember === true)}
                startContent={<SquareKanban size={14} />}
              />
            </Tooltip>
            {updatingId === user.id && <Spinner size="sm" />}
          </div>
        );
      case "actions":
        return (
          <div className="flex items-center gap-2 max-w-xs">
            <Select 
              aria-label="Change Role"
              placeholder="Assign Role"
              defaultSelectedKeys={[user.role]}
              className="max-w-xs"
              size="sm"
              isDisabled={updatingId === user.id}
              onChange={(e) => {
                if (e.target.value) {
                  handleRoleChange(user.id, e.target.value as User['role']);
                }
              }}
            >
              {ROLE_OPTIONS.map((role) => (
                <SelectItem key={role.value} textValue={role.label}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full bg-${role.color}-500 opacity-70`}></span>
                    {role.label}
                  </div>
                </SelectItem>
              ))}
            </Select>
            {updatingId === user.id && <Spinner size="sm" />}
          </div>
        );
      default:
        return String(cellValue ?? '');
    }
  }, [updatingId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Users className="text-primary" size={26} />
            Team Roster
          </h1>
          <p className="text-foreground-500">Manage member permissions and roles.</p>
        </div>
        <Divider />

        <Card className="border border-divider shadow-lg rounded-xl">
          <CardBody className="p-0">
            <Table aria-label="Team Roster Table" shadow="none" removeWrapper>
              <TableHeader columns={COLUMNS}>
                {(column) => (
                  <TableColumn key={column.uid} align={column.uid === "actions" ? "start" : "start"}>
                    {column.name}
                  </TableColumn>
                )}
              </TableHeader>
              <TableBody items={users} emptyContent={"No members found."}>
                {(item) => (
                  <TableRow key={item.id}>
                    {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
