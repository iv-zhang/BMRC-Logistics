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
  Chip,
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
  GripVertical,
  ArrowUpRight,
  MessageSquare,
  ListChecks,
  Check,
  X,
  LayoutGrid,
  UserRound,
  ShoppingCart,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
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
  arrayUnion,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useTeamTasks } from '@/app/hooks/useTeamTasks';
import { useAuditTaskCards, type AuditTaskCard } from '@/app/hooks/useAuditTaskCards';
import { TASK_STATUS_CFG } from '@/app/components/task-status-badge';
import BuyListPanel from '@/app/components/buy-list-panel';
import PanelShell from '@/app/components/panel-shell';
import type { TeamTask, TeamTaskStatus, TeamTaskOwner, TeamSubtask, User } from '@/app/types';

const STATUS_ORDER: TeamTaskStatus[] = ['backlog', 'this_cycle', 'in_progress', 'blocked', 'done'];
type BoardView = 'board' | 'buylist';

const PRIORITY_CHIP_COLOR: Record<string, 'default' | 'primary' | 'warning' | 'danger'> = {
  low: 'default',
  medium: 'primary',
  high: 'warning',
  urgent: 'danger',
};

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

function firstName(name: string): string {
  return (name || '').trim().split(/\s+/)[0] || name || 'Unknown';
}

/** Short "Alex, Sam +1" summary of owners for a compact card. */
function ownersLabel(owners: TeamTaskOwner[]): string {
  if (!owners.length) return 'Unassigned';
  const names = owners.map((o) => firstName(o.name));
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function timeAgo(d: Date): string {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Draggable committee task card ─────────────────────────────────────────────
interface TaskCardProps {
  task: TeamTask;
  isAdmin: boolean;
  userUid?: string;
  onOpen: (task: TeamTask) => void;
  onEdit: (task: TeamTask) => void;
  onDelete: (task: TeamTask) => void;
}

function TaskCard({ task, isAdmin, userUid, onOpen, onEdit, onDelete }: TaskCardProps) {
  const canDrag = isAdmin || task.owners.some((o) => o.id === userUid);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id!,
    disabled: !canDrag,
  });

  const overdue = isOverdue(task);
  const subtasks = task.subtasks ?? [];
  const subDone = subtasks.filter((s) => s.done).length;
  const updateCount = (task.updates ?? []).length;

  return (
    <div
      ref={setNodeRef}
      onClick={() => onOpen(task)}
      className={`bg-content1 border border-divider rounded-large p-4 cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all duration-150 ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        {canDrag && (
          <button
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label="Drag to move"
            className="mt-0.5 -ml-1 text-foreground-300 hover:text-foreground-500 cursor-grab active:cursor-grabbing touch-none flex-none"
          >
            <GripVertical size={15} />
          </button>
        )}
        <p className="flex-1 min-w-0 text-sm font-semibold text-foreground">{task.title}</p>
        {isAdmin && (
          <div onClick={(e) => e.stopPropagation()} className="flex-none">
            <Dropdown>
              <DropdownTrigger>
                <Button isIconOnly size="sm" variant="light" aria-label="Task actions" className="-mt-1 -mr-1">
                  <MoreVertical size={14} />
                </Button>
              </DropdownTrigger>
              <DropdownMenu aria-label="Task actions">
                <DropdownItem key="edit" startContent={<Edit3 size={14} />} onPress={() => onEdit(task)}>
                  Edit / Reassign
                </DropdownItem>
                <DropdownItem
                  key="delete"
                  startContent={<Trash2 size={14} />}
                  color="danger"
                  className="text-danger"
                  onPress={() => onDelete(task)}
                >
                  Delete
                </DropdownItem>
              </DropdownMenu>
            </Dropdown>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-foreground-500 mt-2">
        <UserIcon size={12} className="flex-none text-foreground-400" />
        <span className="truncate">{ownersLabel(task.owners)}</span>
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

      {(task.priority || task.category) && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {task.priority && (
            <Chip size="sm" variant="flat" color={PRIORITY_CHIP_COLOR[task.priority] ?? 'default'} classNames={{ base: 'h-5', content: 'text-[10px] font-semibold px-1.5' }}>
              {task.priority}
            </Chip>
          )}
          {task.category && (
            <Chip size="sm" variant="flat" color="secondary" classNames={{ base: 'h-5', content: 'text-[10px] font-semibold px-1.5' }}>
              {task.category}
            </Chip>
          )}
        </div>
      )}

      {(subtasks.length > 0 || updateCount > 0) && (
        <div className="flex items-center gap-2 mt-2.5">
          {subtasks.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-content2 text-foreground-500">
              <ListChecks size={11} /> {subDone}/{subtasks.length}
            </span>
          )}
          {updateCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-content2 text-foreground-500">
              <MessageSquare size={11} /> {updateCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Live-linked system audit card (read-only, not draggable) ──────────────────
function AuditCard({ card, onOpen }: { card: AuditTaskCard; onOpen: (href: string) => void }) {
  const cfg = TASK_STATUS_CFG[card.status];
  return (
    <div className="bg-content1 border border-divider rounded-large p-4">
      <div className="flex items-start gap-2">
        <p className="flex-1 min-w-0 text-sm font-semibold text-foreground">{card.title}</p>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-content2 text-foreground-500 flex-none">
          System
        </span>
        <button
          onClick={() => onOpen(card.href)}
          aria-label="Open audit"
          className="-mt-1 -mr-1 w-7 h-7 rounded-medium text-foreground-400 hover:bg-content2 flex items-center justify-center flex-none transition-colors duration-150"
        >
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-foreground-500 mt-2">
        <cfg.Icon size={12} className={`flex-none ${cfg.text}`} />
        <span>{card.subtitle}</span>
      </div>
      {card.remaining > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          <span className="font-mono font-semibold tabular-nums text-warning">{card.remaining}</span>
          <span className="text-warning/80 font-medium">still due</span>
        </div>
      )}
    </div>
  );
}

// ── Droppable column wrapper ──────────────────────────────────────────────────
function DroppableColumn({ status, children }: { status: TeamTaskStatus; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`space-y-3 rounded-large min-h-[60px] p-1 -m-1 transition-colors duration-150 ${
        isOver ? 'bg-primary-50/50 dark:bg-primary-900/10' : ''
      }`}
    >
      {children}
    </div>
  );
}

export default function CommitteeBoardPage() {
  const router = useRouter();
  const { user, userData, role, loading: authLoading } = useUserRole();
  const { tasks, loading: tasksLoading } = useTeamTasks();
  const { cards: auditCards } = useAuditTaskCards();

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

  // Only admins/quartermasters are assignable as owners.
  const adminMembers = useMemo(
    () => members.filter((m) => m.role === 'admin' || m.role === 'quartermaster'),
    [members]
  );

  // Top-level view switcher: kanban Board vs. the standalone Buy List panel.
  // Deep-linkable via ?view=buylist (legacy ?view=tasks is aliased to it so old
  // links/bookmarks keep working); read/write window.location.search directly
  // (not useSearchParams — avoids the Suspense requirement under output: export).
  const [view, setView] = useState<BoardView>('board');
  useEffect(() => {
    if (typeof window === 'undefined' || authLoading) return;
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get('view');
    if ((v === 'buylist' || v === 'tasks') && isAdmin) setView('buylist');
  }, [authLoading, isAdmin]);

  const setViewSynced = (v: BoardView) => {
    setView(v);
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (v === 'buylist') sp.set('view', 'buylist'); else sp.delete('view');
    const qs = sp.toString();
    router.replace(`/committee-board${qs ? `?${qs}` : ''}`);
  };

  // Personal view toggle — filters the kanban in Board view, filters BuyListPanel in Buy List view
  const [viewMode, setViewMode] = useState<'all' | 'mine'>('all');

  // Controlled add-item modal for the Buy List view (Board view uses editModal below)
  const [buyAddOpen, setBuyAddOpen] = useState(false);

  // Drag state
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  // Add/Edit modal
  const editModal = useDisclosure();
  const [editingTask, setEditingTask] = useState<TeamTask | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formOwnerIds, setFormOwnerIds] = useState<string[]>([]);
  const [formDoD, setFormDoD] = useState('');
  const [formDue, setFormDue] = useState('');
  const [saving, setSaving] = useState(false);

  // Detail drawer — keep only the id so the drawer reflects live updates.
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const drawerTask = drawerId ? tasks.find((t) => t.id === drawerId) ?? null : null;
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [updateDraft, setUpdateDraft] = useState('');
  const [opLoading, setOpLoading] = useState(false);

  const visibleTasks = useMemo(() => {
    if (viewMode === 'mine' && user) {
      return tasks.filter((t) => t.owners.some((o) => o.id === user.uid));
    }
    return tasks;
  }, [tasks, viewMode, user]);

  const columns = useMemo(() => {
    const byStatus: Record<TeamTaskStatus, TeamTask[]> = {
      backlog: [], this_cycle: [], in_progress: [], blocked: [], done: [],
    };
    visibleTasks.forEach((t) => { if (t.status in byStatus) byStatus[t.status].push(t); });
    return byStatus;
  }, [visibleTasks]);

  // Header stat boxes count all real tasks (not the derived audit cards, not the filtered view).
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const blockedCount = tasks.filter((t) => t.status === 'blocked').length;
  const openCount = tasks.length - doneCount;

  const resetForm = () => {
    setFormTitle('');
    setFormOwnerIds(user?.uid ? [user.uid] : []);
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
    setFormOwnerIds(task.owners.map((o) => o.id));
    setFormDoD(task.definitionOfDone);
    setFormDue(task.dueDate ? toDateInputValue(task.dueDate) : '');
    editModal.onOpen();
  };

  const handleSave = async () => {
    const chosen = adminMembers.filter((m) => formOwnerIds.includes(m.id));
    if (!formTitle.trim() || !formDoD.trim() || chosen.length === 0) return;
    setSaving(true);
    try {
      const owners: TeamTaskOwner[] = chosen.map((m) => ({ id: m.id, name: m.fullName }));
      const payload = {
        title: formTitle.trim(),
        owners,
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
          subtasks: [],
          updates: [],
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
      if (drawerId === task.id) setDrawerId(null);
    } catch (err) {
      console.error('Failed to delete task:', err);
      alert('Failed to delete. Please try again.');
    }
  };

  // ── Subtask + update writes (drawer) ────────────────────────────────────────
  const persistSubtasks = async (task: TeamTask, subtasks: TeamSubtask[]) => {
    if (!task.id) return;
    setOpLoading(true);
    try {
      await updateDoc(doc(db, 'team_tasks', task.id), { subtasks });
    } catch (err) {
      console.error('Failed to update subtasks:', err);
      alert('Failed to update checklist. Please try again.');
    } finally {
      setOpLoading(false);
    }
  };

  const toggleSubtask = (task: TeamTask, id: string) =>
    persistSubtasks(task, (task.subtasks ?? []).map((s) => (s.id === id ? { ...s, done: !s.done } : s)));

  const addSubtask = (task: TeamTask) => {
    const text = subtaskDraft.trim();
    if (!text) return;
    setSubtaskDraft('');
    persistSubtasks(task, [...(task.subtasks ?? []), { id: `st-${Date.now()}`, text, done: false }]);
  };

  const deleteSubtask = (task: TeamTask, id: string) =>
    persistSubtasks(task, (task.subtasks ?? []).filter((s) => s.id !== id));

  const addUpdate = async (task: TeamTask) => {
    const text = updateDraft.trim();
    if (!text || !task.id) return;
    setUpdateDraft('');
    setOpLoading(true);
    try {
      await updateDoc(doc(db, 'team_tasks', task.id), {
        updates: arrayUnion({
          id: `u-${Date.now()}`,
          text,
          authorId: user?.uid ?? 'unknown',
          authorName: userData?.fullName ?? user?.email ?? 'Unknown',
          createdAt: Timestamp.now(),
        }),
      });
    } catch (err) {
      console.error('Failed to add update:', err);
      alert('Failed to add update. Please try again.');
    } finally {
      setOpLoading(false);
    }
  };

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;
    const dest = over.id as TeamTaskStatus;
    if (!STATUS_ORDER.includes(dest) || dest === task.status) return;
    handleStatusChange(task, dest);
  };

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;

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

  const canContribute = !!drawerTask && (isAdmin || drawerTask.owners.some((o) => o.id === user?.uid));

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
            {view === 'board' && (
              <div className="flex items-center gap-2 flex-wrap mt-1">
                <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                  <span className="font-mono font-semibold tabular-nums text-foreground">{openCount}</span>
                  <span className="text-xs text-foreground-400">open</span>
                </div>
                <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-danger">{blockedCount}</span>
                  <span className="text-xs text-danger/80 font-medium">blocked</span>
                </div>
                <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-success">{doneCount}</span>
                  <span className="text-xs text-success/80 font-medium">done</span>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Board vs. Buy List — only admins/quartermasters had access to the
                old /tasks page, so the tab (and the panel it opens) stays admin-only.
                This control cluster keeps a stable order/position across both views. */}
            {isAdmin && (
              <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
                {([
                  { mode: 'board' as const, icon: <SquareKanban size={14} />, label: 'Board' },
                  { mode: 'buylist' as const, icon: <ShoppingCart size={14} />, label: 'Buy List' },
                ]).map(({ mode, icon, label }) => (
                  <button
                    key={mode}
                    onClick={() => setViewSynced(mode)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                      view === mode ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                    }`}
                  >
                    {icon} {label}
                  </button>
                ))}
              </div>
            )}

            {/* All / Mine toggle — filters the kanban in Board view, filters BuyListPanel in Buy List view */}
            <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
              {([
                { mode: 'all' as const, icon: <LayoutGrid size={14} />, label: 'All' },
                { mode: 'mine' as const, icon: <UserRound size={14} />, label: 'Mine' },
              ]).map(({ mode, icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                    viewMode === mode ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>

            {isAdmin && (
              <Button
                color="primary"
                startContent={<Plus size={16} />}
                onPress={() => (view === 'board' ? openAdd() : setBuyAddOpen(true))}
              >
                {view === 'board' ? 'Add Task' : 'Add Item'}
              </Button>
            )}
          </div>
        </div>

        {view === 'buylist' && isAdmin ? (
          <BuyListPanel
            showHeader={false}
            viewMode={viewMode}
            addOpen={buyAddOpen}
            onAddOpenChange={setBuyAddOpen}
          />
        ) : (
          /* Five status columns */
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start">
              {STATUS_ORDER.map((status) => {
                const cfg = TASK_STATUS_CFG[status];
                const cards = columns[status];
                const auditInCol = viewMode === 'all' ? auditCards.filter((c) => c.status === status) : [];
                const total = cards.length + auditInCol.length;
                return (
                  <section key={status} className="min-w-0">
                    <div className="flex items-center gap-2 mb-3 px-1">
                      <cfg.Icon size={15} className={cfg.text} />
                      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                        {cfg.label}
                      </h2>
                      <span className="ml-auto font-mono text-xs font-semibold tabular-nums text-foreground-400">
                        {total}
                      </span>
                    </div>

                    <DroppableColumn status={status}>
                      {total === 0 && <p className="text-xs text-foreground-400 px-1">No tasks</p>}
                      {auditInCol.map((card) => (
                        <AuditCard key={card.id} card={card} onOpen={(href) => router.push(href)} />
                      ))}
                      {cards.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          isAdmin={isAdmin}
                          userUid={user?.uid}
                          onOpen={(t) => setDrawerId(t.id ?? null)}
                          onEdit={openEdit}
                          onDelete={handleDelete}
                        />
                      ))}
                    </DroppableColumn>
                  </section>
                );
              })}
            </div>

            <DragOverlay>
              {activeTask ? (
                <div className="bg-content1 border border-primary/40 rounded-large p-4 shadow-lg w-[260px] cursor-grabbing">
                  <p className="text-sm font-semibold text-foreground">{activeTask.title}</p>
                  <div className="flex items-center gap-1.5 text-xs text-foreground-500 mt-2">
                    <UserIcon size={12} className="flex-none text-foreground-400" />
                    <span className="truncate">{ownersLabel(activeTask.owners)}</span>
                  </div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {/* Detail drawer */}
      {drawerTask && (
        <PanelShell isOpen onClose={() => setDrawerId(null)} ariaLabel="Task detail">
            {/* Header */}
            <div className="px-6 py-5 border-b border-divider">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-lg text-foreground leading-tight">{drawerTask.title}</div>
                  <div className="flex items-center gap-1.5 text-xs text-foreground-500 mt-1">
                    <UserIcon size={12} className="flex-none text-foreground-400" />
                    <span className="truncate">{drawerTask.owners.map((o) => o.name).join(', ') || 'Unassigned'}</span>
                  </div>
                </div>
                <button
                  onClick={() => setDrawerId(null)}
                  className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex gap-1.5 flex-wrap mt-4 items-center">
                {(() => {
                  const cfg = TASK_STATUS_CFG[drawerTask.status];
                  return (
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-content2 ${cfg.text}`}>
                      <cfg.Icon size={12} /> {cfg.label}
                    </span>
                  );
                })()}
                {drawerTask.dueDate && (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-content2 ${isOverdue(drawerTask) ? 'text-danger' : 'text-foreground-500'}`}>
                    <CalendarClock size={12} />
                    {drawerTask.dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* Definition of done */}
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  <Target size={12} /> Done means
                </div>
                <p className="text-sm text-foreground-600 whitespace-pre-wrap">{drawerTask.definitionOfDone}</p>
              </div>

              {/* Subtasks */}
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                    <ListChecks size={12} /> Subtasks
                  </span>
                  {(drawerTask.subtasks ?? []).length > 0 && (
                    <span className="ml-auto font-mono text-xs font-semibold tabular-nums text-foreground-400">
                      {(drawerTask.subtasks ?? []).filter((s) => s.done).length}/{(drawerTask.subtasks ?? []).length}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {(drawerTask.subtasks ?? []).length === 0 && (
                    <p className="text-xs text-foreground-400">No subtasks yet.</p>
                  )}
                  {(drawerTask.subtasks ?? []).map((s) => (
                    <div key={s.id} className="flex items-center gap-2.5 bg-content2 rounded-large px-3 py-2">
                      <button
                        onClick={() => canContribute && toggleSubtask(drawerTask, s.id)}
                        disabled={!canContribute}
                        aria-label={s.done ? 'Mark not done' : 'Mark done'}
                        className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                          s.done ? 'bg-primary border-primary' : 'bg-transparent border-foreground-400'
                        } ${canContribute ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        <Check size={11} strokeWidth={3.5} className={s.done ? 'text-white' : 'text-transparent'} />
                      </button>
                      <span className={`flex-1 min-w-0 text-sm ${s.done ? 'text-foreground-400 line-through' : 'text-foreground'}`}>
                        {s.text}
                      </span>
                      {canContribute && (
                        <button
                          onClick={() => deleteSubtask(drawerTask, s.id)}
                          className="text-foreground-400 hover:text-danger transition-colors flex-none"
                          aria-label="Delete subtask"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {canContribute && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input
                      size="sm"
                      placeholder="Add a subtask…"
                      value={subtaskDraft}
                      onValueChange={setSubtaskDraft}
                      onKeyDown={(e) => { if (e.key === 'Enter') addSubtask(drawerTask); }}
                    />
                    <Button size="sm" variant="flat" color="primary" isIconOnly onPress={() => addSubtask(drawerTask)} aria-label="Add subtask">
                      <Plus size={16} />
                    </Button>
                  </div>
                )}
              </div>

              {/* Updates */}
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  <MessageSquare size={12} /> Updates
                </div>
                <div className="space-y-3">
                  {(drawerTask.updates ?? []).length === 0 && (
                    <p className="text-xs text-foreground-400">No updates yet.</p>
                  )}
                  {(drawerTask.updates ?? [])
                    .slice()
                    .reverse()
                    .map((u) => (
                      <div key={u.id} className="bg-content2 rounded-large px-3 py-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-foreground">{u.authorName}</span>
                          <span className="text-[11px] text-foreground-400">
                            {u.createdAt instanceof Date ? timeAgo(u.createdAt) : ''}
                          </span>
                        </div>
                        <p className="text-sm text-foreground-600 whitespace-pre-wrap">{u.text}</p>
                      </div>
                    ))}
                </div>
                {canContribute && (
                  <div className="mt-3 space-y-2">
                    <Textarea
                      placeholder="Add a progress note…"
                      value={updateDraft}
                      onValueChange={setUpdateDraft}
                      minRows={2}
                    />
                    <Button
                      size="sm"
                      color="primary"
                      variant="flat"
                      startContent={<MessageSquare size={14} />}
                      isDisabled={!updateDraft.trim()}
                      onPress={() => addUpdate(drawerTask)}
                    >
                      Add update
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Footer (admin actions) */}
            {isAdmin && (
              <div className="px-6 py-4 border-t border-divider flex gap-3">
                <Button variant="bordered" className="flex-1" startContent={<Edit3 size={15} />} onPress={() => { openEdit(drawerTask); }}>
                  Edit / Reassign
                </Button>
                <Button color="danger" variant="flat" className="flex-1" startContent={<Trash2 size={15} />} onPress={() => handleDelete(drawerTask)}>
                  Delete
                </Button>
              </div>
            )}
        </PanelShell>
      )}

      {/* Saving toast */}
      {opLoading && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}

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
              label="Owners"
              isRequired
              selectionMode="multiple"
              selectedKeys={new Set(formOwnerIds)}
              onSelectionChange={(keys) => setFormOwnerIds(Array.from(keys as Set<string>))}
              items={adminMembers}
              description="Only admins and quartermasters can be assigned."
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
              isDisabled={!formTitle.trim() || !formDoD.trim() || formOwnerIds.length === 0}
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
