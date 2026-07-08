'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Input,
  Spinner,
  Textarea,
  Select,
  SelectItem,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from '@heroui/react';
import {
  SquareKanban,
  Plus,
  MoreVertical,
  Edit3,
  Trash2,
  User as UserIcon,
  CalendarClock,
  Target,
} from 'lucide-react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useTeamTasks } from '@/app/hooks/useTeamTasks';
import { TASK_STATUS_CFG } from '@/app/components/task-status-badge';
import type { TeamTask, TeamTaskStatus, User } from '@/app/types';

const STATUS_ORDER: TeamTaskStatus[] = ['backlog', 'this_cycle', 'in_progress', 'blocked', 'done'];

/** Format a Date as yyyy-MM-dd in local time (toISOString would shift the day across timezones). */
function toDateInputValue(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function isOverdue(task: TeamTask): boolean {
  if (!task.dueDate || task.status === 'done') return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return task.dueDate < today;
}

export default function CommitteeBoardPage() {
  const router = useRouter();
  const { user, userData, role, loading: authLoading } = useUserRole();
  const { tasks, loading: tasksLoading } = useTeamTasks();

  const isAdmin = role === 'admin' || role === 'quartermaster';
  // UI-level gating only — real enforcement is the deferred rules-hardening track
  const isCommittee = isAdmin || userData?.isCommitteeMember === true;

  // Members list for the owner picker (admins only — they're the only ones who assign)
  const [members, setMembers] = useState<User[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    const q = query(collection(db, 'users'), orderBy('fullName'));
    const unsub = onSnapshot(q, (snap) => {
      setMembers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<User, 'id'>) })));
    });
    return () => unsub();
  }, [isAdmin]);

  // Add/Edit modal
  const editModal = useDisclosure();
  const [editingTask, setEditingTask] = useState<TeamTask | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formOwnerId, setFormOwnerId] = useState('');
  const [formDoD, setFormDoD] = useState('');
  const [formDue, setFormDue] = useState('');
  const [saving, setSaving] = useState(false);

  const columns = useMemo(() => {
    const byStatus: Record<TeamTaskStatus, TeamTask[]> = {
      backlog: [], this_cycle: [], in_progress: [], blocked: [], done: [],
    };
    tasks.forEach((t) => { if (t.status in byStatus) byStatus[t.status].push(t); });
    return byStatus;
  }, [tasks]);

  const openCount = tasks.length - columns.done.length;

  const resetForm = () => {
    setFormTitle('');
    setFormOwnerId(user?.uid ?? '');
    setFormDoD('');
    setFormDue('');
    setEditingTask(null);
  };

  const openAdd = () => {
    resetForm();
    editModal.onOpen();
  };

  const openEdit = (task: TeamTask) => {
    setEditingTask(task);
    setFormTitle(task.title);
    setFormOwnerId(task.ownerId);
    setFormDoD(task.definitionOfDone);
    setFormDue(task.dueDate ? toDateInputValue(task.dueDate) : '');
    editModal.onOpen();
  };

  const handleSave = async () => {
    const owner = members.find((m) => m.id === formOwnerId);
    if (!formTitle.trim() || !formDoD.trim() || !owner) return;
    setSaving(true);
    try {
      const payload = {
        title: formTitle.trim(),
        ownerId: owner.id,
        ownerName: owner.fullName,
        definitionOfDone: formDoD.trim(),
        // 'T00:00:00' pins the date to local midnight — a bare yyyy-MM-dd parses as UTC and shifts a day
        dueDate: formDue ? new Date(`${formDue}T00:00:00`) : null,
      };
      if (editingTask?.id) {
        await updateDoc(doc(db, 'team_tasks', editingTask.id), payload);
      } else {
        await addDoc(collection(db, 'team_tasks'), {
          ...payload,
          status: 'backlog',
          createdBy: user?.uid ?? 'unknown',
          createdByName: userData?.fullName ?? user?.email ?? 'Unknown',
          createdAt: serverTimestamp(),
        });
      }
      editModal.onClose();
      resetForm();
    } catch (err) {
      console.error('Failed to save committee task:', err);
      alert('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (task: TeamTask, newStatus: TeamTaskStatus) => {
    if (!task.id) return;
    const update: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'done') {
      update.completedAt = serverTimestamp();
      update.completedBy = user?.uid ?? 'unknown';
      update.completedByName = userData?.fullName ?? user?.email ?? 'Unknown';
    } else if (task.status === 'done') {
      update.completedAt = null;
      update.completedBy = null;
      update.completedByName = null;
    }
    try {
      await updateDoc(doc(db, 'team_tasks', task.id), update);
    } catch (err) {
      console.error('Failed to change task status:', err);
      alert('Failed to update status. Please try again.');
    }
  };

  const handleDelete = async (task: TeamTask) => {
    if (!task.id) return;
    if (!confirm(`Delete task "${task.title}"?`)) return;
    try {
      await deleteDoc(doc(db, 'team_tasks', task.id));
    } catch (err) {
      console.error('Failed to delete task:', err);
      alert('Failed to delete. Please try again.');
    }
  };

  if (authLoading || tasksLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isCommittee) {
    return (
      <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-3xl mx-auto">
          <Card><CardBody className="text-center">
            <h2 className="text-xl font-semibold">Access Denied</h2>
            <p className="mt-2 text-sm text-foreground-500">Only Logistics Committee members can access the Committee Board.</p>
            <div className="mt-4"><Button onPress={() => router.push('/dashboard')}>Back to Dashboard</Button></div>
          </CardBody></Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* Page header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <SquareKanban className="text-primary" size={24} />
              <h1 className="text-2xl font-semibold text-foreground">Committee Board</h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{openCount}</span>
                <span className="text-xs text-foreground-400">open</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{columns.blocked.length}</span>
                <span className="text-xs text-danger/80 font-medium">blocked</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{columns.done.length}</span>
                <span className="text-xs text-success/80 font-medium">done</span>
              </div>
            </div>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-3 flex-wrap">
              <Button color="primary" startContent={<Plus size={16} />} onPress={openAdd}>
                Add Task
              </Button>
            </div>
          )}
        </div>

        {/* Five status columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start">
          {STATUS_ORDER.map((status) => {
            const cfg = TASK_STATUS_CFG[status];
            const cards = columns[status];
            return (
              <section key={status} className="min-w-0">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <cfg.Icon size={15} className={cfg.text} />
                  <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                    {cfg.label}
                  </h2>
                  <span className="ml-auto font-mono text-xs font-semibold tabular-nums text-foreground-400">
                    {cards.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {cards.length === 0 && (
                    <p className="text-xs text-foreground-400 px-1">No tasks</p>
                  )}
                  {cards.map((task) => {
                    const canChangeStatus = isAdmin || task.ownerId === user?.uid;
                    const overdue = isOverdue(task);
                    const menuEntries = [
                      ...(canChangeStatus
                        ? STATUS_ORDER.filter((s) => s !== task.status).map((s) => ({
                            key: `status_${s}`, kind: 'status' as const, status: s,
                          }))
                        : []),
                      ...(isAdmin ? [{ key: 'edit', kind: 'edit' as const, status: task.status }] : []),
                      ...(isAdmin ? [{ key: 'delete', kind: 'delete' as const, status: task.status }] : []),
                    ];
                    return (
                      <div key={task.id} className="bg-content1 border border-divider rounded-large p-4">
                        <div className="flex items-start gap-2">
                          <p className="flex-1 min-w-0 text-sm font-semibold text-foreground">{task.title}</p>
                          {menuEntries.length > 0 && (
                            <Dropdown>
                              <DropdownTrigger>
                                <Button isIconOnly size="sm" variant="light" aria-label="Task actions" className="-mt-1 -mr-1">
                                  <MoreVertical size={14} />
                                </Button>
                              </DropdownTrigger>
                              <DropdownMenu aria-label="Task actions" items={menuEntries}>
                                {(entry) => {
                                  if (entry.kind === 'edit') {
                                    return <DropdownItem key="edit" startContent={<Edit3 size={14} />} onPress={() => openEdit(task)}>Edit / Reassign</DropdownItem>;
                                  }
                                  if (entry.kind === 'delete') {
                                    return <DropdownItem key="delete" startContent={<Trash2 size={14} />} color="danger" className="text-danger" onPress={() => handleDelete(task)}>Delete</DropdownItem>;
                                  }
                                  const c = TASK_STATUS_CFG[entry.status];
                                  return (
                                    <DropdownItem key={entry.key} startContent={<c.Icon size={14} />} onPress={() => handleStatusChange(task, entry.status)}>
                                      Move to {c.label}
                                    </DropdownItem>
                                  );
                                }}
                              </DropdownMenu>
                            </Dropdown>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 text-xs text-foreground-500 mt-2">
                          <UserIcon size={12} className="flex-none text-foreground-400" />
                          <span className="truncate">{task.ownerName}</span>
                        </div>

                        {task.dueDate && (
                          <div className={`flex items-center gap-1.5 text-xs mt-1 ${overdue ? 'text-danger font-semibold' : 'text-foreground-500'}`}>
                            <CalendarClock size={12} className="flex-none" />
                            <span>
                              {task.dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                              {overdue && ' — overdue'}
                            </span>
                          </div>
                        )}

                        <div className="flex items-start gap-1.5 text-xs text-foreground-400 mt-2">
                          <Target size={12} className="flex-none mt-0.5" />
                          <span className="line-clamp-2">Done means: {task.definitionOfDone}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {/* Add/Edit modal */}
      <Modal isOpen={editModal.isOpen} onOpenChange={editModal.onOpenChange} size="lg">
        <ModalContent>
          <ModalHeader>{editingTask ? 'Edit Task' : 'Add Task'}</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              label="Title"
              placeholder="e.g., Draft fall supply order"
              value={formTitle}
              onValueChange={setFormTitle}
              isRequired
              autoFocus
            />
            <Select
              label="Owner"
              isRequired
              selectedKeys={formOwnerId ? [formOwnerId] : []}
              onChange={(e) => setFormOwnerId(e.target.value)}
              items={members}
            >
              {(m) => <SelectItem key={m.id} textValue={m.fullName}>{m.fullName}</SelectItem>}
            </Select>
            <Textarea
              label="Done means…"
              placeholder="What must be true for this task to count as done?"
              value={formDoD}
              onValueChange={setFormDoD}
              minRows={2}
              isRequired
            />
            <Input
              label="Due date (optional)"
              type="date"
              value={formDue}
              onValueChange={setFormDue}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => { editModal.onClose(); resetForm(); }}>Cancel</Button>
            <Button
              color="primary"
              isLoading={saving}
              isDisabled={!formTitle.trim() || !formDoD.trim() || !formOwnerId}
              onPress={handleSave}
            >
              {editingTask ? 'Save Changes' : 'Add Task'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
