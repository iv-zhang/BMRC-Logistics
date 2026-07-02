'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Chip, Button, Spinner } from '@heroui/react';
import {
  Plus, Minus, Search, MapPin, Download, ChevronDown, X, RotateCcw,
  PackageOpen, LayoutList, Table2, ArrowRight,
} from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection, addDoc, updateDoc, doc, onSnapshot, query, orderBy,
  serverTimestamp, Timestamp, getDoc, where, limit,
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { recordAuditEvent } from '../lib/audit';
import InventoryModal from '@/app/components/additemmodal';
import ConsumeBoxModal from '@/app/components/consume-box-modal';
import MedicationCabinetModal from '@/app/components/medication-cabinet-modal';
import IntakeWizard from '@/app/components/intake-wizard';
import { getOldestValidBatch, isBatchExpired } from '@/app/utils/batchHelpers';
import { preparePayload, safeParseDate } from '@/app/utils/inventoryNormalization';
import { ITEM_CATEGORIES, getInventoryAreaOptions } from '@/app/config/org-config';
import { CAT_CFG } from '@/app/components/category-badge';
import {
  computeBagStock, displayLocation, getItemStatus, formatExp, expTextColor,
  statusQtyColor, statusBarColor, type ItemStatus,
} from '@/app/lib/item-status';
import type {
  InventoryItem, InventoryBatch, ItemCategory, User, BatchStatus, MedicationInfo,
} from '@/app/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ITEM_CATEGORIES as readonly ItemCategory[];
const LOCATION_OPTIONS = getInventoryAreaOptions();

const BATCH_STATUS_COLORS: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'primary'> = {
  sealed: 'primary', open: 'success', depleted: 'default', expired: 'danger', quarantined: 'warning',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardTint(s: ItemStatus): string {
  if (s === 'expired') return 'bg-danger-50/70 dark:bg-danger-950/40 border-danger/40 dark:border-danger/25';
  if (s === 'out')     return 'bg-danger-50/40 dark:bg-danger-950/25 border-danger/25 dark:border-danger/15';
  if (s === 'low')     return 'bg-warning-50/70 dark:bg-warning-950/30 border-warning/40 dark:border-warning/20';
  if (s === 'expiring') return 'bg-warning-50/40 dark:bg-warning-950/20 border-warning/25 dark:border-warning/15';
  return 'bg-content1 border-divider';
}

// ── Page Component ─────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [opLoading, setOpLoading] = useState(false);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [locationFilter, setLocationFilter] = useState<string>('');

  // Views
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');
  const [tableExpanded, setTableExpanded] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);

  // Modals
  const [isOpen, setIsOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [consumeBoxModalOpen, setConsumeBoxModalOpen] = useState(false);
  const [consumeBoxItem, setConsumeBoxItem] = useState<InventoryItem | null>(null);
  const [medCabinetOpen, setMedCabinetOpen] = useState(false);
  const [medCabinetItem, setMedCabinetItem] = useState<InventoryItem | null>(null);

  // ── Drawer history ─────────────────────────────────────────────────────────
  const [drawerHistory, setDrawerHistory] = useState<Array<{
    id: string; action: string; quantity?: number; userName?: string;
    timestamp?: Date; notes?: string; supplier?: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Auth ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) { setUser(u); setLoading(false); }
      else { router.push('/login'); }
    });
    return unsub;
  }, [router]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
          const data = snap.data() as User;
          setIsAdmin(data.role === 'admin' || data.role === 'quartermaster');
        }
      } catch (e) { console.error('Role fetch error', e); }
    })();
  }, [user]);

  // ── Inventory listener ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    return onSnapshot(q, (snap) => {
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
          isMedication: raw.isMedication ?? false,
          medicationInfo: raw.medicationInfo as MedicationInfo | undefined,
          barcode: raw.barcode,
          unit: raw.unit,
          description: raw.description,
          hasVariants: false,
          createdAt: raw.createdAt instanceof Timestamp ? raw.createdAt.toDate() : new Date(raw.createdAt || Date.now()),
          updatedAt: raw.updatedAt instanceof Timestamp ? raw.updatedAt.toDate() : new Date(raw.updatedAt || Date.now()),
          batches: [],
        };
        if (Array.isArray(raw.batches) && raw.batches.length > 0) {
          item.batches = raw.batches.map((b: Record<string, unknown>) => ({
            id: (b.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            lotNumber: (b.lotNumber as string) || '',
            expirationDate: safeParseDate(
              b.expirationDate instanceof Timestamp
                ? (b.expirationDate as Timestamp).toDate()
                : (b.expirationDate as string | Date | undefined),
            ),
            stock: Number(b.stock ?? 0),
            openDate: safeParseDate(
              b.openDate instanceof Timestamp ? (b.openDate as Timestamp).toDate() : (b.openDate as string | Date | undefined),
            ),
            receivedAt: safeParseDate(
              b.receivedAt instanceof Timestamp ? (b.receivedAt as Timestamp).toDate() : (b.receivedAt as string | Date | undefined),
            ),
            locations: Array.isArray(b.locations) ? (b.locations as InventoryBatch['locations']) : [],
            serialNumbers: Array.isArray(b.serialNumbers) ? (b.serialNumbers as string[]) : [],
            purchase: (b.purchase as InventoryBatch['purchase']) || undefined,
            bagCount: b.bagCount !== undefined ? Number(b.bagCount) : undefined,
            itemsPerBag: b.itemsPerBag !== undefined ? Number(b.itemsPerBag) : undefined,
            looseItems: b.looseItems !== undefined ? Number(b.looseItems) : undefined,
            status: (b.status as BatchStatus) || undefined,
            openedAt: safeParseDate(
              b.openedAt instanceof Timestamp ? (b.openedAt as Timestamp).toDate() : (b.openedAt as string | Date | undefined),
            ),
            openedBy: (b.openedBy as string) || undefined,
            supplier: (b.supplier as string) || undefined,
            notes: (b.notes as string) || undefined,
          }));
        }
        return item;
      });
      setInventory(items.filter(i => !i.isAsset));
    });
  }, [user]);

  // ── Drawer history listener ────────────────────────────────────────────────
  useEffect(() => {
    if (!detailItem) { setDrawerHistory([]); return; }
    setHistoryLoading(true);
    const q = query(
      collection(db, 'inventory_logs'),
      where('itemId', '==', detailItem.id),
      orderBy('timestamp', 'desc'),
      limit(20),
    );
    const unsub = onSnapshot(q, snap => {
      setDrawerHistory(snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          action: data.action ?? 'update',
          quantity: data.quantity ?? data.quantityDelta ?? undefined,
          userName: data.userName ?? undefined,
          timestamp: data.timestamp?.toDate?.() ?? undefined,
          notes: data.notes ?? undefined,
          supplier: data.supplier ?? data.supplierName ?? undefined,
        };
      }));
      setHistoryLoading(false);
    }, () => setHistoryLoading(false));
    return () => unsub();
  }, [detailItem]);

  // ── CRUD ───────────────────────────────────────────────────────────────────
  async function handleAddItem(data: Partial<InventoryItem>) {
    if (!user) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({ ...data, createdAt: serverTimestamp(), createdBy: user.uid });
      await addDoc(collection(db, 'inventory'), payload);
      await recordAuditEvent({
        eventType: 'item_added',
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name, category: data.category },
      });
    } catch (e) { console.error(e); alert('Failed to add item'); }
    finally { setOpLoading(false); }
  }

  async function handleUpdateItem(id: string, data: Partial<InventoryItem>) {
    if (!user || !id) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({ ...data, updatedAt: serverTimestamp(), updatedBy: user.uid });
      await updateDoc(doc(db, 'inventory', id), payload);
      await recordAuditEvent({
        eventType: 'item_updated',
        sourceId: id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name },
      });
    } catch (e) { console.error(e); alert('Failed to update item'); }
    finally { setOpLoading(false); }
  }

  async function handleOpenBag(item: InventoryItem, batchId?: string) {
    if (!user) return;
    const batches = item.batches || [];
    const targetBatch = batchId
      ? batches.find(b => b.id === batchId)
      : batches
          .filter(b => (b.bagCount ?? 0) > 0 && b.status !== 'expired' && b.status !== 'quarantined')
          .sort((a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity))[0];

    if (!targetBatch || (targetBatch.bagCount ?? 0) <= 0) { alert('No sealed bags available.'); return; }
    const perBag = targetBatch.itemsPerBag ?? 0;
    if (!confirm(`Open 1 sealed bag from Lot ${targetBatch.lotNumber || '(no lot)'}?\nReleases ${perBag} items as loose stock.`)) return;

    setOpLoading(true);
    try {
      const updatedBatches = batches.map(b => {
        if (b.id !== targetBatch.id) return b;
        const newBagCount = (b.bagCount ?? 0) - 1;
        const newLoose = (b.looseItems ?? 0) + perBag;
        return {
          ...b, bagCount: newBagCount, looseItems: newLoose,
          status: (newBagCount === 0 && newLoose === 0 ? 'depleted' : 'open') as BatchStatus,
          openedAt: new Date(), openedBy: user.displayName || user.email || user.uid,
        };
      });
      const totalBags = updatedBatches.reduce((s, b) => s + (b.bagCount ?? 0), 0);
      const totalLoose = updatedBatches.reduce((s, b) => s + (b.looseItems ?? 0), 0);
      const totalStock = updatedBatches.reduce((s, b) => s + (b.bagCount ?? 0) * (b.itemsPerBag ?? 0) + (b.looseItems ?? 0), 0);
      await updateDoc(doc(db, 'inventory', item.id), {
        batches: updatedBatches, unopenedBoxes: totalBags,
        looseUnits: totalLoose, totalStockQuantity: totalStock, updatedAt: serverTimestamp(),
      });
      await recordAuditEvent({
        eventType: 'bag_opened', sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: targetBatch.id, lotNumber: targetBatch.lotNumber, itemsReleased: perBag },
      });
    } catch (e) { console.error(e); alert('Failed to open bag'); }
    finally { setOpLoading(false); }
  }

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
        unopenedBoxes: newUnopened, totalStockQuantity: newTotal, updatedAt: serverTimestamp(),
      });
      const item = inventory.find(i => i.id === itemId);
      await recordAuditEvent({
        eventType: 'stock_adjusted', sourceId: itemId,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item?.name, delta, newStock: newUnopened },
      });
    } catch (e) { console.error(e); }
    finally { setOpLoading(false); }
  }

  async function handleRestockForward(item: InventoryItem) {
    if (!user) return;
    const oldest = getOldestValidBatch(item.batches || [], item);
    const info = oldest
      ? `Lot: ${oldest.lotNumber || 'N/A'}, Exp: ${oldest.expirationDate?.toLocaleDateString() || 'N/A'}`
      : '';
    if (!confirm(`Move oldest batch of "${item.name}" to front shelf?\n${info}`)) return;
    setOpLoading(true);
    try {
      await addDoc(collection(db, 'restock_reports'), {
        itemId: item.id, itemName: item.name, category: item.category,
        batchId: oldest?.id || null, lotNumber: oldest?.lotNumber || null,
        quantity: oldest?.stock || item.unopenedBoxes || 0,
        from: displayLocation(item), to: 'Front Restock Bin',
        userId: user.uid, userName: user.displayName || user.email || '',
        timestamp: serverTimestamp(),
      });
      await recordAuditEvent({
        eventType: 'restock_forward', sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: oldest?.id, from: displayLocation(item) },
      });
      alert(`Restock report created for "${item.name}".`);
    } catch (e) { console.error(e); alert('Failed to create restock report'); }
    finally { setOpLoading(false); }
  }

  function exportCSV() {
    const headers = ['Name', 'Category', 'Location', 'Sealed Bags', 'Loose Items', 'Total Stock', 'Reorder Threshold', 'Unit'];
    const rows = filteredInventory.map(item => {
      const bag = computeBagStock(item);
      return [item.name, item.category, displayLocation(item), bag.totalBags, bag.totalLoose,
        bag.totalItems, item.reorderThreshold, item.unit || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  const statusCounts = useMemo(() => {
    const c = { ok: 0, low: 0, out: 0, expired: 0, expiring: 0 };
    for (const item of inventory) c[getItemStatus(item)]++;
    return c;
  }, [inventory]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const cat of CATEGORIES) m[cat] = inventory.filter(i => i.category === cat).length;
    return m;
  }, [inventory]);

  const filteredInventory = useMemo(() => {
    let list = [...inventory];
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      list = list.filter(i =>
        i.name.toLowerCase().includes(t) ||
        (i.barcode || '').toLowerCase().includes(t) ||
        displayLocation(i).toLowerCase().includes(t) ||
        (i.batches || []).some(b => (b.lotNumber || '').toLowerCase().includes(t)),
      );
    }
    if (categoryFilter) list = list.filter(i => i.category === categoryFilter);
    if (statusFilter) {
      list = list.filter(i => {
        const s = getItemStatus(i);
        if (statusFilter === 'ok') return s === 'ok';
        if (statusFilter === 'low') return s === 'low' || s === 'out';
        if (statusFilter === 'expired') return s === 'expired';
        if (statusFilter === 'expiring') return s === 'expiring';
        return true;
      });
    }
    if (locationFilter) {
      const lf = locationFilter.toLowerCase();
      list = list.filter(i =>
        displayLocation(i).toLowerCase().includes(lf) ||
        (i.location || '').toLowerCase().includes(lf) ||
        (i.room || '').toLowerCase().includes(lf),
      );
    }
    return list;
  }, [inventory, searchTerm, categoryFilter, statusFilter, locationFilter]);

  function resetFilters() {
    setSearchTerm(''); setCategoryFilter(''); setStatusFilter(''); setLocationFilter('');
  }

  function toggleTableRow(id: string) {
    setTableExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  // ── Loading guard ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Spinner size="lg" color="primary" />
    </div>
  );
  if (!user) return null;

  // ── Status pill config ─────────────────────────────────────────────────────
  const statusPills = [
    { key: '',          label: 'All Items',     count: inventory.length,                    dot: 'bg-foreground-300' },
    { key: 'ok',        label: 'OK',            count: statusCounts.ok,                     dot: 'bg-success' },
    { key: 'low',       label: 'Low / Out',     count: statusCounts.low + statusCounts.out, dot: 'bg-warning' },
    { key: 'expired',   label: 'Expired',       count: statusCounts.expired,                dot: 'bg-danger' },
    { key: 'expiring',  label: 'Expiring Soon', count: statusCounts.expiring,               dot: 'bg-warning/60' },
  ] as const;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Inventory</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{inventory.length}</span>
                <span className="text-xs text-foreground-400">total</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{statusCounts.low + statusCounts.out}</span>
                <span className="text-xs text-warning/80 font-medium">low stock</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{statusCounts.expired}</span>
                <span className="text-xs text-danger/80 font-medium">expired</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50/60 dark:bg-warning-900/10 border border-warning/20 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning/60 flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{statusCounts.expiring}</span>
                <span className="text-xs text-warning/70 font-medium">expiring soon</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
              {([
                { mode: 'list' as const, icon: <LayoutList size={14} />, label: 'List' },
                { mode: 'table' as const, icon: <Table2 size={14} />, label: 'Table' },
              ]).map(({ mode, icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                    viewMode === mode
                      ? 'bg-primary text-white'
                      : 'text-foreground-500 hover:bg-content2'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>

            <Button size="sm" variant="flat" startContent={<Download size={14} />} onPress={exportCSV}>
              Export
            </Button>
            {isAdmin && (
              <Button
                color="primary"
                size="sm"
                startContent={<Plus size={15} />}
                onPress={() => setIntakeOpen(true)}
              >
                Intake Stock
              </Button>
            )}
          </div>
        </div>

        {/* ══ LIST VIEW ══════════════════════════════════════════════════════ */}
        {viewMode === 'list' && (
          <div className="flex gap-6 items-start">

            {/* Sidebar ────────────────────────────────────────────────────── */}
            <aside className="w-64 flex-none flex flex-col gap-4">

              {/* Stock Status */}
              <div className="bg-content1 border border-divider rounded-large p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-foreground-400 mb-3">
                  Stock Status
                </p>
                <div className="flex flex-col gap-1">
                  {statusPills.map(({ key, label, count, dot }) => (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(statusFilter === key ? '' : key)}
                      className={`flex items-center justify-between px-3 py-2 rounded-medium text-sm font-semibold transition-colors duration-150 border ${
                        statusFilter === key
                          ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20 dark:border-primary/40'
                          : 'border-transparent hover:bg-content2 text-foreground-600 dark:text-foreground-300'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-sm flex-none ${dot}`} />
                        {label}
                      </span>
                      <span className="tabular-nums text-xs text-foreground-400">{count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Category */}
              <div className="bg-content1 border border-divider rounded-large p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-foreground-400 mb-3">
                  Category
                </p>
                <div className="flex flex-col gap-0.5">
                  {CATEGORIES.map(cat => {
                    const cfg = CAT_CFG[cat];
                    const active = categoryFilter === cat;
                    return (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(active ? '' : cat)}
                        className={`flex items-center justify-between px-2 py-1.5 rounded-medium text-sm transition-colors duration-150 ${
                          active ? 'bg-content2 font-semibold' : 'hover:bg-content2 font-normal'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] font-semibold flex-none ${cfg.bg} ${cfg.text}`}>
                            {cfg.code}
                          </span>
                          <span className="text-foreground-700 dark:text-foreground-300">{cat}</span>
                        </span>
                        <span className="tabular-nums text-xs text-foreground-400">{catCounts[cat] || 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Location */}
              <div className="bg-content1 border border-divider rounded-large p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-foreground-400 mb-3">
                  Location
                </p>
                <select
                  value={locationFilter}
                  onChange={e => setLocationFilter(e.target.value)}
                  className="w-full text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
                >
                  <option value="">All locations</option>
                  {LOCATION_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  onClick={resetFilters}
                  className="mt-3 w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-primary py-1"
                >
                  <RotateCcw size={11} /> Reset filters
                </button>
              </div>
            </aside>

            {/* Item list ──────────────────────────────────────────────────── */}
            <main className="flex-1 min-w-0 flex flex-col gap-3">
              {/* Search */}
              <div className="flex items-center gap-3 bg-content1 border border-divider rounded-large px-4 py-1">
                <Search size={16} className="text-foreground-400 flex-none" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search items, locations, lot numbers…"
                  className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="text-foreground-400 hover:text-foreground-600 transition-colors">
                    <X size={15} />
                  </button>
                )}
              </div>

              {filteredInventory.length === 0 ? (
                <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                  <PackageOpen size={32} className="mx-auto text-foreground-300 mb-2" />
                  <p className="text-sm font-semibold text-foreground-500">No items match these filters</p>
                  <p className="text-xs text-foreground-400 mt-1">Try clearing the search or status filter.</p>
                </div>
              ) : (
                filteredInventory.map(item => {
                  const bag = computeBagStock(item);
                  const status = getItemStatus(item);
                  const loc = displayLocation(item);
                  const cfg = CAT_CFG[item.category];
                  const qtyColor = statusQtyColor(status);
                  const barColor = statusBarColor(status);
                  const maxForBar = item.isOxygen
                    ? (item.maxOxygenPsi ?? 2000)
                    : (item.maxUnits ?? (item.reorderThreshold > 0 ? item.reorderThreshold * 2 : Math.max(bag.totalItems, 1)));
                  const barPct = item.isOxygen
                    ? Math.min(100, ((item.oxygenPsi ?? 0) / maxForBar) * 100)
                    : Math.min(100, (bag.totalItems / maxForBar) * 100);

                  return (
                    <div
                      key={item.id}
                      onClick={() => setDetailItem(item)}
                      className={`flex gap-4 items-center border rounded-[14px] px-4 py-4 cursor-pointer transition-all duration-150 hover:-translate-y-px hover:shadow-[0_6px_22px_rgba(16,24,40,0.09)] dark:hover:shadow-[0_6px_22px_rgba(0,0,0,0.35)] ${getCardTint(status)}`}
                    >
                      {/* Category badge */}
                      <div className={`w-[50px] h-[50px] rounded-[13px] flex items-center justify-center font-mono font-semibold text-[15px] flex-none ${cfg.bg} ${cfg.text}`}>
                        {cfg.code}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold text-foreground">{item.name}</span>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}>
                            {item.category}
                          </span>
                        </div>
                        {loc && (
                          <div className="flex items-center gap-1 text-xs text-foreground-500 mb-2">
                            <MapPin size={11} className="flex-none" /> {loc}
                          </div>
                        )}
                        <div className="flex gap-1.5 flex-wrap">
                          {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                          {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                          {status === 'out'      && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                          {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                          {(item.batches || []).length > 0 && (
                            <Chip size="sm" variant="flat" color="default">
                              {(item.batches || []).length} batch{(item.batches || []).length !== 1 ? 'es' : ''}
                            </Chip>
                          )}
                          {item.isMedication && <Chip size="sm" variant="flat" color="danger">Med</Chip>}
                        </div>
                      </div>

                      {/* Quantity */}
                      {item.isOxygen ? (
                        <div className="w-36 flex-none flex flex-col items-end gap-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
                              {item.oxygenPsi ?? 0}
                            </span>
                            <span className="text-xs font-semibold text-foreground-400">PSI</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barColor}`}
                              style={{ width: `${Math.min(100, ((item.oxygenPsi ?? 0) / (item.maxOxygenPsi ?? 1)) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[11px] text-foreground-400">Max {item.maxOxygenPsi} · O₂</span>
                        </div>
                      ) : (
                        <div className="w-44 flex-none flex flex-col items-end gap-1.5">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={e => { e.stopPropagation(); handleQuickAdjust(item.id, -1); }}
                              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors duration-150"
                              aria-label="Decrease stock"
                            >
                              <Minus size={14} />
                            </button>
                            <div className="text-center min-w-[54px]">
                              <div className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
                                {bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes}
                              </div>
                              <div className="text-[9px] uppercase tracking-wider text-foreground-400 mt-1 font-semibold">
                                {bag.hasBagTracking ? 'Items' : (item.unit || 'Units')}
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); handleQuickAdjust(item.id, 1); }}
                              className="w-8 h-8 rounded-medium bg-primary-50 hover:bg-primary-100 text-primary flex items-center justify-center transition-colors duration-150 dark:bg-primary-900/20 dark:hover:bg-primary-800/30"
                              aria-label="Increase stock"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          <div className="w-full h-[5px] rounded-full bg-content3 overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-300 ${barColor}`} style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="text-[11px] text-foreground-400">
                            {bag.totalItems}/{item.maxUnits ?? '—'} max · reorder@{item.reorderThreshold}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </main>
          </div>
        )}

        {/* ══ TABLE VIEW ═════════════════════════════════════════════════════ */}
        {viewMode === 'table' && (
          <div>
            {/* Filter bar */}
            <div className="bg-content1 border border-divider rounded-large p-3 mb-4 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px] flex items-center gap-2 bg-content2 border border-divider rounded-medium px-3 py-0.5">
                <Search size={15} className="text-foreground-400 flex-none" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search items, locations, lot numbers…"
                  className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
              >
                <option value="">All categories</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={locationFilter}
                onChange={e => setLocationFilter(e.target.value)}
                className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
              >
                <option value="">All locations</option>
                {LOCATION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div className="flex gap-1.5 ml-auto flex-wrap">
                {statusPills.slice(1).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(statusFilter === key ? '' : key)}
                    className={`px-3 py-1.5 rounded-medium text-xs font-semibold border transition-colors duration-150 ${
                      statusFilter === key
                        ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                        : 'border-divider hover:bg-content2 text-foreground-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            <div className="bg-content1 border border-divider rounded-large overflow-hidden">
              {/* Header */}
              <div className="grid gap-4 px-5 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400"
                style={{ gridTemplateColumns: '2.3fr 1.3fr 1.2fr 100px 1.4fr 104px' }}>
                <span>Item</span>
                <span>Location</span>
                <span>Lot · Expires</span>
                <span className="text-center">On Hand</span>
                <span>Status</span>
                <span className="text-right">Actions</span>
              </div>

              {/* Rows */}
              <div className="divide-y divide-divider">
                {filteredInventory.map(item => {
                  const bag = computeBagStock(item);
                  const status = getItemStatus(item);
                  const cfg = CAT_CFG[item.category];
                  const isExpanded = tableExpanded.has(item.id);
                  const loc = displayLocation(item);
                  const qtyColor = statusQtyColor(status);
                  const sortedBatches = [...(item.batches || [])].sort(
                    (a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity),
                  );
                  const nearestBatch = sortedBatches[0];

                  return (
                    <div key={item.id}>
                      <div
                        onClick={() => setDetailItem(item)}
                        className="grid gap-4 px-5 py-3 cursor-pointer hover:bg-content2 transition-colors duration-150"
                        style={{ gridTemplateColumns: '2.3fr 1.3fr 1.2fr 100px 1.4fr 104px' }}
                      >
                        {/* Item */}
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center font-mono font-semibold text-[11px] flex-none ${cfg.bg} ${cfg.text}`}>
                            {cfg.code}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-sm text-foreground truncate">{item.name}</div>
                            <div className="text-xs text-foreground-400">{item.category}</div>
                          </div>
                        </div>
                        {/* Location */}
                        <div className="text-xs text-foreground-500 truncate self-center">{loc}</div>
                        {/* Lot/Exp */}
                        <div className="self-center min-w-0">
                          {nearestBatch ? (
                            <>
                              <div className="font-mono text-xs text-foreground-500 truncate">{nearestBatch.lotNumber || '—'}</div>
                              <div className={`text-xs font-semibold ${expTextColor(nearestBatch.expirationDate)}`}>
                                {formatExp(nearestBatch.expirationDate)}
                              </div>
                            </>
                          ) : <span className="text-xs text-foreground-400">—</span>}
                        </div>
                        {/* On Hand */}
                        <div className="text-center self-center">
                          <span className={`font-mono text-lg font-semibold tabular-nums ${qtyColor}`}>
                            {item.isOxygen ? (item.oxygenPsi ?? 0) : (bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes)}
                          </span>
                          <div className="text-[9px] uppercase tracking-wider text-foreground-400 font-semibold">
                            {item.isOxygen ? 'PSI' : (bag.hasBagTracking ? 'Items' : (item.unit || 'Units'))}
                          </div>
                        </div>
                        {/* Status */}
                        <div className="flex gap-1 flex-wrap self-center">
                          {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                          {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                          {status === 'out'      && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                          {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                          {status === 'ok'       && <Chip size="sm" variant="flat" color="success">OK</Chip>}
                        </div>
                        {/* Actions */}
                        <div className="flex items-center justify-end gap-1.5 self-center" onClick={e => e.stopPropagation()}>
                          {!item.isOxygen && (
                            <>
                              <button
                                onClick={() => handleQuickAdjust(item.id, -1)}
                                className="w-7 h-7 rounded-[7px] bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors"
                                aria-label="Decrease"
                              >
                                <Minus size={12} />
                              </button>
                              <button
                                onClick={() => handleQuickAdjust(item.id, 1)}
                                className="w-7 h-7 rounded-[7px] bg-primary-50 hover:bg-primary-100 text-primary flex items-center justify-center transition-colors dark:bg-primary-900/20"
                                aria-label="Increase"
                              >
                                <Plus size={12} />
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => toggleTableRow(item.id)}
                            className="w-7 h-7 rounded-[7px] bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors"
                            aria-label="Expand batches"
                          >
                            <ChevronDown size={13} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </div>

                      {/* Expanded batches */}
                      {isExpanded && (
                        <div className="px-5 pb-4 pt-1 bg-content2/50">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2 mt-2">Batches</p>
                          {sortedBatches.length === 0 ? (
                            <p className="text-xs text-foreground-400">No batch/lot tracking — counted at item level.</p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {sortedBatches.map(bt => {
                                const bStatus = bt.status || (isBatchExpired(bt, item) ? 'expired' : 'sealed');
                                const total = bt.bagCount !== undefined
                                  ? (bt.bagCount ?? 0) * (bt.itemsPerBag ?? 0) + (bt.looseItems ?? 0)
                                  : bt.stock;
                                return (
                                  <div key={bt.id} className="flex items-center gap-4 bg-content1 border border-divider rounded-medium px-3 py-2.5">
                                    <span className="font-mono text-[12.5px] font-semibold text-foreground min-w-[110px]">
                                      {bt.lotNumber || '(no lot)'}
                                    </span>
                                    <span className={`text-xs font-semibold min-w-[120px] ${expTextColor(bt.expirationDate)}`}>
                                      {formatExp(bt.expirationDate)}
                                    </span>
                                    <Chip size="sm" variant="flat" color={BATCH_STATUS_COLORS[bStatus] || 'default'}>
                                      {bStatus}
                                    </Chip>
                                    <span className="font-mono text-sm text-foreground-500 ml-auto">
                                      {total} units
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between mt-3 text-xs text-foreground-400">
              <span>
                Showing{' '}
                <span className="font-semibold text-foreground-600">{filteredInventory.length}</span>
                {' '}of {inventory.length} items
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ══ Detail Drawer ═══════════════════════════════════════════════════════ */}
      {detailItem && (() => {
        const item = detailItem;
        const bag = computeBagStock(item);
        const status = getItemStatus(item);
        const cfg = CAT_CFG[item.category];
        const loc = displayLocation(item);
        const qtyColor = statusQtyColor(status);
        const sortedBatches = [...(item.batches || [])].sort(
          (a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity),
        );

        return (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              style={{ animation: 'bmrcFadeIn 0.2s ease forwards' }}
              onClick={() => setDetailItem(null)}
            />
            <div className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw] bg-content1 shadow-2xl flex flex-col" style={{ animation: 'bmrcSlide 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}>
              {/* Drawer header */}
              <div className="px-6 py-5 border-b border-divider">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-[46px] h-[46px] rounded-[12px] flex items-center justify-center font-mono font-semibold text-sm flex-none ${cfg.bg} ${cfg.text}`}>
                      {cfg.code}
                    </div>
                    <div>
                      <div className="font-semibold text-lg text-foreground leading-tight">{item.name}</div>
                      {loc && (
                        <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                          <MapPin size={11} /> {loc}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setDetailItem(null)}
                    className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none mt-0.5"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="flex gap-1.5 flex-wrap mt-4">
                  {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                  {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                  {status === 'out'      && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                  {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                  {status === 'ok'       && <Chip size="sm" variant="flat" color="success">OK</Chip>}
                  {item.isMedication     && <Chip size="sm" variant="flat" color="danger">Med</Chip>}
                  {item.isOxygen         && <Chip size="sm" variant="flat" color="secondary">O₂</Chip>}
                </div>
              </div>

              {/* Drawer body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* Stock stats */}
                <div className="flex gap-3">
                  <div className="flex-1 bg-content2 rounded-large p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">On Hand</div>
                    <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${qtyColor}`}>
                      {item.isOxygen ? (item.oxygenPsi ?? 0) : (bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes)}
                      <span className="text-sm text-foreground-400 font-normal ml-1.5">
                        {item.isOxygen ? 'PSI' : (bag.hasBagTracking ? 'items' : (item.unit || 'units'))}
                      </span>
                    </div>
                    {bag.hasBagTracking && (
                      <div className="text-xs text-foreground-400 mt-1">
                        {bag.totalBags} bag{bag.totalBags !== 1 ? 's' : ''} · {bag.totalLoose} loose
                      </div>
                    )}
                  </div>
                  <div className="flex-1 bg-content2 rounded-large p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Reorder At</div>
                    <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground-600">
                      {item.reorderThreshold}
                    </div>
                    <div className={`text-xs font-semibold mt-1 ${
                      status === 'ok' ? 'text-success' :
                      status === 'low' ? 'text-warning' :
                      status === 'out' ? 'text-danger' :
                      status === 'expired' ? 'text-danger' : 'text-foreground-500'
                    }`}>
                      {status === 'ok' ? 'Well stocked' :
                       status === 'low' ? 'Below threshold' :
                       status === 'out' ? 'Out of stock' :
                       status === 'expired' ? 'Has expired batches' : 'Expiring soon'}
                    </div>
                  </div>
                </div>

                {/* Batches */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">
                      Batches & Expiration
                    </h4>
                    <span className="text-xs text-foreground-400 font-semibold">FIFO — oldest first</span>
                  </div>
                  {sortedBatches.length === 0 ? (
                    <div className="text-xs text-foreground-400 text-center py-4 border border-dashed border-divider rounded-large">
                      No batch tracking — stock counted at item level.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {sortedBatches.map(bt => {
                        const bStatus = bt.status || (isBatchExpired(bt, item) ? 'expired' : (bt.bagCount ?? 0) > 0 ? 'sealed' : 'open');
                        const total = bt.bagCount !== undefined
                          ? (bt.bagCount ?? 0) * (bt.itemsPerBag ?? 0) + (bt.looseItems ?? 0)
                          : bt.stock;
                        const hasSealedBag = (bt.bagCount ?? 0) > 0 && bt.itemsPerBag;
                        return (
                          <div key={bt.id} className="border border-divider rounded-large p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold text-foreground">
                                  {bt.lotNumber || '(no lot)'}
                                </span>
                                <Chip size="sm" variant="flat" color={BATCH_STATUS_COLORS[bStatus] || 'default'}>
                                  {bStatus}
                                </Chip>
                              </div>
                              <span className="font-mono text-[15px] font-semibold text-foreground-500">{total}</span>
                            </div>
                            <div className="flex items-center justify-between mt-2">
                              <span className={`text-xs font-semibold ${expTextColor(bt.expirationDate)}`}>
                                Expires {formatExp(bt.expirationDate)}
                              </span>
                              {hasSealedBag && (
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  color="primary"
                                  startContent={<PackageOpen size={12} />}
                                  onPress={() => handleOpenBag(item, bt.id)}
                                >
                                  Open bag
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* History */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                      Activity History
                    </h4>
                    {historyLoading && <Spinner size="sm" color="primary" />}
                  </div>
                  {drawerHistory.length === 0 && !historyLoading ? (
                    <div className="text-xs text-foreground-400 text-center py-4 border border-dashed border-divider rounded-large">
                      No activity logged yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {drawerHistory.map(entry => {
                        const ACTION_LABELS: Record<string, string> = {
                          create_open_batch: 'Batch added', consume_box: 'Units consumed',
                          restock_needed: 'Restock alert', asset_checkout: 'Checked out',
                          asset_checkin: 'Checked in', asset_assign: 'Assigned',
                          asset_unassign: 'Unassigned', intake: 'Stock intake',
                          batch_added: 'Stock intake', quick_adjust: 'Quick adjust',
                        };
                        const label = ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, ' ');
                        const isIn = ['intake', 'batch_added', 'create_open_batch', 'asset_checkin'].includes(entry.action);
                        return (
                          <div key={entry.id} className="flex items-start gap-3 border border-divider rounded-large p-3">
                            <div className={`w-7 h-7 rounded-[8px] flex items-center justify-center flex-none mt-0.5 ${
                              isIn ? 'bg-success-50 dark:bg-success-900/20 text-success' : 'bg-content3 text-foreground-400'
                            }`}>
                              {isIn ? <Plus size={13} /> : <Minus size={13} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-foreground capitalize">{label}</span>
                                {entry.quantity !== undefined && (
                                  <span className={`font-mono text-sm font-semibold tabular-nums ${isIn ? 'text-success' : 'text-foreground-500'}`}>
                                    {isIn ? '+' : '−'}{Math.abs(entry.quantity)}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {entry.userName && <span className="text-xs text-foreground-400">{entry.userName}</span>}
                                {entry.supplier && <span className="text-xs text-primary font-medium">via {entry.supplier}</span>}
                                {entry.timestamp && (
                                  <span className="text-xs text-foreground-300">
                                    {entry.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    {' · '}
                                    {entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </span>
                                )}
                              </div>
                              {entry.notes && <p className="text-xs text-foreground-400 mt-1">{entry.notes}</p>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Med cabinet link */}
                {item.isMedication && (
                  <Button
                    variant="flat"
                    color="danger"
                    fullWidth
                    onPress={() => { setDetailItem(null); setMedCabinetItem(item); setMedCabinetOpen(true); }}
                  >
                    Med Cabinet
                  </Button>
                )}
              </div>

              {/* Drawer footer */}
              <div className="px-6 py-4 border-t border-divider flex gap-3">
                <Button
                  variant="bordered"
                  className="flex-1"
                  startContent={<Plus size={15} />}
                  onPress={() => { setDetailItem(null); setSelectedItem(item); setIsOpen(true); }}
                >
                  Edit / Add batch
                </Button>
                <Button
                  color="primary"
                  className="flex-1"
                  startContent={<ArrowRight size={15} />}
                  onPress={() => { setDetailItem(null); handleRestockForward(item); }}
                >
                  Restock forward
                </Button>
              </div>
            </div>
          </>
        );
      })()}

      {/* ══ Modals ═══════════════════════════════════════════════════════════ */}
      <InventoryModal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        initialData={selectedItem}
        onAddItem={handleAddItem}
        onUpdateItem={handleUpdateItem}
      />
      {consumeBoxItem && (
        <ConsumeBoxModal
          isOpen={consumeBoxModalOpen}
          onClose={() => { setConsumeBoxModalOpen(false); setConsumeBoxItem(null); }}
          item={consumeBoxItem}
          onSuccess={() => { setConsumeBoxModalOpen(false); setConsumeBoxItem(null); }}
        />
      )}
      {medCabinetItem && (
        <MedicationCabinetModal
          isOpen={medCabinetOpen}
          onOpenChange={(open) => { setMedCabinetOpen(open); if (!open) setMedCabinetItem(null); }}
          medication={medCabinetItem}
          userId={user?.uid || ''}
          userName={user?.displayName || user?.email || ''}
        />
      )}

      <IntakeWizard isOpen={intakeOpen} onClose={() => setIntakeOpen(false)} />

      {opLoading && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}
    </div>
  );
}
