"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardBody,
  Button,
  Input,
  Chip,
  Spinner,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Select,
  SelectItem,
  Textarea,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Tabs,
  Tab,
} from "@heroui/react";
import {
  CheckSquare,
  Plus,
  Trash2,
  ShoppingCart,
  Wrench,
  RefreshCw,
  Settings,
  MoreVertical,
  Edit3,
  CheckCircle2,
  ArrowUpDown,
  ListTodo,
  Package,
} from "lucide-react";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "@/firebase";
import { useUserRole } from "@/app/hooks/useUserRole";
import type { TaskItem, TaskCategory, BuyListItem } from "@/app/types";
import { TASK_STATUS_CFG, getTaskStatusCfg, TaskStatusBadge } from "@/app/components/task-status-badge";

const CATEGORY_CONFIG: Record<TaskCategory, { label: string; icon: React.ReactNode; color: "default" | "primary" | "secondary" | "success" | "warning" | "danger" }> = {
  buy: { label: "Buy", icon: <ShoppingCart size={14} />, color: "warning" },
  fix: { label: "Fix", icon: <Wrench size={14} />, color: "danger" },
  restock: { label: "Restock", icon: <RefreshCw size={14} />, color: "primary" },
  admin: { label: "Admin", icon: <Settings size={14} />, color: "secondary" },
  other: { label: "Other", icon: <ListTodo size={14} />, color: "default" },
};

const PRIORITY_COLORS: Record<string, "default" | "primary" | "warning" | "danger"> = {
  low: "default",
  medium: "primary",
  high: "warning",
  urgent: "danger",
};

const STATUS_CARD_BG: Record<TaskItem["status"], string> = {
  backlog: "bg-default-50",
  this_cycle: "bg-secondary-50",
  in_progress: "bg-primary-50",
  blocked: "bg-danger-50",
  done: "bg-success-50",
};

// Quick-toggle cycle; blocked is only entered explicitly via the menu
const NEXT_STATUS: Record<TaskItem["status"], TaskItem["status"]> = {
  backlog: "this_cycle",
  this_cycle: "in_progress",
  in_progress: "done",
  blocked: "in_progress",
  done: "backlog",
};

export default function TasksPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const { role: userRole } = useUserRole();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [buyItems, setBuyItems] = useState<BuyListItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [activeTab, setActiveTab] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<"priority" | "date">("priority");

  // Add/Edit modal
  const addModal = useDisclosure();
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState<TaskCategory>("other");
  const [formPriority, setFormPriority] = useState<TaskItem["priority"]>("medium");
  const [formQuantity, setFormQuantity] = useState("");
  const [formUnit, setFormUnit] = useState("boxes");
  const [formNotes, setFormNotes] = useState("");
  const [formDefinitionOfDone, setFormDefinitionOfDone] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Load tasks
  useEffect(() => {
    const q = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => {
        const raw = d.data() as Omit<TaskItem, "id" | "status"> & { status: string };
        // Tolerant reader: legacy docs wrote status 'todo'; normalize instead of migrating
        const status = (raw.status === "todo" ? "backlog" : raw.status) as TaskItem["status"];
        return { id: d.id, ...raw, status } as TaskItem;
      });
      setTasks(data);
      setLoading(false);
    }, (err) => {
      console.error("Failed to load tasks:", err);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Load buy list items too for the combined view
  useEffect(() => {
    const q = query(collection(db, "buyList"), orderBy("addedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BuyListItem, "id">) })) as BuyListItem[];
      setBuyItems(data);
    });
    return () => unsub();
  }, []);

  // Convert buy list items to task-like objects for unified view
  const buyListAsTasks: TaskItem[] = useMemo(() => {
    return buyItems.map((item) => ({
      id: `buy_${item.id}`,
      title: item.itemName,
      description: item.notes || undefined,
      category: "buy" as TaskCategory,
      priority: item.priority,
      status: item.status === "received" ? "done" as const : item.status === "ordered" ? "in_progress" as const : "backlog" as const,
      quantity: item.quantity,
      unit: item.unit,
      linkedBuyListId: item.id,
      createdBy: item.addedBy,
      createdByName: item.addedByName,
      createdAt: item.addedAt,
      notes: item.notes,
    }));
  }, [buyItems]);

  const allItems = useMemo(() => {
    if (activeTab === "buy") return buyListAsTasks;
    if (activeTab === "tasks") return tasks;
    return [...tasks, ...buyListAsTasks];
  }, [activeTab, tasks, buyListAsTasks]);

  const filteredItems = useMemo(() => {
    let result = [...allItems];

    // Status filter
    if (statusFilter === "active") {
      result = result.filter((t) => t.status !== "done");
    } else if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter);
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.title?.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.notes?.toLowerCase().includes(q)
      );
    }

    // Sort
    if (sortField === "priority") {
      const order = { urgent: 0, high: 1, medium: 2, low: 3 };
      result.sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    }

    return result;
  }, [allItems, statusFilter, searchQuery, sortField]);

  // Stats
  const statusCounts = useMemo(() => {
    const counts: Record<TaskItem["status"], number> = { backlog: 0, this_cycle: 0, in_progress: 0, blocked: 0, done: 0 };
    allItems.forEach((t) => { if (t.status in counts) counts[t.status] += 1; });
    return counts;
  }, [allItems]);
  const activeCount = allItems.length - statusCounts.done;

  const resetForm = () => {
    setFormTitle("");
    setFormDescription("");
    setFormCategory("other");
    setFormPriority("medium");
    setFormQuantity("");
    setFormUnit("boxes");
    setFormNotes("");
    setFormDefinitionOfDone("");
    setEditingTask(null);
  };

  const openAdd = (category?: TaskCategory) => {
    resetForm();
    if (category) setFormCategory(category);
    addModal.onOpen();
  };

  const openEdit = (task: TaskItem) => {
    setEditingTask(task);
    setFormTitle(task.title || "");
    setFormDescription(task.description || "");
    setFormCategory(task.category || "other");
    setFormPriority(task.priority || "medium");
    setFormQuantity(task.quantity ? String(task.quantity) : "");
    setFormUnit(task.unit || "boxes");
    setFormNotes(task.notes || "");
    setFormDefinitionOfDone(task.definitionOfDone || "");
    addModal.onOpen();
  };

  const handleSave = async () => {
    if (!formTitle.trim()) return;
    setSaving(true);
    try {
      const payload: any = {
        title: formTitle.trim(),
        description: formDescription || null,
        category: formCategory,
        priority: formPriority,
        quantity: formQuantity ? Number(formQuantity) : null,
        unit: formUnit || null,
        notes: formNotes || null,
        definitionOfDone: formDefinitionOfDone.trim() || null,
        updatedAt: serverTimestamp(),
      };

      if (editingTask?.id) {
        await updateDoc(doc(db, "tasks", editingTask.id), payload);
      } else {
        await addDoc(collection(db, "tasks"), {
          ...payload,
          status: "backlog",
          createdBy: user?.uid || "unknown",
          createdByName: user?.displayName || user?.email || "Unknown",
          createdAt: serverTimestamp(),
        });
      }
      addModal.onClose();
      resetForm();
    } catch (err) {
      console.error("Failed to save task:", err);
      alert("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (task: TaskItem, newStatus: TaskItem["status"]) => {
    // Handle buy list items through their own collection
    if (task.linkedBuyListId) {
      const buyStatus = newStatus === "done" ? "received" : newStatus === "in_progress" ? "ordered" : "pending";
      const update: Record<string, unknown> = { status: buyStatus };
      if (buyStatus === "ordered") update.orderedAt = serverTimestamp();
      if (buyStatus === "received") {
        update.receivedAt = serverTimestamp();
        update.completedBy = user?.uid || "unknown";
        update.completedByName = user?.displayName || user?.email || "Unknown";
      }
      await updateDoc(doc(db, "buyList", task.linkedBuyListId), update);
      return;
    }
    if (!task.id) return;
    const update: Record<string, unknown> = { status: newStatus, updatedAt: serverTimestamp() };
    if (newStatus === "done") {
      update.completedAt = serverTimestamp();
      update.completedBy = user?.uid || "unknown";
      update.completedByName = user?.displayName || user?.email || "Unknown";
    }
    await updateDoc(doc(db, "tasks", task.id), update);
  };

  const handleDelete = async (task: TaskItem) => {
    if (task.linkedBuyListId) {
      if (!confirm(`Remove "${task.title}" from buy list?`)) return;
      await deleteDoc(doc(db, "buyList", task.linkedBuyListId));
      return;
    }
    if (!task.id) return;
    if (!confirm(`Delete task "${task.title}"?`)) return;
    await deleteDoc(doc(db, "tasks", task.id));
  };

  if (loading) {
    return <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;
  }

  if (userRole !== "admin" && userRole !== "quartermaster") {
    return (
      <div className="min-h-screen p-6 bg-background">
        <div className="max-w-3xl mx-auto">
          <Card><CardBody className="text-center">
            <h2 className="text-xl font-semibold">Access Denied</h2>
            <p className="mt-2 text-sm text-foreground-500">Only admins and quartermasters can access the Tasks page.</p>
            <div className="mt-4"><Button onPress={() => router.push("/dashboard")}>Back to Dashboard</Button></div>
          </CardBody></Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-3 md:p-6 bg-gradient-to-br from-slate-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-5xl mx-auto space-y-4 md:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckSquare className="text-primary" size={24} />
            <h1 className="text-xl md:text-2xl font-semibold">Logistics Tasks</h1>
            {activeCount > 0 && (
              <Chip size="sm" color="warning" variant="solid">{activeCount} active</Chip>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Dropdown>
              <DropdownTrigger>
                <Button color="primary" startContent={<Plus size={16} />} size="sm">Add Task</Button>
              </DropdownTrigger>
              <DropdownMenu aria-label="Add task type">
                <DropdownItem key="buy" startContent={<ShoppingCart size={14} />} onPress={() => openAdd("buy")}>Buy Item</DropdownItem>
                <DropdownItem key="fix" startContent={<Wrench size={14} />} onPress={() => openAdd("fix")}>Fix Something</DropdownItem>
                <DropdownItem key="restock" startContent={<RefreshCw size={14} />} onPress={() => openAdd("restock")}>Restock</DropdownItem>
                <DropdownItem key="admin" startContent={<Settings size={14} />} onPress={() => openAdd("admin")}>Admin Task</DropdownItem>
                <DropdownItem key="other" startContent={<ListTodo size={14} />} onPress={() => openAdd("other")}>Other</DropdownItem>
              </DropdownMenu>
            </Dropdown>
          </div>
        </div>

        {/* Stats cards — one per status */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 md:gap-3">
          {(Object.keys(TASK_STATUS_CFG) as TaskItem["status"][]).map((s) => {
            const cfg = TASK_STATUS_CFG[s];
            return (
              <Card key={s} className={STATUS_CARD_BG[s]}><CardBody className="text-center py-2 md:py-3">
                <p className={`text-xl md:text-2xl font-semibold tabular-nums ${cfg.text}`}>{statusCounts[s]}</p>
                <p className={`text-xs ${cfg.text}`}>{cfg.label}</p>
              </CardBody></Card>
            );
          })}
        </div>

        {/* Tab filter + search */}
        <Card>
          <CardBody className="gap-3">
            <Tabs
              selectedKey={activeTab}
              onSelectionChange={(k) => setActiveTab(k as string)}
              variant="underlined"
              size="sm"
              classNames={{ tabList: "gap-4 w-full overflow-x-auto", tab: "px-0" }}
            >
              <Tab key="all" title="All" />
              <Tab key="tasks" title="Tasks Only" />
              <Tab key="buy" title={<span className="flex items-center gap-1"><ShoppingCart size={12} /> Buy List</span>} />
            </Tabs>
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <Input
                placeholder="Search tasks..."
                value={searchQuery}
                onValueChange={setSearchQuery}
                isClearable
                onClear={() => setSearchQuery("")}
                className="flex-1"
                size="sm"
              />
              <Select
                size="sm"
                className="min-w-[120px]"
                label="Status"
                selectedKeys={[statusFilter]}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <SelectItem key="active">Active</SelectItem>
                <SelectItem key="all">All</SelectItem>
                <SelectItem key="backlog">Backlog</SelectItem>
                <SelectItem key="this_cycle">This Cycle</SelectItem>
                <SelectItem key="in_progress">In Progress</SelectItem>
                <SelectItem key="blocked">Blocked</SelectItem>
                <SelectItem key="done">Done</SelectItem>
              </Select>
              <Button
                size="sm"
                variant="flat"
                startContent={<ArrowUpDown size={14} />}
                onPress={() => setSortField((prev) => (prev === "priority" ? "date" : "priority"))}
              >
                {sortField === "priority" ? "Priority" : "Date"}
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Task list */}
        {filteredItems.length === 0 ? (
          <Card><CardBody className="text-center py-12">
            <CheckSquare size={48} className="mx-auto mb-3 text-foreground-400" />
            <p className="text-foreground-500">
              {allItems.length === 0 ? "No tasks yet. Add items to buy, things to fix, or tasks to track!" : "No tasks match your filters."}
            </p>
          </CardBody></Card>
        ) : (
          <div className="space-y-2">
            {filteredItems.map((task) => {
              const catConfig = CATEGORY_CONFIG[task.category] || CATEGORY_CONFIG.other;
              const statusCfg = getTaskStatusCfg(task.status);
              const nextStatus = NEXT_STATUS[task.status];
              const nextCfg = getTaskStatusCfg(nextStatus);

              return (
                <Card
                  key={task.id || task.linkedBuyListId}
                  className={`transition-all ${task.status === "done" ? "opacity-60" : ""}`}
                >
                  <CardBody className="py-2 md:py-3">
                    <div className="flex items-start gap-2 md:gap-3">
                      {/* Quick status toggle — advances along NEXT_STATUS */}
                      <button
                        className="mt-1 flex-shrink-0"
                        title={`Move to ${nextCfg.label}`}
                        onClick={() => handleStatusChange(task, nextStatus)}
                      >
                        <statusCfg.Icon size={20} className={statusCfg.text} />
                      </button>

                      {/* Main content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`font-semibold text-sm ${task.status === "done" ? "line-through text-default-400" : ""}`}>
                            {task.title}
                          </p>
                          <Chip size="sm" variant="flat" color={catConfig.color} startContent={catConfig.icon}>
                            {catConfig.label}
                          </Chip>
                          <Chip size="sm" variant="flat" color={PRIORITY_COLORS[task.priority] || "default"}>
                            {task.priority}
                          </Chip>
                          <TaskStatusBadge status={task.status} />
                        </div>
                        {task.description && (
                          <p className="text-xs text-default-500 mt-1">{task.description}</p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-default-500 mt-1 flex-wrap">
                          {task.quantity && (
                            <span className="flex items-center gap-1"><Package size={10} /> {task.quantity} {task.unit || "units"}</span>
                          )}
                          {task.createdByName && <span>by {task.createdByName}</span>}
                          {task.notes && <span className="italic truncate max-w-[200px]">{task.notes}</span>}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {task.status !== "done" && (
                          <Button
                            size="sm"
                            color="success"
                            variant="flat"
                            isIconOnly
                            className="hidden sm:flex"
                            onPress={() => handleStatusChange(task, "done")}
                            aria-label="Mark done"
                          >
                            <CheckCircle2 size={14} />
                          </Button>
                        )}
                        <Dropdown>
                          <DropdownTrigger>
                            <Button isIconOnly size="sm" variant="light"><MoreVertical size={14} /></Button>
                          </DropdownTrigger>
                          <DropdownMenu
                            aria-label="Task actions"
                            items={[
                              ...(Object.keys(TASK_STATUS_CFG) as TaskItem["status"][])
                                .filter((s) => s !== task.status)
                                .map((s) => ({ key: `status_${s}`, kind: "status" as const, status: s })),
                              ...(task.linkedBuyListId ? [] : [{ key: "edit", kind: "edit" as const, status: task.status }]),
                              { key: "delete", kind: "delete" as const, status: task.status },
                            ]}
                          >
                            {(entry) => {
                              if (entry.kind === "edit") {
                                return <DropdownItem key="edit" startContent={<Edit3 size={14} />} onPress={() => openEdit(task)}>Edit</DropdownItem>;
                              }
                              if (entry.kind === "delete") {
                                return <DropdownItem key="delete" startContent={<Trash2 size={14} />} color="danger" className="text-danger" onPress={() => handleDelete(task)}>Delete</DropdownItem>;
                              }
                              const cfg = TASK_STATUS_CFG[entry.status];
                              return (
                                <DropdownItem key={entry.key} startContent={<cfg.Icon size={14} />} onPress={() => handleStatusChange(task, entry.status)}>
                                  Move to {cfg.label}
                                </DropdownItem>
                              );
                            }}
                          </DropdownMenu>
                        </Dropdown>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      <Modal isOpen={addModal.isOpen} onOpenChange={addModal.onOpenChange} size="lg">
        <ModalContent>
          <ModalHeader>{editingTask ? "Edit Task" : "Add New Task"}</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              label="Title"
              placeholder="e.g., Order nitrile gloves, Fix O2 regulator, ..."
              value={formTitle}
              onValueChange={setFormTitle}
              isRequired
              autoFocus
            />
            <Textarea
              label="Description (optional)"
              placeholder="Details about this task..."
              value={formDescription}
              onValueChange={setFormDescription}
              minRows={2}
            />
            <div className="flex gap-3">
              <Select
                label="Category"
                className="flex-1"
                selectedKeys={[formCategory]}
                onChange={(e) => setFormCategory(e.target.value as TaskCategory)}
              >
                <SelectItem key="buy" startContent={<ShoppingCart size={14} />}>Buy</SelectItem>
                <SelectItem key="fix" startContent={<Wrench size={14} />}>Fix</SelectItem>
                <SelectItem key="restock" startContent={<RefreshCw size={14} />}>Restock</SelectItem>
                <SelectItem key="admin" startContent={<Settings size={14} />}>Admin</SelectItem>
                <SelectItem key="other" startContent={<ListTodo size={14} />}>Other</SelectItem>
              </Select>
              <Select
                label="Priority"
                className="flex-1"
                selectedKeys={[formPriority]}
                onChange={(e) => setFormPriority(e.target.value as TaskItem["priority"])}
              >
                <SelectItem key="low">Low</SelectItem>
                <SelectItem key="medium">Medium</SelectItem>
                <SelectItem key="high">High</SelectItem>
                <SelectItem key="urgent">Urgent</SelectItem>
              </Select>
            </div>
            {formCategory === "buy" && (
              <div className="flex gap-3">
                <Input
                  label="Quantity"
                  type="number"
                  placeholder="e.g., 5"
                  value={formQuantity}
                  onValueChange={setFormQuantity}
                  className="flex-1"
                />
                <Select
                  label="Unit"
                  className="flex-1"
                  selectedKeys={[formUnit]}
                  onChange={(e) => setFormUnit(e.target.value)}
                >
                  <SelectItem key="boxes">Boxes</SelectItem>
                  <SelectItem key="each">Each</SelectItem>
                  <SelectItem key="cases">Cases</SelectItem>
                  <SelectItem key="packs">Packs</SelectItem>
                  <SelectItem key="rolls">Rolls</SelectItem>
                  <SelectItem key="bags">Bags</SelectItem>
                  <SelectItem key="other">Other</SelectItem>
                </Select>
              </div>
            )}
            <Textarea
              label="Notes"
              placeholder="Any additional notes..."
              value={formNotes}
              onValueChange={setFormNotes}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => { addModal.onClose(); resetForm(); }}>Cancel</Button>
            <Button color="primary" isLoading={saving} isDisabled={!formTitle.trim()} onPress={handleSave}>
              {editingTask ? "Save Changes" : "Add Task"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
