'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button,
  Input, Select, SelectItem, Switch, Textarea, Divider, Chip, Slider,
} from '@heroui/react';
import { Trash2, Plus, Package, Boxes, Wind, CalendarClock, ChevronDown, AlertTriangle } from 'lucide-react';

import { InventoryItem, ItemCategory, InventoryBatch, BatchStatus, StorageLocationRef } from '@/app/types';
import { doc, collection as coll, query as q, where, limit, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '@/firebase';
import { safeParseDate } from '@/app/utils/inventoryNormalization';
import { addAuditEventToBatch } from '@/app/lib/audit';
import StorageLocationPicker from '@/app/components/storage-location-picker';
import { useStorageLocations } from '@/app/hooks/useStorageLocations';

// Constants
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const BATCH_STATUSES: { key: BatchStatus; label: string; color: 'default' | 'success' | 'primary' | 'warning' | 'danger' }[] = [
  { key: 'sealed', label: 'Sealed', color: 'success' },
  { key: 'open', label: 'Open', color: 'primary' },
  { key: 'depleted', label: 'Depleted', color: 'default' },
  { key: 'expired', label: 'Expired', color: 'danger' },
  { key: 'quarantined', label: 'Quarantined', color: 'warning' },
];

interface InventoryModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAddItem: (item: Partial<InventoryItem>) => void;
  onUpdateItem: (id: string, item: Partial<InventoryItem>) => void;
  initialData?: InventoryItem | null;
  canToggleExpiration?: boolean;
}

// Lean form state for disposable inventory
type InventoryFormState = {
  name: string;
  sku?: string;
  barcode?: string;
  category: ItemCategory;
  unit?: string;
  reorderThreshold: number;
  description?: string;
  storageLocation?: StorageLocationRef;
  batches: InventoryBatch[];
  requiresExpirationCheck?: boolean;
  // Oxygen tracking
  isOxygen?: boolean;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
  oxygenModel?: string;
  // Reagent tracking
  isReagent?: boolean;
  daysValidAfterOpening?: number;
  // Legacy fields kept for save compatibility
  unopenedBoxes?: number;
  itemsPerBox?: number;
  looseUnits?: number;
  totalStockQuantity?: number;
};

const uniqueId = () =>
  typeof crypto !== 'undefined' && (crypto as Crypto).randomUUID
    ? (crypto as Crypto).randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const DEFAULT_STATE: InventoryFormState = {
  name: '',
  category: 'Other',
  unit: 'box',
  reorderThreshold: 5,
  description: '',
  batches: [],
  requiresExpirationCheck: false,
};

export default function InventoryModal({
  isOpen,
  onOpenChange,
  onAddItem,
  onUpdateItem,
  initialData,
  canToggleExpiration = false,
}: InventoryModalProps) {
  // --- Storage data (shared across pickers) ---
  const storageData = useStorageLocations();

  // --- Form state ---
  const getInitialFormData = (data?: InventoryItem | null): InventoryFormState => {
    if (!data) return { ...DEFAULT_STATE };

    const rawBatches = data.batches || [];
    const batches: InventoryBatch[] = rawBatches.map((b: unknown) => {
      const bData = b as Partial<InventoryBatch> & Record<string, unknown>;
      return {
        ...bData,
        expirationDate: safeParseDate(bData.expirationDate),
        openDate: safeParseDate(bData.openDate),
        receivedAt: safeParseDate(bData.receivedAt),
        openedAt: safeParseDate(bData.openedAt),
      } as InventoryBatch;
    });

    const dataRecord = data as unknown as Record<string, unknown>;
    return {
      name: data.name || '',
      sku: (dataRecord.sku as string) || '',
      barcode: (dataRecord.barcode as string) || '',
      category: data.category || 'Other',
      unit: data.unit || 'box',
      reorderThreshold: data.reorderThreshold ?? 5,
      description: data.description || '',
      storageLocation: data.storageLocation,
      batches,
      requiresExpirationCheck: (dataRecord.requiresExpirationCheck as boolean) ?? false,
      isOxygen: (dataRecord.isOxygen as boolean) ?? false,
      oxygenPsi: (dataRecord.oxygenPsi as number) ?? 2000,
      maxOxygenPsi: (dataRecord.maxOxygenPsi as number) ?? 2000,
      oxygenModel: (dataRecord.oxygenModel as string) ?? '',
      isReagent: (dataRecord.isReagent as boolean) ?? false,
      daysValidAfterOpening: (dataRecord.daysValidAfterOpening as number) ?? 90,
      unopenedBoxes: data.unopenedBoxes ?? 0,
      itemsPerBox: data.itemsPerBox,
      looseUnits: (dataRecord.looseUnits as number) ?? 0,
      totalStockQuantity: data.totalStockQuantity ?? 0,
    };
  };

  const [formData, setFormData] = useState<InventoryFormState>(() => getInitialFormData(initialData));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [duplicates, setDuplicates] = useState<Array<Record<string, unknown>>>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [error, setError] = useState<string>('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Reset form when initialData changes or modal opens
  useEffect(() => {
    if (isOpen) {
      const newData = getInitialFormData(initialData);
      // Use flushSync to avoid batching issues
      setFormData(newData);
      setError('');
    }
  }, [initialData]); // Only depend on initialData, not isOpen

  // --- Duplicate detection ---
  const levenshtein = (a: string, b: string) => {
    const as = a.toLowerCase().trim();
    const bs = b.toLowerCase().trim();
    if (as === bs) return 0;
    const m = as.length, n = bs.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = as[i - 1] === bs[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  };

  useEffect(() => {
    if (!isOpen) return;
    const name = (formData.name ?? '').trim();
    const sku = (formData.sku ?? '').trim();
    const barcode = (formData.barcode ?? '').trim();
    if ((!name || name.length < 2) && !sku && !barcode) { 
      setDuplicates([]); 
      return; 
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCheckingDuplicates(true);
      try {
        const collected: Record<string, Record<string, unknown>> = {};
        if (name.length >= 2) {
          const prefix = name.slice(0, 3);
          const qref = q(coll(db, 'inventory'), where('name', '>=', prefix), where('name', '<=', prefix + '\uf8ff'), limit(12));
          const snaps = await getDocs(qref);
          for (const s of snaps.docs) collected[s.id] = { id: s.id, ...s.data() };
        }
        if (sku) {
          try {
            const qsku = q(coll(db, 'inventory'), where('sku', '==', sku), limit(5));
            const snaps = await getDocs(qsku);
            for (const s of snaps.docs) collected[s.id] = { id: s.id, ...s.data() };
          } catch { /* ignore */ }
        }
        if (barcode) {
          try {
            const qb = q(coll(db, 'inventory'), where('barcode', '==', barcode), limit(5));
            const snaps = await getDocs(qb);
            for (const s of snaps.docs) collected[s.id] = { id: s.id, ...s.data() };
          } catch { /* ignore */ }
        }
        const results = Object.values(collected);
        const scored = results.map((r: Record<string, unknown>) => {
          const dist = name ? levenshtein(name, (r.name as string) ?? '') : Infinity;
          const skuMatch = !!(sku && (r.sku as string) && (r.sku as string).toLowerCase() === sku.toLowerCase());
          const barMatch = !!(barcode && (r.barcode as string) && (r.barcode as string).toLowerCase() === barcode.toLowerCase());
          return { r, score: Math.min(dist, skuMatch ? 0 : Infinity, barMatch ? 0 : Infinity), skuMatch, barMatch };
        });
        const exacts = scored.filter(s => s.skuMatch || s.barMatch).map(s => s.r);
        const fuzzy = scored
          .filter(s => !s.skuMatch && !s.barMatch && s.score <= Math.max(2, Math.floor(name.length * 0.25)))
          .sort((a, b) => a.score - b.score)
          .map(s => s.r);
        setDuplicates([...exacts, ...fuzzy].slice(0, 6));
      } catch { setDuplicates([]); }
      setCheckingDuplicates(false);
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [formData.name, formData.sku, formData.barcode, isOpen]);

  // --- Batch helpers ---
  const addBatch = () => {
    const newBatch: InventoryBatch = {
      id: uniqueId(),
      lotNumber: '',
      expirationDate: undefined,
      stock: 0,
      bagCount: 0,
      itemsPerBag: undefined,
      looseItems: 0,
      status: 'sealed',
    } as InventoryBatch;
    setFormData(prev => ({ ...prev, batches: [...prev.batches, newBatch] }));
  };

  const removeBatch = (id: string) => {
    setFormData(prev => ({ ...prev, batches: prev.batches.filter(b => b.id !== id) }));
  };

  const updateBatch = (id: string, field: string, value: unknown) => {
    setFormData(prev => ({
      ...prev,
      batches: prev.batches.map(b => {
        if (b.id !== id) return b;
        const updated = { ...b, [field]: value };
        // Auto-compute stock from bags + loose when bag tracking is active
        if (['bagCount', 'itemsPerBag', 'looseItems'].includes(field)) {
          const bags = Number((updated as Record<string, unknown>).bagCount ?? 0);
          const perBag = Number((updated as Record<string, unknown>).itemsPerBag ?? 0);
          const loose = Number((updated as Record<string, unknown>).looseItems ?? 0);
          if (perBag > 0) {
            (updated as Record<string, unknown>).stock = bags * perBag + loose;
          }
        }
        return updated as InventoryBatch;
      }),
    }));
  };

  // --- Computed totals ---
  const totalBags = formData.batches.reduce((s, b) => s + Number(b.bagCount ?? 0), 0);
  const totalLoose = formData.batches.reduce((s, b) => s + Number(b.looseItems ?? 0), 0);
  const totalItems = formData.batches.reduce((s, b) => s + Number(b.stock ?? 0), 0);
  const hasBatches = formData.batches.length > 0;

  // --- Date helper ---
  const getDateString = (date?: Date | string | unknown) => {
    if (!date) return '';
    const d = new Date(date as string | Date);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  };

  // --- Submit ---
  const handleSubmit = async (onClose: () => void) => {
    if (!formData.name?.trim()) return;

    // Compute total stock from batches
    const batchTotal = formData.batches.reduce((a, b) => a + Number(b.stock ?? 0), 0);
    const legacyTotal = hasBatches ? batchTotal : Number(formData.totalStockQuantity ?? 0);

    // Compute legacy box-level fields from batch data for backward compat
    const totalBagsComputed = formData.batches.reduce((s, b) => s + Number(b.bagCount ?? 0), 0);
    const totalLooseComputed = formData.batches.reduce((s, b) => s + Number(b.looseItems ?? 0), 0);
    // For the primary itemsPerBox, use the first batch's itemsPerBag
    const perBagValues = formData.batches.map(b => Number(b.itemsPerBag ?? 0)).filter(v => v > 0);
    const primaryItemsPerBox = perBagValues.length > 0 ? perBagValues[0] : formData.itemsPerBox;

    const payload: Record<string, unknown> = {
      name: formData.name.trim(),
      sku: formData.sku || undefined,
      barcode: formData.barcode || undefined,
      category: formData.category,
      unit: formData.unit || 'box',
      reorderThreshold: Number(formData.reorderThreshold ?? 0),
      description: formData.description || undefined,
      storageLocation: formData.storageLocation || undefined,
      requiresExpirationCheck: !!formData.requiresExpirationCheck,
      // Batch data
      batches: formData.batches.map(b => ({
        id: b.id,
        lotNumber: b.lotNumber || undefined,
        expirationDate: safeParseDate(b.expirationDate as unknown as string | Date | undefined) || undefined,
        openDate: safeParseDate((b as unknown as Record<string, unknown>).openDate as unknown as string | Date | undefined) || undefined,
        stock: Number(b.stock ?? 0),
        bagCount: Number(b.bagCount ?? 0),
        itemsPerBag: b.itemsPerBag != null ? Number(b.itemsPerBag) : undefined,
        looseItems: Number(b.looseItems ?? 0),
        status: b.status || 'sealed',
        openedAt: safeParseDate((b as unknown as Record<string, unknown>).openedAt as unknown as string | Date | undefined) || undefined,
        openedBy: b.openedBy || undefined,
        receivedAt: safeParseDate((b as unknown as Record<string, unknown>).receivedAt as unknown as string | Date | undefined) || undefined,
        notes: b.notes || undefined,
        purchase: b.purchase || undefined,
      })),
      // Legacy compat fields
      totalStockQuantity: legacyTotal,
      unopenedBoxes: totalBagsComputed,
      itemsPerBox: primaryItemsPerBox || undefined,
      looseUnits: totalLooseComputed,
      // Oxygen
      isOxygen: !!formData.isOxygen,
      oxygenPsi: formData.isOxygen ? Number(formData.oxygenPsi ?? 0) : undefined,
      maxOxygenPsi: formData.isOxygen ? Number(formData.maxOxygenPsi ?? 2000) : undefined,
      oxygenModel: formData.isOxygen ? formData.oxygenModel || undefined : undefined,
      // Reagent
      isReagent: !!formData.isReagent,
      daysValidAfterOpening: formData.isReagent ? Number(formData.daysValidAfterOpening ?? 90) : undefined,
      // Ensure NOT an asset
      isAsset: false,
    };

    // Remove undefined fields recursively to avoid Firestore rejecting undefined values
    const stripUndefined = (val: unknown): unknown => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      if (Array.isArray(val)) return val.map(v => stripUndefined(v));
      if (typeof val === 'object' && !(val instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          const cleaned = stripUndefined(v as unknown);
          if (cleaned !== undefined) out[k] = cleaned;
        }
        return out;
      }
      return val;
    };

    const payloadToWrite = stripUndefined(payload);

    if (initialData?.id) {
      onUpdateItem(initialData.id, payload as Partial<InventoryItem>);
    } else {
      try {
        const batch = writeBatch(db);
        const newRef = doc(coll(db, 'inventory'));
        const payloadRecord = payloadToWrite as Record<string, unknown>;
        batch.set(newRef, payloadRecord);
        // Build after object with only defined fields
        const afterRecord: Record<string, unknown> = {};
        if (payloadRecord.name !== undefined) afterRecord.name = payloadRecord.name;
        if (payloadRecord.sku !== undefined) afterRecord.sku = payloadRecord.sku;
        if (payloadRecord.barcode !== undefined) afterRecord.barcode = payloadRecord.barcode;
        if (payloadRecord.totalStockQuantity !== undefined) afterRecord.totalStockQuantity = payloadRecord.totalStockQuantity;
        addAuditEventToBatch(batch, {
          eventType: 'inventory.create',
          source: 'inventory',
          sourceId: newRef.id,
          after: afterRecord,
        });
        await batch.commit();
        onAddItem({ ...payloadRecord, id: newRef.id });
      } catch (err: unknown) {
        console.error('Create item failed', err);
        let errorMessage = 'Failed to create item. Please try again.';
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if (typeof err === 'string') {
          errorMessage = err;
        } else if (err && typeof err === 'object' && 'message' in err) {
          errorMessage = String((err as Record<string, unknown>).message);
        }
        setError(errorMessage);
        return;
      }
    }
    onClose();
  };

  const isEditMode = !!initialData;

  const closeModal = () => {
    try {
      onOpenChange(false);
    } catch (_e: unknown) {
      try { (onOpenChange as () => void)(); } catch (_err: unknown) { /* ignore */ }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="center"
      backdrop="blur"
      size="3xl"
      scrollBehavior="inside"
      classNames={{
        base: 'dark:bg-slate-800 max-w-[95vw] md:max-w-3xl',
        header: 'border-b border-gray-200 dark:border-slate-700',
        footer: 'border-t border-gray-200 dark:border-slate-700',
      }}
    >
      <ModalContent>
        <>
            <ModalHeader className="flex flex-col gap-1">
              <h2 className="text-xl font-bold">
                {isEditMode ? 'Edit Inventory Item' : 'Add New Inventory Item'}
              </h2>
              <p className="text-sm text-gray-500 font-normal">
                Disposable supply tracking with batch &amp; bag management.
              </p>
            </ModalHeader>

            <ModalBody className="py-5 space-y-5">
              {/* Error display */}
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/10 rounded-md border border-red-200 text-sm">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-red-600" />
                    <div>
                      <strong>Error Creating Item</strong>
                      <p className="text-xs mt-1 text-red-700 dark:text-red-300">{error}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Asset guard */}
              {initialData && (initialData as any).isAsset && (
                <div className="p-3 bg-red-50 dark:bg-red-900/10 rounded-md border border-red-200 text-sm">
                  <strong>Asset Detected</strong> — This item is tracked as an asset. Please use the Assets page to edit it.
                </div>
              )}

              {/* ─── SECTION 1: BASIC INFO ─── */}
              <section>
                <h3 className="text-xs font-bold text-default-500 uppercase tracking-wide mb-3">Item Details</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input
                    label="Item Name"
                    placeholder="e.g., Nitrile Gloves (Large)"
                    variant="bordered"
                    size="sm"
                    value={formData.name}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, name: v }))}
                    autoFocus
                    className="md:col-span-2"
                  />
                  <Input
                    label="SKU (optional)"
                    placeholder="e.g., GLV-LG-100"
                    variant="bordered"
                    size="sm"
                    value={formData.sku ?? ''}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, sku: v }))}
                  />
                  <Input
                    label="Barcode (optional)"
                    placeholder="e.g., 0123456789012"
                    variant="bordered"
                    size="sm"
                    value={formData.barcode ?? ''}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, barcode: v }))}
                  />

                  {/* Duplicate suggestions */}
                  {(checkingDuplicates || duplicates.length > 0) && (
                    <div className="md:col-span-2">
                      {checkingDuplicates ? (
                        <p className="text-xs text-default-400">Checking for similar items…</p>
                      ) : (
                        <div className="p-2 bg-warning-50 dark:bg-warning-900/10 rounded-md border border-warning-200 text-sm space-y-1">
                          <p className="text-xs font-semibold">Similar items found:</p>
                          {duplicates.map((d) => (
                            <div key={String(d.id)} className="flex items-center justify-between text-xs">
                              <span>{String(d.name)} {d.unit ? `(${String(d.unit)})` : ''}</span>
                              <Button size="sm" variant="flat" onPress={() => {
                                if (d.id) onUpdateItem(String(d.id), {});
                              }}>Open</Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <Select
                    label="Category"
                    variant="bordered"
                    size="sm"
                    selectedKeys={formData.category ? [formData.category] : []}
                    onSelectionChange={(keys) => setFormData(prev => ({ ...prev, category: Array.from(keys)[0] as ItemCategory }))}
                    className="overflow-visible"
                    popoverProps={{
                      classNames: {
                        content: "w-fit",
                      },
                    }}
                  >
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat}>{cat}</SelectItem>
                    ))}
                  </Select>

                  <Input
                    label="Unit Label"
                    placeholder="e.g., box, bag, each"
                    variant="bordered"
                    size="sm"
                    value={formData.unit ?? ''}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, unit: v }))}
                  />

                  <Input
                    type="number"
                    label="Reorder Threshold"
                    placeholder="5"
                    variant="bordered"
                    size="sm"
                    value={String(formData.reorderThreshold)}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, reorderThreshold: Number(v) || 0 }))}
                    description="Alert when total bags fall below this"
                  />

                  {canToggleExpiration && (
                    <div className="flex items-center justify-between p-3 border rounded-xl md:col-span-2">
                      <div>
                        <p className="text-sm">Require Expiration Confirmation?</p>
                        <p className="text-xs text-default-400">Users must confirm expiry during checkout</p>
                      </div>
                      <Switch
                        isSelected={!!formData.requiresExpirationCheck}
                        onValueChange={(v) => setFormData(prev => ({ ...prev, requiresExpirationCheck: v }))}
                      />
                    </div>
                  )}
                </div>
              </section>

              <Divider />

              {/* ─── SECTION 2: STORAGE LOCATION ─── */}
              <section>
                <StorageLocationPicker
                  value={formData.storageLocation}
                  onChange={(loc) => setFormData(prev => ({ ...prev, storageLocation: loc }))}
                  storageData={storageData}
                  label="Storage Location"
                  size="sm"
                />
              </section>

              <Divider />

              {/* ─── SECTION 3: BATCHES / BAGS ─── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-xs font-bold text-default-500 uppercase tracking-wide">Batches &amp; Bags</h3>
                    <p className="text-xs text-default-400 mt-0.5">
                      Each delivery or lot is a batch. Track sealed bags, items per bag, and loose items per batch.
                    </p>
                  </div>
                  <Button size="sm" color="primary" variant="flat" onPress={addBatch} startContent={<Plus size={14} />}>
                    Add Batch
                  </Button>
                </div>

                {formData.batches.length === 0 && (
                  <div className="text-center py-6 text-default-400 text-sm border-2 border-dashed rounded-xl">
                    <Boxes size={24} className="mx-auto mb-2 opacity-50" />
                    No batches yet. Click &quot;Add Batch&quot; to track a shipment or lot.
                  </div>
                )}

                <div className="space-y-3">
                  {formData.batches.map((b, idx) => {
                    const bags = Number(b.bagCount ?? 0);
                    const perBag = Number(b.itemsPerBag ?? 0);
                    const loose = Number(b.looseItems ?? 0);
                    const computedTotal = perBag > 0 ? bags * perBag + loose : Number(b.stock ?? 0);
                    const isExpired = b.expirationDate && new Date(b.expirationDate as string | Date) < new Date();
                    const statusInfo = BATCH_STATUSES.find(s => s.key === (b.status || 'sealed'));

                    return (
                      <div
                        key={b.id}
                        className={`p-3 border rounded-xl space-y-3 ${
                          isExpired ? 'border-danger-300 bg-danger-50/30 dark:bg-danger-900/10' : 'border-default-200 bg-default-50 dark:bg-slate-800/40'
                        }`}
                      >
                        {/* Batch header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Package size={16} className="text-default-500" />
                            <span className="text-sm font-semibold">Batch {idx + 1}</span>
                            {statusInfo && (
                              <Chip size="sm" color={statusInfo.color} variant="flat">{statusInfo.label}</Chip>
                            )}
                            {isExpired && (
                              <Chip size="sm" color="danger" variant="flat" startContent={<AlertTriangle size={12} />}>Expired</Chip>
                            )}
                          </div>
                          <Button size="sm" color="danger" variant="light" isIconOnly onPress={() => removeBatch(b.id)}>
                            <Trash2 size={14} />
                          </Button>
                        </div>

                        {/* Row 1: Lot, Expiration, Status */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <Input
                            size="sm"
                            label="Lot #"
                            placeholder="optional"
                            variant="bordered"
                            value={b.lotNumber || ''}
                            onValueChange={(v) => updateBatch(b.id, 'lotNumber', v)}
                          />
                          <Input
                            size="sm"
                            type="date"
                            label="Expiration"
                            variant="bordered"
                            value={getDateString(b.expirationDate as string | Date | unknown)}
                            onValueChange={(v) => updateBatch(b.id, 'expirationDate', v ? new Date(v) : undefined)}
                          />
                          <Select
                            size="sm"
                            label="Status"
                            variant="bordered"
                            selectedKeys={b.status ? [b.status] : ['sealed']}
                            onSelectionChange={(keys) => updateBatch(b.id, 'status', Array.from(keys)[0] as BatchStatus)}
                            className="overflow-visible"
                            popoverProps={{
                              classNames: {
                                content: "w-fit",
                              },
                            }}
                          >
                            {BATCH_STATUSES.map((s) => (
                              <SelectItem key={s.key}>{s.label}</SelectItem>
                            ))}
                          </Select>
                          <Input
                            size="sm"
                            type="date"
                            label="Received"
                            variant="bordered"
                            value={getDateString(b.receivedAt as string | Date | unknown)}
                            onValueChange={(v) => updateBatch(b.id, 'receivedAt', v ? new Date(v) : undefined)}
                          />
                        </div>

                        {/* Row 2: Bag tracking */}
                        <div className="grid grid-cols-3 gap-2 bg-primary-50 dark:bg-primary-900/10 p-3 rounded-lg border border-primary-100">
                          <Input
                            size="sm"
                            type="number"
                            label="Sealed Bags"
                            placeholder="0"
                            variant="bordered"
                            value={String(b.bagCount ?? 0)}
                            onValueChange={(v) => updateBatch(b.id, 'bagCount', Number(v) || 0)}
                            description="Full sealed bags"
                          />
                          <Input
                            size="sm"
                            type="number"
                            label="Items / Bag"
                            placeholder="e.g., 100"
                            variant="bordered"
                            value={b.itemsPerBag != null ? String(b.itemsPerBag) : ''}
                            onValueChange={(v) => updateBatch(b.id, 'itemsPerBag', v ? Number(v) : undefined)}
                            description="Qty per bag (supplier-specific)"
                          />
                          <Input
                            size="sm"
                            type="number"
                            label="Loose Items"
                            placeholder="0"
                            variant="bordered"
                            value={String(b.looseItems ?? 0)}
                            onValueChange={(v) => updateBatch(b.id, 'looseItems', Number(v) || 0)}
                            description="Items not in a full bag"
                          />
                        </div>

                        {/* Computed total */}
                        {perBag > 0 && (
                          <div className="bg-indigo-50 dark:bg-indigo-900/10 px-3 py-1.5 rounded-lg border border-indigo-100 text-sm">
                            <span className="text-default-500">Total items: </span>
                            <span className="font-semibold text-indigo-600 dark:text-indigo-400">{computedTotal}</span>
                            <span className="text-default-400 ml-2 text-xs">
                              ({bags} bags × {perBag} + {loose} loose)
                            </span>
                          </div>
                        )}

                        {/* Row 3: Supplier & Notes (collapsible) */}
                        <details className="group">
                          <summary className="text-xs text-default-400 cursor-pointer flex items-center gap-1 select-none">
                            <ChevronDown size={12} className="group-open:rotate-180 transition-transform" />
                            Supplier &amp; Notes
                          </summary>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                            <Input
                              size="sm"
                              label="Supplier"
                              placeholder="e.g., Medline"
                              variant="bordered"
                              value={((b.purchase as Record<string, unknown> | undefined)?.supplierName as string) ?? ''}
                              onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), supplierName: v })}
                            />
                            <Input
                              size="sm"
                              label="Price / Unit"
                              type="number"
                              placeholder="0.00"
                              variant="bordered"
                              value={((b.purchase as Record<string, unknown> | undefined)?.pricePerUnit as number | undefined)?.toString() ?? ''}
                              onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), pricePerUnit: v ? Number(v) : undefined })}
                            />
                            <Input
                              size="sm"
                              label="PO / Invoice #"
                              placeholder="PO-1234"
                              variant="bordered"
                              value={((b.purchase as Record<string, unknown> | undefined)?.purchaseOrderId as string) ?? ''}
                              onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), purchaseOrderId: v })}
                            />
                            <Input
                              size="sm"
                              label="Notes"
                              placeholder="optional"
                              variant="bordered"
                              value={b.notes ?? ''}
                              onValueChange={(v) => updateBatch(b.id, 'notes', v)}
                            />
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>

                {/* Batch summary */}
                {hasBatches && (
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <Chip variant="flat" color="primary" size="sm">
                      {totalBags} total bags
                    </Chip>
                    <Chip variant="flat" color="default" size="sm">
                      {totalLoose} loose items
                    </Chip>
                    <Chip variant="flat" color="secondary" size="sm">
                      {totalItems} total items
                    </Chip>
                  </div>
                )}
              </section>

              <Divider />

              {/* ─── SECTION 4: SPECIAL TRACKING (collapsible) ─── */}
              <section>
                <button
                  type="button"
                  className="flex items-center gap-2 text-xs text-default-500 hover:text-default-700 cursor-pointer select-none"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                  <span className="font-bold uppercase tracking-wide">Advanced / Special Tracking</span>
                </button>

                {showAdvanced && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Oxygen */}
                    <div className={`p-3 border-2 rounded-xl transition-all ${formData.isOxygen ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Wind size={16} className={formData.isOxygen ? 'text-blue-600' : 'text-default-400'} />
                          <span className="text-sm font-semibold">Oxygen Tank</span>
                        </div>
                        <Switch isSelected={!!formData.isOxygen} onValueChange={(v) => setFormData(prev => ({ ...prev, isOxygen: v }))} />
                      </div>
                      {formData.isOxygen && (
                        <div className="space-y-3 pt-2">
                          <Input size="sm" label="Tank Model" placeholder="e.g., Luxfer 3000" value={formData.oxygenModel ?? ''} onValueChange={(v) => setFormData(prev => ({ ...prev, oxygenModel: v }))} />
                          <div>
                            <div className="flex justify-between text-xs mb-1">
                              <span>Current Pressure</span>
                              <span className="font-bold">{formData.oxygenPsi ?? 0} PSI</span>
                            </div>
                            <Slider size="sm" color="primary" step={50} minValue={0} maxValue={Number(formData.maxOxygenPsi || 2000)} value={formData.oxygenPsi ?? 0} onChange={(val) => setFormData(prev => ({ ...prev, oxygenPsi: Number(val) }))} />
                          </div>
                          <Input size="sm" type="number" label="Max PSI" value={String(formData.maxOxygenPsi ?? 2000)} onValueChange={(v) => setFormData(prev => ({ ...prev, maxOxygenPsi: Number(v) }))} />
                        </div>
                      )}
                    </div>

                    {/* Reagent */}
                    <div className={`p-3 border-2 rounded-xl transition-all ${formData.isReagent ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <CalendarClock size={16} className={formData.isReagent ? 'text-orange-600' : 'text-default-400'} />
                          <span className="text-sm font-semibold">Reagent / Time-Limited</span>
                        </div>
                        <Switch isSelected={!!formData.isReagent} onValueChange={(v) => setFormData(prev => ({ ...prev, isReagent: v }))} />
                      </div>
                      <p className="text-xs text-default-400">Glucose strips, control solutions, eye wash that expire X days after opening.</p>
                      {formData.isReagent && (
                        <Input
                          size="sm"
                          type="number"
                          label="Days Valid After Opening"
                          className="mt-2"
                          value={String(formData.daysValidAfterOpening ?? 90)}
                          onValueChange={(v) => setFormData(prev => ({ ...prev, daysValidAfterOpening: Number(v) }))}
                        />
                      )}
                    </div>
                  </div>
                )}
              </section>

              <Divider />

              {/* ─── SECTION 5: NOTES ─── */}
              <section>
                <Textarea
                  label="Description / Notes"
                  placeholder="Optional details about this item…"
                  variant="bordered"
                  size="sm"
                  value={formData.description ?? ''}
                  onValueChange={(v) => setFormData(prev => ({ ...prev, description: v }))}
                  minRows={2}
                />
              </section>
            </ModalBody>

            <ModalFooter>
              <Button color="danger" variant="light" onPress={() => closeModal()}>
                Cancel
              </Button>
              <Button
                color="primary"
                onPress={() => handleSubmit(() => closeModal())}
                className="font-semibold shadow-lg"
                isDisabled={!formData.name?.trim()}
              >
                {isEditMode ? 'Save Changes' : 'Add Item'}
              </Button>
            </ModalFooter>
          </>
      </ModalContent>
    </Modal>
  );
}
