'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, CardBody, Chip, Progress, Button, Spinner, useDisclosure, Input,
  Select, SelectItem, Tooltip
} from '@heroui/react';
import {
  Boxes, Plus, Minus, Search, Wind, PackageOpen, Filter, X, Edit2,
  ChevronDown, MapPin, Download, AlertTriangle, CalendarClock
} from 'lucide-react';

// Firebase
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection, addDoc, updateDoc, doc, onSnapshot, query, orderBy,
  serverTimestamp, Timestamp, getDoc
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { recordAuditEvent } from '../lib/audit';

// Components
import InventoryModal from '@/app/components/additemmodal';
import ConsumeBoxModal from '@/app/components/consume-box-modal';

// Utilities
import { getOldestValidBatch, isBatchExpired } from '@/app/utils/batchHelpers';
import { preparePayload, safeParseDate } from '@/app/utils/inventoryNormalization';
import { formatStorageLocation } from '@/app/utils/storage-location';

// Types
import type { InventoryItem, InventoryBatch, ItemCategory, User, BatchStatus } from '@/app/types';

// ─── Constants ──────────────────────────────────────────────────────────────
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];

const STATUS_COLORS: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'primary' | 'secondary'> = {
  sealed: 'primary',
  open: 'success',
  depleted: 'default',
  expired: 'danger',
  quarantined: 'warning',
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function getStockStatusColor(stock: number, threshold: number): string {
  if (stock <= 0) return 'text-red-600';
  if (stock <= threshold) return 'text-amber-500';
  return 'text-green-600';
}

/** Compute bag-aware stock totals for an item, falling back to legacy box model. */
function computeBagStock(item: InventoryItem) {
  const batches = item.batches || [];
  const hasBagTracking = batches.some(
    b => (b.bagCount !== undefined && b.bagCount > 0) || (b.itemsPerBag !== undefined && (b.itemsPerBag ?? 0) > 0)
  );

  if (hasBagTracking) {
    let totalBags = 0;
    let totalLoose = 0;
    let totalItems = 0;
    for (const b of batches) {
      const bags = b.bagCount ?? 0;
      const perBag = b.itemsPerBag ?? 0;
      const loose = b.looseItems ?? 0;
      totalBags += bags;
      totalLoose += loose;
      totalItems += bags * perBag + loose;
    }
    return { totalBags, totalLoose, totalItems, hasBagTracking: true };
  }

  // Legacy model
  const boxes = item.unopenedBoxes ?? 0;
  const perBox = item.itemsPerBox ?? 0;
  const loose = item.looseUnits ?? 0;
  const totalItems = perBox > 0 ? boxes * perBox + loose : boxes;
  return { totalBags: boxes, totalLoose: loose, totalItems, hasBagTracking: false };
}

/** Format item location, preferring StorageLocationRef. */
function displayLocation(item: InventoryItem): string {
  if (item.storageLocation) {
    return formatStorageLocation(item.storageLocation);
  }
  const parts = [item.location || '', item.room || ''];
  if (item.shelf) parts.push(`Shelf ${item.shelf}`);
  if (item.backLevel) parts.push(`L${item.backLevel}`);
  return parts.filter(Boolean).join(' › ');
}

// ─── Page Component ─────────────────────────────────────────────────────────
export default function InventoryPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [opLoading, setOpLoading] = useState(false);

  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [, setUserRole] = useState<string>('member');
  const [isAdmin, setIsAdmin] = useState(false);

  // Search & filter
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);

  // Card expansion
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  // Modals
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [consumeBoxModalOpen, setConsumeBoxModalOpen] = useState(false);
  const [consumeBoxItem, setConsumeBoxItem] = useState<InventoryItem | null>(null);

  // ── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) { setUser(u); setLoading(false); }
      else { router.push('/login'); }
    });
    return unsub;
  }, [router]);

  // ── Fetch user role ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
          const data = snap.data() as User;
          setUserRole(data.role || 'member');
          setIsAdmin(data.role === 'admin' || data.role === 'quartermaster');
        }
      } catch (e) { console.error('Role fetch error', e); }
    })();
  }, [user]);

  // ── Inventory listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      const items: InventoryItem[] = snap.docs.map((d) => {
        const raw = d.data();
        const item: InventoryItem = {
          id: d.id,
          name: raw.name || '',
          category: raw.category || 'Other',
          location: raw.location || 'HQ',
          room: raw.room || '',
          shelf: raw.shelf,
          backShelf: raw.backShelf,
          backLevel: raw.backLevel ? Number(raw.backLevel) : undefined,
          storageLocation: raw.storageLocation || undefined,
          unopenedBoxes: Number(raw.unopenedBoxes ?? 0),
          itemsPerBox: raw.itemsPerBox ? Number(raw.itemsPerBox) : undefined,
          looseUnits: Number(raw.looseUnits ?? 0),
          totalStockQuantity: Number(raw.totalStockQuantity ?? 0),
          reorderThreshold: Number(raw.reorderThreshold ?? 0),
          tracksExpiration: raw.tracksExpiration ?? false,
          isOxygen: raw.isOxygen ?? false,
          oxygenPsi: raw.oxygenPsi ? Number(raw.oxygenPsi) : undefined,
          maxOxygenPsi: raw.maxOxygenPsi ? Number(raw.maxOxygenPsi) : undefined,
          oxygenModel: raw.oxygenModel,
          isReagent: raw.isReagent ?? false,
          daysValidAfterOpening: raw.daysValidAfterOpening ? Number(raw.daysValidAfterOpening) : undefined,
          isAsset: raw.isAsset ?? false,
          barcode: raw.barcode,
          unit: raw.unit,
          description: raw.description,
          hasVariants: false,
          createdAt: raw.createdAt instanceof Timestamp ? raw.createdAt.toDate() : (raw.createdAt ? new Date(raw.createdAt) : new Date()),
          updatedAt: raw.updatedAt instanceof Timestamp ? raw.updatedAt.toDate() : (raw.updatedAt ? new Date(raw.updatedAt) : new Date()),
          batches: [],
        };

        // Normalize batches from Firestore
        if (Array.isArray(raw.batches) && raw.batches.length > 0) {
          item.batches = raw.batches.map((b: Record<string, unknown>) => ({
            id: (b.id as string) || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            lotNumber: (b.lotNumber as string) || '',
            expirationDate: safeParseDate(
              b.expirationDate instanceof Timestamp ? (b.expirationDate as Timestamp).toDate() : (b.expirationDate as string | Date | undefined)
            ),
            stock: Number(b.stock ?? 0),
            openDate: safeParseDate(
              b.openDate instanceof Timestamp ? (b.openDate as Timestamp).toDate() : (b.openDate as string | Date | undefined)
            ),
            receivedAt: safeParseDate(
              b.receivedAt instanceof Timestamp ? (b.receivedAt as Timestamp).toDate() : (b.receivedAt as string | Date | undefined)
            ),
            locations: Array.isArray(b.locations) ? (b.locations as InventoryBatch['locations']) : [],
            serialNumbers: Array.isArray(b.serialNumbers) ? (b.serialNumbers as string[]) : [],
            purchase: (b.purchase as InventoryBatch['purchase']) || undefined,
            // Bag tracking fields
            bagCount: b.bagCount !== undefined ? Number(b.bagCount) : undefined,
            itemsPerBag: b.itemsPerBag !== undefined ? Number(b.itemsPerBag) : undefined,
            looseItems: b.looseItems !== undefined ? Number(b.looseItems) : undefined,
            status: (b.status as BatchStatus) || undefined,
            openedAt: safeParseDate(
              b.openedAt instanceof Timestamp ? (b.openedAt as Timestamp).toDate() : (b.openedAt as string | Date | undefined)
            ),
            openedBy: (b.openedBy as string) || undefined,
            supplier: (b.supplier as string) || undefined,
            notes: (b.notes as string) || undefined,
          }));
        }

        return item;
      });

      // Filter out assets — they belong on the assets page
      setInventory(items.filter(i => !i.isAsset));
    });
    return unsub;
  }, [user]);

  // ── CRUD: Add Item ────────────────────────────────────────────────────────
  async function handleAddItem(data: Partial<InventoryItem>) {
    if (!user) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({
        ...data,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      });
      await addDoc(collection(db, 'inventory'), payload);
      await recordAuditEvent({
        eventType: 'item_added',
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name, category: data.category },
      });
    } catch (e) {
      console.error('Add item failed:', e);
      alert('Failed to add item');
    } finally {
      setOpLoading(false);
    }
  }

  // ── CRUD: Update Item ─────────────────────────────────────────────────────
  async function handleUpdateItem(id: string, data: Partial<InventoryItem>) {
    if (!user || !id) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({
        ...data,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      });
      await updateDoc(doc(db, 'inventory', id), payload);
      await recordAuditEvent({
        eventType: 'item_updated',
        sourceId: id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name },
      });
    } catch (e) {
      console.error('Update item failed:', e);
      alert('Failed to update item');
    } finally {
      setOpLoading(false);
    }
  }

  // ── Open Bag (FIFO) ──────────────────────────────────────────────────────
  async function handleOpenBag(item: InventoryItem, batchId?: string) {
    if (!user) return;

    // Find the target batch — either the specified one or the oldest with sealed bags
    const batches = item.batches || [];
    let targetBatch: InventoryBatch | undefined;

    if (batchId) {
      targetBatch = batches.find(b => b.id === batchId);
    } else {
      // FIFO: oldest batch with sealed bags (by expiration date)
      targetBatch = batches
        .filter(b => (b.bagCount ?? 0) > 0 && b.status !== 'expired' && b.status !== 'quarantined')
        .sort((a, b) => {
          const aDate = a.expirationDate?.getTime() ?? Infinity;
          const bDate = b.expirationDate?.getTime() ?? Infinity;
          return aDate - bDate;
        })[0];
    }

    if (!targetBatch || (targetBatch.bagCount ?? 0) <= 0) {
      alert('No sealed bags available to open.');
      return;
    }

    const perBag = targetBatch.itemsPerBag ?? 0;
    if (!confirm(
      `Open 1 sealed bag from Lot ${targetBatch.lotNumber || '(no lot)'}?\n` +
      `This will release ${perBag} items as loose stock.`
    )) return;

    setOpLoading(true);
    try {
      const updatedBatches = batches.map(b => {
        if (b.id !== targetBatch!.id) return b;
        const newBagCount = (b.bagCount ?? 0) - 1;
        const newLoose = (b.looseItems ?? 0) + perBag;
        return {
          ...b,
          bagCount: newBagCount,
          looseItems: newLoose,
          status: (newBagCount === 0 && newLoose === 0 ? 'depleted' : 'open') as BatchStatus,
          openedAt: new Date(),
          openedBy: user.displayName || user.email || user.uid,
        };
      });

      // Recalculate item-level legacy totals
      const totalBags = updatedBatches.reduce((s, b) => s + (b.bagCount ?? 0), 0);
      const totalLoose = updatedBatches.reduce((s, b) => s + (b.looseItems ?? 0), 0);
      const totalStock = updatedBatches.reduce(
        (s, b) => s + (b.bagCount ?? 0) * (b.itemsPerBag ?? 0) + (b.looseItems ?? 0), 0
      );

      await updateDoc(doc(db, 'inventory', item.id), {
        batches: updatedBatches,
        unopenedBoxes: totalBags,
        looseUnits: totalLoose,
        totalStockQuantity: totalStock,
        updatedAt: serverTimestamp(),
      });

      await recordAuditEvent({
        eventType: 'bag_opened',
        sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: targetBatch.id, lotNumber: targetBatch.lotNumber, itemsReleased: perBag },
      });
    } catch (e) {
      console.error('Open bag failed:', e);
      alert('Failed to open bag');
    } finally {
      setOpLoading(false);
    }
  }

  // ── Quick Stock Adjust (+/- 1 unit) ───────────────────────────────────────
  async function handleQuickAdjust(itemId: string, delta: number) {
    if (!user) return;
    setOpLoading(true);
    try {
      const itemDoc = await getDoc(doc(db, 'inventory', itemId));
      if (!itemDoc.exists()) return;
      const current = itemDoc.data();

      const newUnopened = Math.max(0, (Number(current.unopenedBoxes) || 0) + delta);
      const newTotal = Math.max(0, (Number(current.totalStockQuantity) || 0) + delta);

      await updateDoc(doc(db, 'inventory', itemId), {
        unopenedBoxes: newUnopened,
        totalStockQuantity: newTotal,
        updatedAt: serverTimestamp(),
      });

      const item = inventory.find(i => i.id === itemId);
      await recordAuditEvent({
        eventType: 'stock_adjusted',
        sourceId: itemId,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item?.name, delta, newStock: newUnopened },
      });
    } catch (e) {
      console.error('Stock adjust failed:', e);
    } finally {
      setOpLoading(false);
    }
  }

  // ── Restock Forward (move from storage to front bin) ──────────────────────
  async function handleRestockForward(item: InventoryItem) {
    if (!user) return;
    const oldest = getOldestValidBatch(item.batches || [], item);
    const batchInfo = oldest
      ? `Lot: ${oldest.lotNumber || 'N/A'}, Exp: ${oldest.expirationDate ? oldest.expirationDate.toLocaleDateString() : 'N/A'}`
      : '';

    if (!confirm(
      `Move oldest batch of "${item.name}" to front shelf for restocking?\n${batchInfo}`
    )) return;

    setOpLoading(true);
    try {
      await addDoc(collection(db, 'restock_reports'), {
        itemId: item.id,
        itemName: item.name,
        category: item.category,
        batchId: oldest?.id || null,
        lotNumber: oldest?.lotNumber || null,
        quantity: oldest?.stock || item.unopenedBoxes || 0,
        from: displayLocation(item),
        to: 'Front Restock Bin',
        userId: user.uid,
        userName: user.displayName || user.email || '',
        timestamp: serverTimestamp(),
      });

      await recordAuditEvent({
        eventType: 'restock_forward',
        sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: oldest?.id, from: displayLocation(item) },
      });

      alert(`Restock report created for "${item.name}".`);
    } catch (e) {
      console.error('Restock forward failed:', e);
      alert('Failed to create restock report');
    } finally {
      setOpLoading(false);
    }
  }

  // ── CSV Export ────────────────────────────────────────────────────────────
  function exportCSV() {
    const headers = ['Name', 'Category', 'Location', 'Sealed Bags', 'Loose Items', 'Total Stock', 'Reorder Threshold', 'Unit'];
    const rows = filteredInventory.map(item => {
      const bag = computeBagStock(item);
      return [
        item.name,
        item.category,
        displayLocation(item),
        bag.totalBags,
        bag.totalLoose,
        bag.totalItems,
        item.reorderThreshold,
        item.unit || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Filtered inventory ────────────────────────────────────────────────────
  const filteredInventory = useMemo(() => {
    let list = [...inventory];

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(i =>
        i.name.toLowerCase().includes(term) ||
        (i.barcode || '').toLowerCase().includes(term) ||
        displayLocation(i).toLowerCase().includes(term)
      );
    }

    if (categoryFilter) {
      list = list.filter(i => i.category === categoryFilter);
    }

    return list;
  }, [inventory, searchTerm, categoryFilter]);

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openNewModal() { setSelectedItem(null); onOpen(); }
  function openEditModal(item: InventoryItem) { setSelectedItem(item); onOpen(); }
  function toggleExpand(itemId: string) {
    setExpandedItemId(prev => prev === itemId ? null : itemId);
  }

  // ── Loading / unauth guard ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" label="Loading inventory..." />
      </div>
    );
  }
  if (!user) return null;

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <div className="max-w-5xl mx-auto px-3 md:px-4 py-4 md:py-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4 md:mb-6">
          <div className="flex items-center gap-3">
            <Boxes size={24} className="text-indigo-600" />
            <h1 className="text-xl md:text-2xl font-bold">Inventory</h1>
            <Chip size="sm" variant="flat">{filteredInventory.length} items</Chip>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="flat" startContent={<Download size={14} />} onPress={() => exportCSV()}>
              Export
            </Button>
            {isAdmin && (
              <Button color="primary" size="sm" startContent={<Plus size={16} />} onPress={openNewModal}>
                Add Item
              </Button>
            )}
          </div>
        </div>

        {/* ── Search & Filter ────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 mb-4">
          <Input
            placeholder="Search items, locations, barcodes..."
            startContent={<Search size={16} className="text-gray-400" />}
            value={searchTerm}
            onValueChange={setSearchTerm}
            className="flex-1"
            size="sm"
            isClearable
            onClear={() => setSearchTerm('')}
          />
          <Button
            isIconOnly size="sm"
            variant={showFilters ? 'solid' : 'flat'}
            color={showFilters ? 'primary' : 'default'}
            onPress={() => setShowFilters(!showFilters)}
          >
            <Filter size={16} />
          </Button>
        </div>

        {showFilters && (
          <Card className="mb-4">
            <CardBody className="p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Select
                  label="Category"
                  size="sm"
                  className="w-48"
                  selectedKeys={categoryFilter ? [categoryFilter] : []}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setCategoryFilter(val || '');
                  }}
                >
                  {CATEGORIES.map(c => (
                    <SelectItem key={c}>{c}</SelectItem>
                  ))}
                </Select>
                {categoryFilter && (
                  <Button size="sm" variant="light" startContent={<X size={12} />} onPress={() => setCategoryFilter('')}>
                    Clear
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
        )}

        {/* ── Operation spinner ──────────────────────────────────────────── */}
        {opLoading && (
          <div className="text-center py-2">
            <Spinner size="sm" label="Saving..." />
          </div>
        )}

        {/* ── Inventory Cards ────────────────────────────────────────────── */}
        <div className="space-y-3">
          {filteredInventory.length === 0 && (
            <Card>
              <CardBody className="text-center py-12">
                <PackageOpen size={40} className="mx-auto text-gray-300 mb-3" />
                <p className="text-gray-500">No items found.</p>
              </CardBody>
            </Card>
          )}

          {filteredInventory.map((item) => {
            const bag = computeBagStock(item);
            const isExpanded = expandedItemId === item.id;
            const location = displayLocation(item);
            const isLowStock = bag.totalItems <= item.reorderThreshold && item.reorderThreshold > 0;
            const hasExpiredBatches = (item.batches || []).some(b => isBatchExpired(b, item));
            const hasSealedBags = bag.totalBags > 0 && bag.hasBagTracking;

            return (
              <div key={item.id}>
                {/* ── Item Card ───────────────────────────────────────────── */}
                <Card className={`transition-all ${isLowStock ? 'border-l-4 border-l-amber-400' : ''} ${hasExpiredBatches ? 'border-l-4 border-l-red-400' : ''}`}>
                  <CardBody
                    className="p-4"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(item.id);
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      {/* ── Left: Info ──────────────────────────────────── */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold text-lg truncate">{item.name}</h3>
                          <Chip size="sm" variant="flat" color="primary">{item.category}</Chip>
                          {item.isOxygen && (
                            <Chip size="sm" variant="flat" color="secondary">
                              <Wind size={10} className="mr-1 inline" />O₂
                            </Chip>
                          )}
                          {isLowStock && (
                            <Chip size="sm" variant="flat" color="warning">
                              <AlertTriangle size={10} className="mr-1 inline" />Low
                            </Chip>
                          )}
                          {hasExpiredBatches && (
                            <Chip size="sm" variant="flat" color="danger">
                              <CalendarClock size={10} className="mr-1 inline" />Expired
                            </Chip>
                          )}
                        </div>

                        {/* Location */}
                        {location && (
                          <div className="flex items-center gap-1 text-sm text-gray-500 mb-1">
                            <MapPin size={12} />
                            <span className="truncate">{location}</span>
                          </div>
                        )}

                        {/* Batch summary chips */}
                        {(item.batches || []).length > 0 && (
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {bag.hasBagTracking && (
                              <>
                                <Chip size="sm" variant="dot" color="primary">
                                  {bag.totalBags} sealed bag{bag.totalBags !== 1 ? 's' : ''}
                                </Chip>
                                <Chip size="sm" variant="dot" color="success">
                                  {bag.totalLoose} loose
                                </Chip>
                              </>
                            )}
                            <Chip size="sm" variant="flat" color="default">
                              {(item.batches || []).length} batch{(item.batches || []).length !== 1 ? 'es' : ''}
                            </Chip>
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <Tooltip content="Edit item">
                            <Button
                              isIconOnly size="sm" variant="light"
                              onPress={() => openEditModal(item)}
                            >
                              <Edit2 size={14} />
                            </Button>
                          </Tooltip>

                          {hasSealedBags && (
                            <Button
                              size="sm" variant="flat" color="secondary"
                              startContent={<PackageOpen size={12} />}
                              onPress={() => handleOpenBag(item)}
                            >
                              Open Bag
                            </Button>
                          )}

                          {!bag.hasBagTracking && (item.unopenedBoxes || 0) > 0 && (
                            <Button
                              size="sm" variant="flat" color="primary"
                              onPress={() => {
                                setConsumeBoxItem(item);
                                setConsumeBoxModalOpen(true);
                              }}
                            >
                              Consume Box
                            </Button>
                          )}

                          {bag.totalItems > 0 && !item.isOxygen && (
                            <Button
                              size="sm" variant="flat" color="default"
                              onPress={() => handleRestockForward(item)}
                            >
                              Restock Forward
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* ── Right: Stock display ──────────────────────────── */}
                      {item.isOxygen ? (
                        <div className="w-32 text-right flex-shrink-0">
                          <p className="text-2xl font-bold text-blue-600">{item.oxygenPsi ?? 0}</p>
                          <p className="text-xs text-gray-500 uppercase">PSI</p>
                          <Progress
                            size="sm"
                            value={((item.oxygenPsi ?? 0) / (item.maxOxygenPsi ?? 1)) * 100}
                            color={(item.oxygenPsi ?? 0) < 500 ? 'danger' : 'primary'}
                            aria-label="Oxygen Level"
                            className="mt-1"
                          />
                          <p className="text-[10px] text-gray-400 mt-1">Max: {item.maxOxygenPsi}</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-end flex-shrink-0">
                          <div className="flex items-center gap-3">
                            {/* Minus button */}
                            <div
                              role="button"
                              tabIndex={0}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); handleQuickAdjust(item.id, -1); }}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleQuickAdjust(item.id, -1); } }}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-white bg-slate-600 hover:bg-slate-700 shadow-sm cursor-pointer"
                              aria-label="Decrease stock"
                            >
                              <Minus size={14} />
                            </div>

                            {/* Stock number */}
                            <div className="text-center min-w-[60px]">
                              {bag.hasBagTracking ? (
                                <>
                                  <p className={`text-3xl font-bold ${getStockStatusColor(bag.totalItems, item.reorderThreshold)}`}>
                                    {bag.totalItems}
                                  </p>
                                  <p className="text-xs text-gray-500 uppercase">Total Items</p>
                                  <p className="text-[10px] text-gray-400">
                                    {bag.totalBags} bag{bag.totalBags !== 1 ? 's' : ''} + {bag.totalLoose} loose
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className={`text-3xl font-bold ${getStockStatusColor(item.unopenedBoxes, item.reorderThreshold)}`}>
                                    {item.unopenedBoxes}
                                  </p>
                                  <p className="text-xs text-gray-500 uppercase">
                                    {item.itemsPerBox ? 'Boxes' : 'Units'}
                                  </p>
                                  {item.itemsPerBox && (
                                    <>
                                      <p className="text-[10px] text-gray-400">{item.itemsPerBox} per box</p>
                                      <p className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                                        {(item.unopenedBoxes * item.itemsPerBox) + (item.looseUnits ?? 0)} total
                                      </p>
                                    </>
                                  )}
                                  {!item.itemsPerBox && (item.looseUnits ?? 0) > 0 && (
                                    <p className="text-[10px] text-gray-400">+ {item.looseUnits} loose</p>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Plus button */}
                            <div
                              role="button"
                              tabIndex={0}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); handleQuickAdjust(item.id, 1); }}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleQuickAdjust(item.id, 1); } }}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-white bg-slate-600 hover:bg-slate-700 shadow-sm cursor-pointer"
                              aria-label="Increase stock"
                            >
                              <Plus size={14} />
                            </div>
                          </div>

                          {/* Progress bar */}
                          {item.reorderThreshold > 0 && (
                            <Progress
                              size="sm"
                              value={Math.min(100, (bag.totalItems / (item.reorderThreshold * 2)) * 100)}
                              color={bag.totalItems <= item.reorderThreshold ? 'warning' : 'success'}
                              aria-label="Stock level"
                              className="mt-2 w-full max-w-[140px]"
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {/* Expand chevron */}
                    <div className="flex justify-center mt-2">
                      <ChevronDown
                        size={16}
                        className={`text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </div>
                  </CardBody>
                </Card>

                {/* ── Expanded Batch Detail ──────────────────────────────── */}
                {isExpanded && (
                  <Card className="mt-2 border animate-appearance-in">
                    <CardBody className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold">Batches — {item.name}</h4>
                        <Button size="sm" variant="flat" onPress={() => setExpandedItemId(null)}>
                          Close
                        </Button>
                      </div>

                      {(item.batches || []).length === 0 ? (
                        <p className="text-sm text-gray-500">
                          No batches recorded. Stock is tracked at the item level.
                        </p>
                      ) : (
                        <div className="space-y-2 max-h-80 overflow-y-auto">
                          {(item.batches || []).map((batch) => {
                            const expired = isBatchExpired(batch, item);
                            const batchBags = batch.bagCount ?? 0;
                            const batchPerBag = batch.itemsPerBag ?? 0;
                            const batchLoose = batch.looseItems ?? 0;
                            const hasBags = batchBags > 0 || batchPerBag > 0;
                            const batchTotal = hasBags
                              ? batchBags * batchPerBag + batchLoose
                              : batch.stock;
                            const status: string = batch.status || (
                              expired ? 'expired'
                                : batchBags > 0 ? 'sealed'
                                  : batchLoose > 0 ? 'open'
                                    : batch.stock > 0 ? 'open'
                                      : 'depleted'
                            );

                            return (
                              <Card
                                key={batch.id}
                                className={`border ${expired ? 'border-red-300 bg-red-50/50 dark:bg-red-950/20' : 'bg-gray-50 dark:bg-slate-900'}`}
                              >
                                <CardBody className="p-3">
                                  <div className="flex justify-between items-start">
                                    <div>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="font-semibold">
                                          {batch.lotNumber || 'No Lot #'}
                                        </span>
                                        <Chip
                                          size="sm" variant="flat"
                                          color={STATUS_COLORS[status] || 'default'}
                                        >
                                          {status}
                                        </Chip>
                                      </div>

                                      {batch.expirationDate && (
                                        <p className={`text-sm ${expired ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
                                          Exp: {batch.expirationDate.toLocaleDateString()}
                                          {expired && ' — EXPIRED'}
                                        </p>
                                      )}

                                      {batch.receivedAt && (
                                        <p className="text-xs text-gray-400">
                                          Received: {batch.receivedAt.toLocaleDateString()}
                                        </p>
                                      )}

                                      {batch.supplier && (
                                        <p className="text-xs text-gray-400">
                                          Supplier: {batch.supplier}
                                        </p>
                                      )}

                                      {batch.notes && (
                                        <p className="text-xs text-gray-400 italic mt-1">
                                          {batch.notes}
                                        </p>
                                      )}
                                    </div>

                                    {/* Batch stock */}
                                    <div className="text-right">
                                      {hasBags ? (
                                        <>
                                          <p className="font-bold text-lg">{batchTotal}</p>
                                          <p className="text-xs text-gray-500">
                                            {batchBags} bag{batchBags !== 1 ? 's' : ''} × {batchPerBag}/bag
                                          </p>
                                          {batchLoose > 0 && (
                                            <p className="text-xs text-gray-400">
                                              + {batchLoose} loose
                                            </p>
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          <p className="font-bold text-lg">{batch.stock}</p>
                                          <p className="text-xs text-gray-500">units</p>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {/* Batch action: open bag */}
                                  {batchBags > 0 && !expired && status !== 'quarantined' && (
                                    <div className="mt-2 pt-2 border-t">
                                      <Button
                                        size="sm" variant="flat" color="secondary"
                                        startContent={<PackageOpen size={12} />}
                                        onPress={() => handleOpenBag(item, batch.id)}
                                      >
                                        Open Bag ({batchPerBag} items)
                                      </Button>
                                    </div>
                                  )}

                                  {/* Batch locations (legacy per-batch locations) */}
                                  {batch.locations && batch.locations.length > 0 && (
                                    <div className="mt-2 pt-2 border-t">
                                      <p className="text-xs text-gray-400 mb-1">Locations:</p>
                                      <div className="flex gap-2 flex-wrap">
                                        {batch.locations.map((loc) => (
                                          <Chip key={loc.id} size="sm" variant="flat">
                                            {loc.name}: {loc.quantity}
                                          </Chip>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </CardBody>
                              </Card>
                            );
                          })}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Inventory Modal ────────────────────────────────────────────── */}
        <InventoryModal
          key={`${selectedItem?.id ?? 'new'}-${isOpen ? 'open' : 'closed'}`}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          onAddItem={handleAddItem}
          onUpdateItem={handleUpdateItem}
          initialData={selectedItem}
          canToggleExpiration={isAdmin}
        />

        {/* ── Consume Box Modal (legacy box tracking) ────────────────────── */}
        {consumeBoxItem && (
          <ConsumeBoxModal
            isOpen={consumeBoxModalOpen}
            onClose={() => { setConsumeBoxModalOpen(false); setConsumeBoxItem(null); }}
            item={consumeBoxItem}
            onSuccess={() => { /* auto-refresh via onSnapshot */ }}
          />
        )}
      </div>
    </div>
  );
}
