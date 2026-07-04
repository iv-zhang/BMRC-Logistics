"use client";

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
} from "@heroui/react";
import {
  ShoppingCart,
  Plus,
  Trash2,
  ArrowUpDown,
  Truck,
  PackageCheck,
  Edit3,
  MoreVertical,
} from "lucide-react";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "@/firebase";
import { useUserRole } from "@/app/hooks/useUserRole";
import { addToBuyList } from "@/app/lib/buy-list";
import type { BuyListItem } from "@/app/types";

const PRIORITY_COLORS: Record<string, "default" | "primary" | "warning" | "danger"> = {
  low: "default",
  medium: "primary",
  high: "warning",
  urgent: "danger",
};

const STATUS_COLORS: Record<string, "default" | "primary" | "success"> = {
  pending: "default",
  ordered: "primary",
  received: "success",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <ShoppingCart size={14} />,
  ordered: <Truck size={14} />,
  received: <PackageCheck size={14} />,
};

export default function BuyListPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const { role: userRole } = useUserRole();
  const [items, setItems] = useState<BuyListItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters & sort
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<"addedAt" | "priority">("priority");

  // Add/Edit modal
  const addModal = useDisclosure();
  const [editingItem, setEditingItem] = useState<BuyListItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formQuantity, setFormQuantity] = useState("");
  const [formUnit, setFormUnit] = useState("boxes");
  const [formCategory, setFormCategory] = useState("");
  const [formPriority, setFormPriority] = useState<BuyListItem["priority"]>("medium");
  const [formNotes, setFormNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, "buyList"), orderBy("addedAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<BuyListItem, 'id'>) })) as BuyListItem[];
        setItems(data);
        setLoading(false);
      },
      (err) => {
        console.error("Failed to load buy list:", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const filteredItems = useMemo(() => {
    let result = [...items];

    // Status filter
    if (statusFilter !== "all") {
      result = result.filter((i) => i.status === statusFilter);
    }

    // Priority filter
    if (priorityFilter !== "all") {
      result = result.filter((i) => i.priority === priorityFilter);
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (i) =>
          i.itemName?.toLowerCase().includes(q) ||
          i.notes?.toLowerCase().includes(q) ||
          i.category?.toLowerCase().includes(q)
      );
    }

    // Sort
    if (sortField === "priority") {
      const order = { urgent: 0, high: 1, medium: 2, low: 3 };
      result.sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    }
    // addedAt is the default Firestore order (desc), already applied

    return result;
  }, [items, statusFilter, priorityFilter, searchQuery, sortField]);

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const orderedCount = items.filter((i) => i.status === "ordered").length;
  const receivedCount = items.filter((i) => i.status === "received").length;

  const resetForm = () => {
    setFormName("");
    setFormQuantity("");
    setFormUnit("boxes");
    setFormCategory("");
    setFormPriority("medium");
    setFormNotes("");
    setEditingItem(null);
  };

  const openAdd = () => {
    resetForm();
    addModal.onOpen();
  };

  const openEdit = (item: BuyListItem) => {
    setEditingItem(item);
    setFormName(item.itemName || "");
    setFormQuantity(String(item.quantity ?? ""));
    setFormUnit(item.unit || "boxes");
    setFormCategory(item.category || "");
    setFormPriority(item.priority || "medium");
    setFormNotes(item.notes || "");
    addModal.onOpen();
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      if (editingItem?.id) {
        // Update
        await updateDoc(doc(db, "buyList", editingItem.id), {
          itemName: formName.trim(),
          quantity: formQuantity ? Number(formQuantity) : null,
          unit: formUnit || null,
          category: formCategory || null,
          priority: formPriority,
          notes: formNotes || null,
        });
      } else {
        // Add new (de-duplicates against existing open entries)
        await addToBuyList(
          {
            itemName: formName.trim(),
            quantity: formQuantity ? Number(formQuantity) : null,
            unit: formUnit || null,
            category: formCategory || null,
            priority: formPriority,
            notes: formNotes || null,
          },
          { uid: user?.uid || "unknown", name: user?.displayName || user?.email || "Unknown" },
        );
      }
      addModal.onClose();
      resetForm();
    } catch (err) {
      console.error("Failed to save buy list item:", err);
      alert("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (item: BuyListItem, newStatus: BuyListItem["status"]) => {
    if (!item.id) return;
    try {
      const update: Record<string, unknown> = { status: newStatus };
      if (newStatus === "ordered") {
        update.orderedAt = serverTimestamp();
      }
      if (newStatus === "received") {
        update.receivedAt = serverTimestamp();
        update.completedBy = user?.uid || "unknown";
        update.completedByName = user?.displayName || user?.email || "Unknown";
      }
      await updateDoc(doc(db, "buyList", item.id), update);
    } catch (err) {
      console.error("Failed to update status:", err);
    }
  };

  const handleDelete = async (item: BuyListItem) => {
    if (!item.id) return;
    if (!confirm(`Remove "${item.itemName}" from buy list?`)) return;
    try {
      await deleteDoc(doc(db, "buyList", item.id));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  // Restrict to admin/quartermaster
  if (userRole !== "admin" && userRole !== "quartermaster") {
    return (
      <div className="min-h-screen p-6 bg-background">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-foreground-500">Only admins and quartermasters can access the Buy List.</p>
              <div className="mt-4">
                <Button onPress={() => router.push("/dashboard")}>Back to Dashboard</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-6 bg-background">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="text-amber-600" size={24} />
            <h1 className="text-2xl font-semibold">Buy List</h1>
            {pendingCount > 0 && (
              <Chip size="sm" color="warning" variant="solid">
                {pendingCount} to buy
              </Chip>
            )}
          </div>
          <Button color="primary" startContent={<Plus size={16} />} onPress={openAdd}>
            Add Item
          </Button>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          <Card className="bg-default-50">
            <CardBody className="text-center py-2 md:py-3">
              <p className="text-xl md:text-2xl font-semibold tabular-nums">{pendingCount}</p>
              <p className="text-xs text-default-500">Pending</p>
            </CardBody>
          </Card>
          <Card className="bg-primary-50">
            <CardBody className="text-center py-2 md:py-3">
              <p className="text-xl md:text-2xl font-semibold tabular-nums text-primary">{orderedCount}</p>
              <p className="text-xs text-primary-600">Ordered</p>
            </CardBody>
          </Card>
          <Card className="bg-success-50">
            <CardBody className="text-center py-2 md:py-3">
              <p className="text-2xl font-semibold tabular-nums text-success">{receivedCount}</p>
              <p className="text-xs text-success-600">Received</p>
            </CardBody>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardBody>
            <div className="flex flex-col md:flex-row gap-3 items-end">
              <Input
                placeholder="Search items..."
                value={searchQuery}
                onValueChange={setSearchQuery}
                isClearable
                onClear={() => setSearchQuery("")}
                className="flex-1"
                size="sm"
              />
              <Select
                size="sm"
                className="min-w-[130px]"
                label="Status"
                selectedKeys={[statusFilter]}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <SelectItem key="all">All Status</SelectItem>
                <SelectItem key="pending">Pending</SelectItem>
                <SelectItem key="ordered">Ordered</SelectItem>
                <SelectItem key="received">Received</SelectItem>
              </Select>
              <Select
                size="sm"
                className="min-w-[130px]"
                label="Priority"
                selectedKeys={[priorityFilter]}
                onChange={(e) => setPriorityFilter(e.target.value)}
              >
                <SelectItem key="all">All Priority</SelectItem>
                <SelectItem key="urgent">Urgent</SelectItem>
                <SelectItem key="high">High</SelectItem>
                <SelectItem key="medium">Medium</SelectItem>
                <SelectItem key="low">Low</SelectItem>
              </Select>
              <Button
                size="sm"
                variant="flat"
                startContent={<ArrowUpDown size={14} />}
                onPress={() => setSortField((prev) => (prev === "priority" ? "addedAt" : "priority"))}
              >
                {sortField === "priority" ? "By Priority" : "By Date"}
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Items list */}
        {filteredItems.length === 0 ? (
          <Card>
            <CardBody className="text-center py-12">
              <ShoppingCart size={48} className="mx-auto mb-3 text-foreground-400" />
              <p className="text-foreground-500">
                {items.length === 0
                  ? "No items in the buy list yet. Add items as you notice things in storage!"
                  : "No items match your filters."}
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2">
            {filteredItems.map((item) => {
              const addedDate = item.addedAt
                ? typeof (item.addedAt as unknown as { toDate?: () => Date }).toDate === "function"
                  ? (item.addedAt as unknown as { toDate: () => Date }).toDate()
                  : item.addedAt instanceof Date
                  ? item.addedAt
                  : null
                : null;

              return (
                <Card
                  key={item.id}
                  className={`transition-all ${item.status === "received" ? "opacity-60" : ""}`}
                >
                  <CardBody className="py-3">
                    <div className="flex items-start gap-3">
                      {/* Status icon */}
                      <div className="mt-1">{STATUS_ICONS[item.status] || <ShoppingCart size={14} />}</div>

                      {/* Main content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p
                            className={`font-semibold text-sm ${
                              item.status === "received" ? "line-through text-default-400" : ""
                            }`}
                          >
                            {item.itemName}
                          </p>
                          <Chip size="sm" variant="flat" color={PRIORITY_COLORS[item.priority] || "default"}>
                            {item.priority}
                          </Chip>
                          <Chip size="sm" variant="flat" color={STATUS_COLORS[item.status] || "default"}>
                            {item.status}
                          </Chip>
                          {item.category && (
                            <Chip size="sm" variant="flat" color="secondary">
                              {item.category}
                            </Chip>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-default-500 mt-1">
                          {item.quantity && (
                            <span>
                              {item.quantity} {item.unit || "units"}
                            </span>
                          )}
                          {item.addedByName && <span>Added by {item.addedByName}</span>}
                          {addedDate && <span>{addedDate.toLocaleDateString()}</span>}
                        </div>
                        {item.notes && (
                          <p className="text-xs text-default-500 mt-1 italic">{item.notes}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1">
                        {item.status === "pending" && (
                          <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            startContent={<Truck size={14} />}
                            onPress={() => handleStatusChange(item, "ordered")}
                          >
                            Mark Ordered
                          </Button>
                        )}
                        {item.status === "ordered" && (
                          <Button
                            size="sm"
                            color="success"
                            variant="flat"
                            startContent={<PackageCheck size={14} />}
                            onPress={() => handleStatusChange(item, "received")}
                          >
                            Received
                          </Button>
                        )}
                        {item.status === "received" && (
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => handleStatusChange(item, "pending")}
                          >
                            Reopen
                          </Button>
                        )}
                        <Dropdown>
                          <DropdownTrigger>
                            <Button isIconOnly size="sm" variant="light">
                              <MoreVertical size={14} />
                            </Button>
                          </DropdownTrigger>
                          <DropdownMenu>
                            <DropdownItem key="edit" startContent={<Edit3 size={14} />} onPress={() => openEdit(item)}>
                              Edit
                            </DropdownItem>
                            <DropdownItem
                              key="delete"
                              startContent={<Trash2 size={14} />}
                              color="danger"
                              className="text-danger"
                              onPress={() => handleDelete(item)}
                            >
                              Delete
                            </DropdownItem>
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
          <ModalHeader>{editingItem ? "Edit Buy List Item" : "Add to Buy List"}</ModalHeader>
          <ModalBody className="gap-4">
            <Input
              label="Item Name"
              placeholder="e.g., Glucose Strips, Nitrile Gloves L, ..."
              value={formName}
              onValueChange={setFormName}
              isRequired
              autoFocus
            />
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
            <div className="flex gap-3">
              <Select
                label="Category"
                className="flex-1"
                selectedKeys={formCategory ? [formCategory] : []}
                onChange={(e) => setFormCategory(e.target.value)}
              >
                <SelectItem key="Airway">Airway</SelectItem>
                <SelectItem key="Trauma">Trauma</SelectItem>
                <SelectItem key="Vitals">Vitals</SelectItem>
                <SelectItem key="Meds">Meds</SelectItem>
                <SelectItem key="PPE">PPE</SelectItem>
                <SelectItem key="Splinting">Splinting</SelectItem>
                <SelectItem key="Hygiene">Hygiene</SelectItem>
                <SelectItem key="Other">Other</SelectItem>
              </Select>
              <Select
                label="Priority"
                className="flex-1"
                selectedKeys={[formPriority]}
                onChange={(e) => setFormPriority(e.target.value as BuyListItem["priority"])}
              >
                <SelectItem key="low">Low</SelectItem>
                <SelectItem key="medium">Medium</SelectItem>
                <SelectItem key="high">High</SelectItem>
                <SelectItem key="urgent">Urgent</SelectItem>
              </Select>
            </div>
            <Textarea
              label="Notes"
              placeholder="Any details: brand preference, where you noticed it was low, supplier info..."
              value={formNotes}
              onValueChange={setFormNotes}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={() => {
                addModal.onClose();
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button color="primary" isLoading={saving} isDisabled={!formName.trim()} onPress={handleSave}>
              {editingItem ? "Save Changes" : "Add to Buy List"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
