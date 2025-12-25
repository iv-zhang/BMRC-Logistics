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
  Divider
} from '@heroui/react';
import { Users } from 'lucide-react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase'; // Assuming your firebase config export
import { User } from '@/types'; // Adjust path based on your folder structure

const ROLE_OPTIONS = [
  { label: 'Admin', value: 'admin', color: 'danger' },
  { label: 'FTO', value: 'FTO', color: 'warning' },
  { label: 'Quartermaster', value: 'quartermaster', color: 'success' },
  { label: 'Member', value: 'member', color: 'default' },
];

const COLUMNS = [
  { name: "MEMBER", uid: "member" },
  { name: "CURRENT ROLE", uid: "role" },
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

  const handleRoleChange = async (userId: string, newRole: string) => {
    setUpdatingId(userId);
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, { role: newRole });
      
      // Update local state to reflect change immediately
      setUsers(prev => prev.map(u => 
        u.id === userId ? { ...u, role: newRole as any } : u
      ));
    } catch (error) {
      console.error("Error updating role:", error);
      alert("Failed to update role. Check console.");
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
          <Chip className="capitalize" color={roleConfig.color as any} size="sm" variant="flat">
            {cellValue}
          </Chip>
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
                if(e.target.value) handleRoleChange(user.id, e.target.value);
              }}
            >
              {ROLE_OPTIONS.map((role) => (
                <SelectItem key={role.value} value={role.value} textValue={role.label}>
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
        return cellValue;
    }
  }, [updatingId]);

  if (loading) {
    return (
      <div className="min-h-screen flex justify-center items-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <Spinner size="lg" label="Loading Roster..." />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Users className="text-indigo-600" size={26} />
            Team Roster
          </h1>
          <p className="text-gray-500 dark:text-gray-400">Manage member permissions and roles.</p>
        </div>
        <Divider />

        <Card className="border border-gray-200/70 dark:border-slate-700 shadow-lg bg-white/80 dark:bg-slate-800/80 rounded-xl">
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
