'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, 
  Input, Select, SelectItem, Switch, Textarea, Divider, Slider
} from '@heroui/react';
import { Trash2, Plus, Info, Box, Boxes, Wind, CalendarClock, GripVertical } from 'lucide-react';

import { InventoryItem, ItemCategory, LocationType, HQRoom, InventoryVariant, InventoryBatch, AssetInstance, Statpack, StatpackItem, ASSET_VALUE_THRESHOLD } from '@/app/types'; 
import { doc, getDoc, collection as coll, query as q, where, limit, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '@/firebase';
import { safeParseDate } from '@/app/utils/inventoryNormalization';
import { addAuditEventToBatch } from '@/app/lib/audit';
import { fetchStatpackById, batchAddInventoryFromStatpack } from '@/app/lib/inventory';
import { useToast } from '@heroui/toast';

// Constants for Dropdowns
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const LOCATIONS: LocationType[] = ['HQ', 'CPR Closet', 'Shed', 'Other'];
// Use explicit room names: 'Back Room' (true inventory) and 'Forward Staging' (middle room)
const HQ_ROOMS: HQRoom[] = ['Front', 'Forward Staging', 'Back Room', 'Office'];
// (legacy) batch location labels are freeform names

interface InventoryModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  onAddItem: (item: Partial<InventoryItem>) => void;
  onUpdateItem: (id: string, item: Partial<InventoryItem>) => void;
  initialData?: InventoryItem | null;
  canToggleExpiration?: boolean;
}

// Extend state to hold new fields
type InventoryFormState = Partial<Omit<InventoryItem, 'unopenedBoxes' | 'reorderThreshold'>> & {
  sku?: string;
  barcode?: string;
  unopenedBoxes?: number | string;
  itemsPerBox?: number | string | null;
  totalStockQuantity?: number | string; // Legacy
  reorderThreshold?: number | string;
  variants: InventoryVariant[];
  batches?: InventoryBatch[];
  assets?: AssetInstance[];
  // Legacy State Fields (deprecated)
  unopenedQuantity?: number | string;
  openedQuantity?: number | string;
  quantityPerUnit?: number | string;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
  // Asset / Audit
  isAsset?: boolean;
  assetValue?: number; // Monetary value in dollars
  assetStatus?: 'Ready' | 'Not Ready';
  assetLastChecked?: Date | string;
  assetNextExpiration?: Date | string;
  // When true, this item must have its expiration confirmed before use
  requiresExpirationCheck?: boolean;
  // AED-specific per-unit fields are stored on `assets[]`; do not keep top-level pad/battery dates here.
};

const DEFAULT_STATE: InventoryFormState = {
  name: '',
  sku: '',
  barcode: '',
  category: 'Other',
  location: 'HQ',
  room: 'Back Room',
  shelf: '',
  unopenedBoxes: 0,
  itemsPerBox: undefined,
  unit: 'box',
  reorderThreshold: 5,
  description: '',
  hasVariants: false,
  variants: [],
  // Legacy fields kept for backwards compatibility
  totalStockQuantity: 0,
  tracksOpenStock: false,
  isOxygen: false,
  oxygenPsi: 2000,
  maxOxygenPsi: 2000,
  oxygenModel: '',
  batches: [],
  assets: [],
  requiresExpirationCheck: false,
  
};

export default function InventoryModal({ 
  isOpen, 
  onOpenChange, 
  onAddItem, 
  onUpdateItem,
  initialData,
  canToggleExpiration = false
}: InventoryModalProps) {
  // Helper for stable unique IDs (prefers crypto.randomUUID when available)
  const uniqueId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);
  
  const getInitialFormData = (data?: InventoryItem | null): InventoryFormState => {
    if (!data) return DEFAULT_STATE;
    const variants = data.variants || [];
    const rawBatches = data.batches || [];
    const batches = rawBatches.map((b: any) => ({
      ...b,
      // preserve serialized and serial/asset metadata when loading
      serialized: !!b.serialized,
      serialNumbers: Array.isArray(b.serialNumbers) ? b.serialNumbers.slice() : [],
      assetInstances: Array.isArray(b.assetInstances)
        ? b.assetInstances.map((ai: any) => ({
            ...ai,
            padExpiration: safeParseDate(ai?.padExpiration as any),
            batteryExpiration: safeParseDate(ai?.batteryExpiration as any),
            lastServiceDate: safeParseDate(ai?.lastServiceDate as any),
            lastChecked: safeParseDate(ai?.lastChecked as any),
          }))
        : (Array.isArray(b.serialNumbers) ? (b.serialNumbers || []).map((s: string) => ({ serial: s })) : []),
      locations: Array.isArray(b.locations) ? b.locations.map((l: any) => {
        const name = l.name ?? '';
        const parts = name.split('/').map((p: string) => p.trim()).filter(Boolean);
        let area: LocationType | undefined = undefined;
        let room: HQRoom | undefined = undefined;
        let shelf: string | undefined = undefined;
        if (parts.length > 0) {
          if (LOCATIONS.includes(parts[0] as LocationType)) {
            area = parts[0] as LocationType;
            if (parts.length > 1) {
              if (HQ_ROOMS.includes(parts[1] as HQRoom)) {
                room = parts[1] as HQRoom;
                shelf = parts.slice(2).join(' / ');
              } else {
                shelf = parts.slice(1).join(' / ');
              }
            }
          } else if (HQ_ROOMS.includes(parts[0] as HQRoom)) {
            area = 'HQ';
            room = parts[0] as HQRoom;
            shelf = parts.slice(1).join(' / ');
          } else {
            area = data.location ?? 'HQ';
            shelf = name;
          }
        } else {
          area = data.location ?? 'HQ';
        }
        return { id: l.id ?? uniqueId(), name: name, quantity: Number(l.quantity ?? 0), area, room, shelf };
      }) : []
    }));
    // Build assets: prefer top-level `data.assets`, fall back to batch-level serialNumbers when AEDs were stored as serials
    const assets = Array.isArray((data as any).assets) ? (data as any).assets.map((ai: any) => ({
      ...ai,
      padExpiration: safeParseDate(ai?.padExpiration as any),
      batteryExpiration: safeParseDate(ai?.batteryExpiration as any),
      lastServiceDate: safeParseDate(ai?.lastServiceDate as any),
      lastChecked: safeParseDate(ai?.lastChecked as any),
      nextExpiration: safeParseDate(ai?.nextExpiration as any),
      batteryStatus: ai?.batteryStatus ?? undefined,
      padsSealed: typeof ai?.padsSealed === 'boolean' ? ai.padsSealed : undefined,
      lastCheckNotes: ai?.lastCheckNotes ?? undefined,
    })) : (Array.isArray(rawBatches) ? rawBatches.flatMap((b: any) => (Array.isArray(b.serialNumbers) ? b.serialNumbers.map((s: string) => ({ id: s, serial: s })) : [])) : []);

    return {
      ...DEFAULT_STATE,
      ...data,
      // do not infer top-level expiration; batches hold expirations
      variants,
      hasVariants: data.hasVariants || variants.length > 0,
      // Map new fields or fallback to defaults
      tracksOpenStock: data.tracksOpenStock || false,
      unopenedQuantity: data.unopenedQuantity ?? data.totalStockQuantity,
      openedQuantity: data.openedQuantity ?? 0,
      quantityPerUnit: data.quantityPerUnit ?? 1,
      isOxygen: data.isOxygen || false,
      oxygenPsi: data.oxygenPsi ?? 2000,
      maxOxygenPsi: data.maxOxygenPsi ?? 2000,
      oxygenModel: (data as any).oxygenModel ?? '',
      // secondary expiration (per-item) removed
      openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
      batches,
      assets,
      // Asset / Audit fields
      isAsset: (data as any).isAsset ?? false,
      assetValue: (data as any).assetValue ?? undefined,
      assetStatus: (data as any).assetStatus,
      assetLastChecked: (data as any).assetLastChecked ? new Date((data as any).assetLastChecked) : undefined,
      assetNextExpiration: (data as any).assetNextExpiration ? new Date((data as any).assetNextExpiration) : undefined,
        
        requiresExpirationCheck: (data as any).requiresExpirationCheck ?? false,
        assetCategory: (data as any).assetCategory ?? undefined,
        assetModel: (data as any).assetModel ?? undefined,
    };
  };

  const isLikelyAED = (name?: string) => {
    if (!name) return false;
    return /\b(aed|defib|defibrillator|philips|frx|lifeline)\b/i.test(name);
  };

  

  const addVariantBatch = (variantId: string) => {
    const newBatch: InventoryBatch = { id: uniqueId(), lotNumber: '', expirationDate: undefined, stock: 0, locations: [] } as InventoryBatch;
    setFormData(prev => {
      const hadBatches = ((prev.batches || []).length > 0) || ((prev.variants || []).some(v => Array.isArray(v.batches) && v.batches.length > 0));
      const next = {
        ...prev,
        variants: (prev.variants || []).map(v => v.id === variantId ? ({ ...v, batches: [...(v.batches || []), newBatch] }) : v)
      } as InventoryFormState;
      if (!hadBatches) {
        next.location = undefined as any;
        next.room = undefined as any;
        next.shelf = '';
      }
      return next;
    });
  };

  const removeVariantBatch = (variantId: string, batchId: string) => {
    setFormData(prev => ({
      ...prev,
      variants: (prev.variants || []).map(v => v.id === variantId ? ({ ...v, batches: (v.batches || []).filter(b => b.id !== batchId) }) : v)
    }));
  };

  const [formData, setFormData] = useState<InventoryFormState>(() => getInitialFormData(initialData));
  // --- Statpack Quick-Add Mode ---
  const [statpackId, setStatpackId] = useState<string>('');
  const [statpack, setStatpack] = useState<Statpack | null>(null);
  const [statpackLoading, setStatpackLoading] = useState(false);
  const [addWholePack, setAddWholePack] = useState<boolean>(true);
  const [selectedPackItemIds, setSelectedPackItemIds] = useState<Set<string>>(new Set());

  const loadStatpack = async () => {
    if (!statpackId) return;
    setStatpackLoading(true);
    try {
      const sp = await fetchStatpackById(statpackId);
      setStatpack(sp);
      if (sp && Array.isArray(sp.contents)) {
        const allIds = new Set((sp.contents as StatpackItem[]).map((i) => i.itemId));
        setSelectedPackItemIds(allIds);
        setAddWholePack(true);
      } else {
        setSelectedPackItemIds(new Set());
      }
    } catch {
      setStatpack(null);
      setSelectedPackItemIds(new Set());
    } finally {
      setStatpackLoading(false);
    }
  };

  const togglePackItem = (itemId: string) => {
    setSelectedPackItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };
  const [assignedNames, setAssignedNames] = useState<Record<string,string>>({});
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<any>(null);

  let toast: any = null;
  try {
    toast = (useToast as any)();
  } catch {
    toast = null;
  }
  const notify = (opts: { title: string; description?: string; variant?: string }) => {
    try {
      (toast as any)?.push?.(opts);
    } catch {
      // fallback to alert when toast provider is missing
      // eslint-disable-next-line no-alert
      alert(`${opts.title}${opts.description ? ': ' + opts.description : ''}`);
    }
  };

  // Simple Levenshtein distance for fuzzy matching
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
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
      }
    }
    return dp[m][n];
  };

  // Reset or update form when modal opens/closes or initialData changes
  useEffect(() => {
    if (isOpen) {
        setFormData(getInitialFormData(initialData));
    }
  }, [isOpen, initialData]);

  // Resolve assignedToId -> statpack name when possible to show a friendly label
  useEffect(() => {
    const ids = (formData.assets || []).map(a => a.assignedToId).filter(Boolean) as string[];
    const uniq = Array.from(new Set(ids));
    if (uniq.length === 0) return;
    let mounted = true;
    (async () => {
      const map: Record<string,string> = {};
      for (const id of uniq) {
        try {
          const snap = await getDoc(doc(db, 'statpacks', id));
          if (snap.exists()) {
            const data = snap.data() as any;
            if (data && data.name) map[id] = String(data.name);
          }
        } catch (e) {
          // ignore fetch errors
        }
      }
      if (mounted) setAssignedNames(prev => ({ ...prev, ...map }));
    })();
    return () => { mounted = false; };
  }, [formData.assets]);
  
  const prefillFromExisting = (item: any) => {
    if (!item) return;
    setFormData(prev => ({
      ...prev,
      category: prev.category || item.category || prev.category,
      location: prev.location || item.location || prev.location,
      unit: prev.unit || item.unit || prev.unit,
      reorderThreshold: prev.reorderThreshold ?? item.reorderThreshold ?? prev.reorderThreshold
    }));
    setShowAdvanced(true);
  };

  // Duplicate detection: prefix search + SKU/barcode queries + fuzzy Levenshtein
  useEffect(() => {
    if (!isOpen) return;
    const name = String(formData.name ?? '').trim();
    const sku = String(formData.sku ?? '').trim();
    const barcode = String(formData.barcode ?? '').trim();
    if ((!name || name.length < 2) && !sku && !barcode) {
      setDuplicates([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCheckingDuplicates(true);
      try {
        const collected: Record<string, any> = {};
        // Name prefix query (fast)
        if (name && name.length >= 2) {
          const prefix = name.slice(0, 3);
          const start = prefix;
          const end = prefix + '\uf8ff';
          const qref = q(coll(db, 'inventory'), where('name', '>=', start), where('name', '<=', end), limit(12));
          const snaps = await getDocs(qref);
          for (const s of snaps.docs) collected[s.id] = { id: s.id, ...(s.data() as any) };
        }
        // Exact SKU match
        if (sku) {
          try {
            const qsku = q(coll(db, 'inventory'), where('sku', '==', sku), limit(10));
            const snaps = await getDocs(qsku);
            for (const s of snaps.docs) collected[s.id] = { id: s.id, ...(s.data() as any) };
          } catch {
            // ignore
          }
        }
        // Exact barcode match
        if (barcode) {
          try {
            const qb = q(coll(db, 'inventory'), where('barcode', '==', barcode), limit(10));
            const snaps = await getDocs(qb);
            for (const s of snaps.docs) collected[s.id] = { id: s.id, ...(s.data() as any) };
          } catch {
            // ignore
          }
        }

        // Convert to array and apply fuzzy filter + scoring
        const results = Object.values(collected) as any[];
        const scored = results.map(r => {
          const rname = String(r.name || '');
          const nameScore = name ? levenshtein(name, rname) : Infinity;
          const skuMatch = sku && r.sku && String(r.sku).toLowerCase() === sku.toLowerCase();
          const barcodeMatch = barcode && r.barcode && String(r.barcode).toLowerCase() === barcode.toLowerCase();
          return { r, score: Math.min(nameScore, skuMatch ? 0 : Infinity, barcodeMatch ? 0 : Infinity), skuMatch, barcodeMatch };
        });
        // Select candidates: exact sku/barcode first, then low distance names
        const exacts = scored.filter(s => s.skuMatch || s.barcodeMatch).map(s => s.r);
        const fuzzy = scored.filter(s => !s.skuMatch && !s.barcodeMatch && s.score <= Math.max(2, Math.floor((String(formData.name || '').length || 4) * 0.25))).sort((a,b) => a.score - b.score).map(s => s.r);
        const merged = [...exacts, ...fuzzy].slice(0, 8);
        setDuplicates(merged);
      } catch (e) {
        setDuplicates([]);
      }
      setCheckingDuplicates(false);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [formData.name, formData.sku, formData.barcode, isOpen]);

  // Whether master item location should be treated as authoritative
  const masterHasBatches = ((formData.batches || []).length > 0) || ((formData.variants || []).some(v => Array.isArray(v.batches) && v.batches.length > 0));

  // Helpers for UI restrictions
  const hasExpiringBatches = (formData.batches || []).some(b => !!(b as any).expirationDate);
  const cannotUseVariants = Boolean(formData.tracksExpiration) || hasExpiringBatches || Boolean(formData.isAsset);

  const handleValueChange = (field: keyof InventoryFormState) => (value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // --- VARIANT LOGIC ---
  const addVariant = () => {
    const newVariant: InventoryVariant = {
      id: uniqueId(),
      name: '',
      quantityPerUnit: 1, 
      stock: 0,
      reorderThreshold: 0
    };
    setFormData(prev => ({
      ...prev,
      variants: [...prev.variants, newVariant]
    }));
  };

  const removeVariant = (id: string) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.filter(v => v.id !== id)
    }));
  };

  const updateVariant = (id: string, field: keyof InventoryVariant, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.map(v => {
        if (v.id === id) {
          return { ...v, [field]: value };
        }
        return v;
      })
    }));
  };

  // --- BATCH / LOT LOGIC ---
  const addBatch = () => {
    const newBatch: InventoryBatch = {
      id: uniqueId(),
      lotNumber: '',
      expirationDate: undefined,
      stock: 0,
      locations: [],
    } as InventoryBatch;
    setFormData(prev => {
      const hadBatches = ((prev.batches || []).length > 0) || ((prev.variants || []).some(v => Array.isArray(v.batches) && v.batches.length > 0));
      const next = { ...prev, batches: [...(prev.batches || []), newBatch] } as InventoryFormState;
      if (!hadBatches) {
        next.location = undefined as any;
        next.room = undefined as any;
        next.shelf = '';
      }
      return next;
    });
  };

  const removeBatch = (id: string) => {
    setFormData(prev => ({ ...prev, batches: (prev.batches || []).filter(b => b.id !== id) }));
  };

  // Update an item-level batch OR a variant-level batch when `variantId` is provided
  const updateBatch = (id: string, field: keyof InventoryBatch, value: any, variantId?: string) => {
    setFormData(prev => ({
      ...prev,
      batches: variantId ? prev.batches : (prev.batches || []).map(b => b.id === id ? ({ ...b, [field]: value }) : b),
      variants: variantId ? (prev.variants || []).map(v => v.id === variantId ? ({ ...v, batches: (v.batches || []).map(b => b.id === id ? ({ ...b, [field]: value }) : b) }) : v) : prev.variants
    }));
  };

  const addBatchLocation = (batchId: string, variantId?: string) => {
    setFormData(prev => ({
      ...prev,
      batches: variantId ? prev.batches : (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const locations = b.locations || [];
        return { ...b, locations: [...locations, { id: uniqueId(), name: '', quantity: 0, area: 'HQ', room: 'Back Room', shelf: '' }] };
      }),
      variants: variantId ? (prev.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const vbatches = v.batches || [];
        return { ...v, batches: [...vbatches, { id: uniqueId(), lotNumber: '', expirationDate: undefined, stock: 0, locations: [{ id: uniqueId(), name: '', quantity: 0, area: 'HQ', room: 'Back Room', shelf: '' }] } as any] };
      }) : prev.variants
    }));
  };

  const updateBatchLocation = (batchId: string, locId: string, field: 'name' | 'quantity' | 'area' | 'room' | 'shelf', value: any, variantId?: string) => {
    setFormData(prev => ({
      ...prev,
      batches: variantId ? prev.batches : (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const locations = (b.locations || []).map(l => {
          if (l.id !== locId) return l;
          const updated: any = { ...l, [field]: field === 'quantity' ? Number(value) : value };
          const parts: string[] = [];
          if (updated.area) parts.push(updated.area);
          if (updated.room) parts.push(updated.room);
          if (updated.shelf) parts.push(updated.shelf);
          updated.name = parts.filter(Boolean).join(' / ') || updated.name || '';
          return updated;
        });
        return { ...b, locations };
      }),
      variants: variantId ? (prev.variants || []).map(v => {
        if (v.id !== variantId) return v;
        const vbatches = (v.batches || []).map(b => {
          if (b.id !== batchId) return b;
          const locations = (b.locations || []).map(l => {
            if (l.id !== locId) return l;
            const updated: any = { ...l, [field]: field === 'quantity' ? Number(value) : value };
            const parts: string[] = [];
            if (updated.area) parts.push(updated.area);
            if (updated.room) parts.push(updated.room);
            if (updated.shelf) parts.push(updated.shelf);
            updated.name = parts.filter(Boolean).join(' / ') || updated.name || '';
            return updated;
          });
          return { ...b, locations };
        });
        return { ...v, batches: vbatches };
      }) : prev.variants
    }));
  };

  // --- SERIAL / UNIT-ID LOGIC ---
  const addBatchSerial = (batchId: string, serial?: string, variantId?: string) => {
    setFormData(prev => {
      const batches = (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const nextSerials = [...(b.serialNumbers || []), serial || ''];
        return { ...b, serialized: true, serialNumbers: nextSerials, stock: nextSerials.length };
      });
      const variants = (prev.variants || []).map(v => ({ ...v, batches: (v.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const nextSerials = [...(b.serialNumbers || []), serial || ''];
        return { ...b, serialized: true, serialNumbers: nextSerials, stock: nextSerials.length } as any;
      }) }));
      return { ...prev, batches, variants };
    });
  };

  const removeBatchSerial = (batchId: string, idx: number, variantId?: string) => {
    setFormData(prev => {
      const batches = (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const next = (b.serialNumbers || []).filter((_, i) => i !== idx);
        return { ...b, serialNumbers: next, stock: next.length };
      });
      const variants = (prev.variants || []).map(v => ({ ...v, batches: (v.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const next = (b.serialNumbers || []).filter((_, i) => i !== idx);
        return { ...b, serialNumbers: next, stock: next.length } as any;
      }) }));
      return { ...prev, batches, variants };
    });
  };

  const updateBatchSerial = (batchId: string, idx: number, value: string, variantId?: string) => {
    setFormData(prev => ({
      ...prev,
      batches: (prev.batches || []).map(b => b.id === batchId ? ({ ...b, serialNumbers: (b.serialNumbers || []).map((s, i) => i === idx ? value : s) }) : b),
      variants: (prev.variants || []).map(v => ({ ...v, batches: (v.batches || []).map(b => b.id === batchId ? ({ ...b, serialNumbers: (b.serialNumbers || []).map((s, i) => i === idx ? value : s) }) : b) }))
    }));
  };

  // --- ASSET (NON-FUNGIBLE) HELPERS ---
  const addAsset = (asset?: Partial<AssetInstance>) => {
    setFormData(prev => ({ ...prev, assets: [...(prev.assets || []), { id: asset?.id ?? uniqueId(), serial: asset?.serial ?? '', assetTag: asset?.assetTag ?? asset?.serial ?? '', status: asset?.status ?? 'Ready', padExpiration: asset?.padExpiration, batteryExpiration: asset?.batteryExpiration, lastServiceDate: asset?.lastServiceDate, lastChecked: asset?.lastChecked, assignedToId: asset?.assignedToId ?? undefined, currentLocation: asset?.currentLocation ?? undefined } as AssetInstance ] }));
  };

  const removeAsset = (idx: number) => {
    setFormData(prev => ({ ...prev, assets: (prev.assets || []).filter((_, i) => i !== idx) }));
  };

  const updateAssetField = (idx: number, field: keyof AssetInstance, value: any) => {
    setFormData(prev => ({ ...prev, assets: (prev.assets || []).map((a, i) => i === idx ? ({ ...a, [field]: value }) : a) }));
  };
  

  const removeBatchLocation = (batchId: string, locId: string, variantId?: string) => {
    setFormData(prev => ({
      ...prev,
      batches: variantId ? prev.batches : (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        return { ...b, locations: (b.locations || []).filter(l => l.id !== locId) };
      }),
      variants: variantId ? (prev.variants || []).map(v => v.id === variantId ? ({ ...v, batches: (v.batches || []).map(b => b.id === batchId ? ({ ...b, locations: (b.locations || []).filter(l => l.id !== locId) }) : b) }) : v) : prev.variants
    }));
  };

  // --- DRAG & DROP FOR REORDERING VARIANTS ---
  const dragIndex = useRef<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndex.current = index;
    setDraggingIdx(index);
    setDragOverIdx(null);
    try { e.dataTransfer?.setData('text/plain', String(index)); } catch {}
    e.dataTransfer!.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    dragOverIndex.current = index;
    setDragOverIdx(index);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex.current ?? Number(e.dataTransfer?.getData('text/plain'));
    const to = dragOverIndex.current ?? from;
    if (from == null || to == null) {
      dragIndex.current = null;
      dragOverIndex.current = null;
      setDraggingIdx(null);
      setDragOverIdx(null);
      return;
    }

    setFormData(prev => {
      const arr = [...prev.variants];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...prev, variants: arr };
    });

    dragIndex.current = null;
    dragOverIndex.current = null;
    setDraggingIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    dragIndex.current = null;
    dragOverIndex.current = null;
    setDraggingIdx(null);
    setDragOverIdx(null);
  };

  // --- OPEN/CONSUME BOX HELPERS ---
  const [consumeCount, setConsumeCount] = useState<number>(1);

  const computeTotalItems = (sealedBoxes: number, openItems: number, qtyPerBox: number) => {
    return (sealedBoxes || 0) * (qtyPerBox || 1) + (openItems || 0);
  };

  const openBoxAction = () => {
    setFormData(prev => {
      const sealed = Number(prev.unopenedQuantity ?? 0);
      if (sealed <= 0) return prev;
      const qty = Number(prev.quantityPerUnit ?? 1);
      return {
        ...prev,
        unopenedQuantity: sealed - 1,
        openedQuantity: Number(prev.openedQuantity ?? 0) + qty,
        openedAt: prev.openedAt ?? new Date()
      };
    });
  };

  const consumeItemsAction = (count: number) => {
    setFormData(prev => {
      let sealed = Number(prev.unopenedQuantity ?? 0);
      let open = Number(prev.openedQuantity ?? 0);
      const qtyPer = Number(prev.quantityPerUnit ?? 1);
      let toConsume = Math.max(0, Math.floor(count));

      // consume from open items first
      const usedFromOpen = Math.min(open, toConsume);
      open -= usedFromOpen;
      toConsume -= usedFromOpen;

      // open boxes as needed to satisfy remainder
      while (toConsume > 0 && sealed > 0) {
        sealed -= 1;
        open += qtyPer;
        const used = Math.min(open, toConsume);
        open -= used;
        toConsume -= used;
      }

      const openedAt = open > 0 ? (prev.openedAt ?? new Date()) : undefined;
      return {
        ...prev,
        unopenedQuantity: sealed,
        openedQuantity: open,
        openedAt,
      };
    });
  };

  // --- SUBMIT ---
  const handleSubmit = async (onClose: () => void) => {
    // Prevent editing assets from this modal — it is now disposables-only
    if (initialData && (initialData as any).isAsset) {
      alert('This item is an Asset and must be edited from the Assets editor.');
      return;
    }
    if (!formData.name) return;
    // Enforce: when item has variants, top-level batches must be assigned to a specific variant
    if (formData.hasVariants) {
      const unassigned = (formData.batches || []).filter((bb: any) => !bb.variantId);
      if (unassigned.length > 0) {
        alert('Each batch must be assigned to a Variant when the item has variations. Please select a Variant for each batch.');
        return;
      }
    }

    // Enforce disposables-only for this modal: always treat as non-asset
    formData.isAsset = false;
    formData.assetValue = undefined;
    formData.assetStatus = undefined;

    // If batches exist, do not treat the master item as having a single location — location is batch-scoped
    const masterHasBatches = Array.isArray(formData.batches) && formData.batches.length > 0;
    
    // If batches exist, derive total from batches; otherwise use existing logic.
    const batchTotal = (formData.batches || []).reduce((acc, b) => acc + Number((b as any).stock ?? 0), 0);
    let finalStock = batchTotal > 0 ? batchTotal : Number(formData.totalStockQuantity ?? 0);
    
    // Logic 1: Variants override manual stock
     if (formData.hasVariants) {
       finalStock = (formData.variants || []).reduce((acc, curr) => {
        const variantBatchTotal = (curr as any).batches && (curr as any).batches.length > 0 ? (curr as any).batches.reduce((a: number, bb: any) => a + Number(bb.stock || 0), 0) : Number(curr.stock || 0);
        return acc + variantBatchTotal;
       }, 0);
     } 
    // Logic 2: Open/Unopened Tracking overrides manual stock
    else if (formData.tracksOpenStock) {
       // Total stock is typically Unopened Boxes + (1 if there is an opened box)
       // Or you might count total individual items. 
       // For this system, let's treat TotalStock as "Full Units Available" roughly.
       // We'll store exact counts in the new fields.
       const full = Number(formData.unopenedQuantity ?? 0);
       const partial = Number(formData.openedQuantity ?? 0) > 0 ? 1 : 0; // Count open box as 1 unit for simplicity or 0
       finalStock = full + partial;
    }
    // Logic 3: Oxygen tank acts as 1 unit usually, but relies on manual entry
    // If this item is an Asset, prefer serialized unit counts or explicit totals.
    if (formData.isAsset) {
      // If batches exist with serialNumbers, derive finalStock from their count
      const serialCount = (formData.batches || []).reduce((acc, b: any) => acc + ((Array.isArray(b.serialNumbers) ? b.serialNumbers.length : 0)), 0);
      if (serialCount > 0) {
        finalStock = serialCount;
      } else {
        // If user provided an explicit totalStockQuantity, respect it; otherwise default to 1
        const explicit = Number(formData.totalStockQuantity ?? 0);
        finalStock = explicit > 0 ? explicit : finalStock > 0 ? finalStock : 1;
      }
    }
    const payload = {
      ...formData,
      totalStockQuantity: finalStock,
      unopenedQuantity: Number(formData.unopenedQuantity ?? 0),
      openedQuantity: Number(formData.openedQuantity ?? 0),
      quantityPerUnit: Number(formData.quantityPerUnit ?? 1),
      reorderThreshold: Number(formData.reorderThreshold ?? 0),
      room: formData.location === 'HQ' ? formData.room : undefined,
      

      // Oxygen Data
      oxygenPsi: Number(formData.oxygenPsi),
      maxOxygenPsi: Number(formData.maxOxygenPsi),
      oxygenModel: formData.oxygenModel || undefined,
      
      // openedAt retained for open-box tracking; expiration fields are only per-batch now
      openedAt: safeParseDate(formData.openedAt as any),

      // Asset / Audit fields
      isAsset: !!formData.isAsset,
      assetValue: formData.assetValue ?? undefined,
      assetStatus: formData.assetStatus ?? undefined,
      assetSerial: (formData as any).assetSerial ?? undefined,
      parentAssetId: (formData as any).parentAssetId ?? undefined,
      assignedToId: (formData as any).assignedToId ?? undefined,
      // Per-asset checks live on each entry in `assets[]` for AEDs; remove top-level fields
      
      requiresExpirationCheck: !!formData.requiresExpirationCheck,

      // Reagent and Legacy tracking
      isReagent: !!(formData as any).isReagent,
      daysValidAfterOpening: (formData as any).daysValidAfterOpening ?? 90,

        variants: formData.hasVariants ? (formData.variants || []).map(v => ({
        ...v,
        requiresExpirationCheck: v.requiresExpirationCheck ?? formData.requiresExpirationCheck ?? false,
        quantityPerUnit: Number(v.quantityPerUnit),
        stock: Number(v.stock),
        reorderThreshold: Number(v.reorderThreshold ?? formData.reorderThreshold ?? 0),
        batches: (v.batches || []).map(b => ({
          ...b,
          stock: Number((b as any).stock ?? 0),
          expirationDate: safeParseDate((b as any).expirationDate),
          openDate: safeParseDate((b as any).openDate),
          receivedAt: safeParseDate((b as any).receivedAt),
          locations: (b.locations || []).map(loc => ({ ...loc, quantity: Number(loc.quantity ?? 0), name: loc.name ?? '' }))
        }))
      })) : [],
      // include batches if any (convert dates/numbers client-side)
        batches: (formData.batches || []).map(b => ({
        ...b,
        stock: Number((b as any).stock ?? 0),
        expirationDate: safeParseDate((b as any).expirationDate),
        openDate: safeParseDate((b as any).openDate),
        receivedAt: safeParseDate((b as any).receivedAt),
        locations: (b.locations || []).map(loc => ({
          ...loc,
          quantity: Number(loc.quantity ?? 0),
          name: loc.name ?? ''
        })),
        // Serialized batch: keep serial numbers but do not create per-unit asset metadata here (disposables-only)
        assetInstances: (Array.isArray(b.serialNumbers) ? (b.serialNumbers || []).map((s: string) => ({
          serial: s,
          lastChecked: undefined
        })) : undefined)
      }))
    };
    // Items created here are disposables; do not synthesize top-level assets list

    // Remove master-level location fields when batches are present — batches own location data
    if (masterHasBatches) {
      delete payload.location;
      delete payload.room;
      delete payload.shelf;
    }

    if (initialData && initialData.id) {
      onUpdateItem(initialData.id, payload as Partial<InventoryItem>);
      notify({ title: 'Item updated', description: `${String(payload.name)} updated`, variant: 'success' });
    } else {
      // Create item + audit atomically using a write batch
      try {
        const batch = writeBatch(db);
        const newRef = doc(coll(db, 'inventory'));
        batch.set(newRef, payload as any);
        // Add audit event referencing the new inventory doc
        addAuditEventToBatch(batch, {
          eventType: 'inventory.create',
          source: 'inventory',
          sourceId: newRef.id,
          after: { name: payload.name, sku: payload.sku, barcode: payload.barcode, totalStockQuantity: payload.totalStockQuantity }
        });
        await batch.commit();
        // Notify UI and call onAddItem so parent can update local state
        notify({ title: 'Item added', description: `${String(payload.name)} added`, variant: 'success' });
        onAddItem({ ...(payload as any), id: newRef.id });
      } catch (err) {
        console.error('create item batch failed', err);
        // eslint-disable-next-line no-alert
        alert('Failed to create item. Please try again.');
      }
    }

    onClose();
  };

    // Keyboard shortcuts: Enter to submit, Esc to cancel when modal open
    useEffect(() => {
      if (!isOpen) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onOpenChange();
        } else if (e.key === 'Enter') {
          // basic guard to avoid accidental submits when focus is on textarea or buttons
          const active = document.activeElement as HTMLElement | null;
          if (active && (active.tagName === 'TEXTAREA')) return;
          handleSubmit(() => onOpenChange());
        }
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }, [isOpen, formData]);

  const getDateString = (date?: Date | string) => {
    if (!date) return '';
    const d = new Date(date as any);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  };

  const isEditMode = !!initialData;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      placement="center"
      backdrop="blur"
      size="4xl"
      scrollBehavior="inside"
      classNames={{
        base: "dark:bg-slate-800",
        header: "border-b-[1px] border-gray-200 dark:border-slate-700",
        footer: "border-t-[1px] border-gray-200 dark:border-slate-700",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <h2 className="text-xl font-bold">
                {isEditMode ? 'Edit Inventory Item' : 'Add New Inventory Item'}
              </h2>
              <p className="text-sm text-gray-500 font-normal">
                Manage stock, variations, and tracking details.
              </p>
            </ModalHeader>
            <ModalBody className="py-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {initialData && (initialData as any).isAsset && (
                  <div className="md:col-span-2 p-4 bg-red-50 dark:bg-red-900/10 rounded-md border border-red-100 text-sm">
                    <div className="font-semibold mb-2">Asset Detected</div>
                    <div>This item appears to be an Asset. The Inventory modal now manages disposables only — please use the Assets editor to view or edit asset items.</div>
                  </div>
                )}
                
                {/* --- BASIC INFO --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-2">Item Details</h3>
                <div className="md:col-span-2 flex items-center justify-end gap-2">
                  <span className="text-xs text-gray-500">Show advanced</span>
                  <Switch isSelected={showAdvanced} onValueChange={(v) => setShowAdvanced(v)} />
                </div>

                <Input 
                  label="Item Name" 
                  placeholder="e.g., Nitrile Gloves" 
                  variant="bordered"
                  value={formData.name}
                  autoFocus
                  onValueChange={(v) => {
                    setFormData(prev => ({ ...prev, name: v }));
                    // If name looks like an AED and user hasn't indicated asset/AED, show prompt (UI handled below)
                  }}
                  className="md:col-span-2"
                />

                <Input
                  label="SKU (optional)"
                  placeholder="e.g., GLV-100"
                  variant="bordered"
                  value={formData.sku}
                  onValueChange={handleValueChange('sku')}
                  className="md:col-span-1"
                />
                <Input
                  label="Barcode (optional)"
                  placeholder="e.g., 0123456789012"
                  variant="bordered"
                  value={formData.barcode}
                  onValueChange={handleValueChange('barcode')}
                  className="md:col-span-1"
                />

                {/* Duplicate suggestions */}
                <div className="md:col-span-2">
                  {checkingDuplicates ? (
                    <div className="text-xs text-gray-500">Checking for similar items...</div>
                  ) : (duplicates && duplicates.length > 0) ? (
                    <div className="mt-2 p-2 border rounded-md bg-yellow-50 dark:bg-yellow-900/10 text-sm">
                      <div className="font-semibold text-xs mb-1">Similar items found</div>
                      <div className="space-y-1">
                        {duplicates.map(d => (
                          <div key={d.id} className="flex items-center justify-between">
                            <div className="text-xs">{String(d.name)} {d.unit ? `• ${d.unit}` : ''} <span className="text-gray-400">({d.id})</span></div>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="flat" onPress={() => prefillFromExisting(d)}>Prefill</Button>
                              <Button size="sm" variant="light" color="primary" onPress={() => { if (d.id) onUpdateItem(d.id, {}); }}>Open</Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* --- STATPACK QUICK ADD --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Statpack Quick Add</h3>
                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
                  <Input
                    label="Statpack ID"
                    placeholder="e.g., sp_12345"
                    variant="bordered"
                    value={statpackId}
                    onValueChange={(v) => setStatpackId(v)}
                    className="md:col-span-2"
                  />
                  <Button color="primary" variant="flat" onPress={loadStatpack} isLoading={statpackLoading}>
                    Load Statpack
                  </Button>
                </div>
                {statpack && (
                  <div className="md:col-span-2 border rounded-md p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-semibold">{statpack.name}</div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Add whole pack</span>
                        <Switch isSelected={addWholePack} onValueChange={(v) => {
                          setAddWholePack(v);
                          if (v) setSelectedPackItemIds(new Set((statpack.contents || []).map((i: any) => i.itemId)));
                        }} />
                      </div>
                    </div>
                    <div className="max-h-48 overflow-auto divide-y">
                      {(statpack.contents || []).map((i: any) => (
                        <label key={i.itemId} className="flex items-center justify-between py-2">
                          <div className="text-sm">
                            {i.itemDetails?.name || i.itemName || 'Item'}
                            {i.variantName ? <span className="text-xs text-gray-500"> • {i.variantName}</span> : null}
                          </div>
                          {!addWholePack && (
                            <input
                              type="checkbox"
                              checked={selectedPackItemIds.has(i.itemId)}
                              onChange={() => togglePackItem(i.itemId)}
                            />
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-gray-500">
                      Selected items will be created in inventory and linked to this statpack.
                    </div>
                  </div>
                )}

                {/* AED suggestion removed: inventory modal is disposables-only now */}

                <Select 
                  label="Category" 
                  variant="bordered"
                  selectedKeys={formData.category ? [formData.category] : []}
                  onSelectionChange={(keys) => setFormData({...formData, category: Array.from(keys)[0] as ItemCategory})}
                >
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat}>{cat}</SelectItem>
                  ))}
                </Select>


                {/* Asset toggle removed: all items created/edited here are disposables */}


                <div className="flex items-center justify-between p-3 border-2 border-default-200 rounded-xl">
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-600 dark:text-gray-400">Require Expiration Confirmation?</span>
                    <span className="text-xs text-gray-400">When enabled, users must confirm expiration date during checkout for this item.</span>
                  </div>
                  <Switch isSelected={!!formData.requiresExpirationCheck} onValueChange={(val) => setFormData({...formData, requiresExpirationCheck: val})} />
                </div>

                {/* --- LOCATION --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Location</h3>
                
                <Select 
                  label="Building / Area" 
                  variant="bordered"
                  selectedKeys={formData.location ? [formData.location] : []}
                  onSelectionChange={(keys) => setFormData({...formData, location: Array.from(keys)[0] as LocationType})}
                  isDisabled={masterHasBatches}
                >
                  {LOCATIONS.map((loc) => (
                    <SelectItem key={loc}>{loc}</SelectItem>
                  ))}
                </Select>

                {formData.location === 'HQ' ? (
                  <Select 
                    label="HQ Room" 
                    variant="bordered"
                    selectedKeys={formData.room ? [formData.room] : []}
                    onSelectionChange={(keys) => setFormData({...formData, room: Array.from(keys)[0] as HQRoom})}
                    isDisabled={masterHasBatches}
                  >
                    {HQ_ROOMS.map((room) => (
                      <SelectItem key={room}>{room}</SelectItem>
                    ))}
                  </Select>
                ) : <div className="hidden md:block"></div>}

                {masterHasBatches && (
                  <div className="md:col-span-2 text-xs text-gray-500">Location is tracked per-batch when batches exist; master location is disabled.</div>
                )}

                <Input 
                  label="Shelf / Bin" 
                  placeholder="e.g., Top Shelf, Bin 4" 
                  variant="bordered"
                  value={formData.shelf}
                  onValueChange={handleValueChange('shelf')}
                  className="md:col-span-2"
                />

                {/* --- SPECIAL TRACKING: OXYGEN & BOXES --- */}
                {(showAdvanced || formData.isAsset || formData.tracksOpenStock || formData.isOxygen || formData.hasVariants || ((formData.batches || []).length > 0)) && (
                  <>
                    <Divider className="md:col-span-2 my-2" />
                    <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Oxygen Switch */}
                  <div className={`p-3 border-2 rounded-xl transition-all ${formData.isOxygen ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Wind size={18} className={formData.isOxygen ? "text-blue-600" : "text-gray-400"} />
                          <span className="text-sm font-bold">Oxygen Tank?</span>
                        </div>
                        <Switch isSelected={formData.isOxygen} onValueChange={(val) => setFormData({...formData, isOxygen: val, tracksOpenStock: false, hasVariants: false})} />
                      </div>
                      {formData.isOxygen && (
                        <div className="space-y-4 pt-2">
                           <Input label="Tank Model (optional)" size="sm" placeholder="e.g., Luxfer 3000" value={String(formData.oxygenModel ?? '')} onValueChange={(v) => setFormData({...formData, oxygenModel: v})} />
                           <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span>Current Pressure</span>
                                <span className="font-bold">{formData.oxygenPsi} PSI</span>
                              </div>
                              <Slider 
                                size="sm"
                                color="primary"
                                step={50}
                                minValue={0}
                                maxValue={Number(formData.maxOxygenPsi || 2000)} 
                                value={formData.oxygenPsi} 
                                onChange={(val) => setFormData({...formData, oxygenPsi: Number(val)})}
                              />
                           </div>
                           <Input 
                              type="number"
                              label="Max Capacity (PSI)"
                              size="sm"
                              variant="flat"
                              value={formData.maxOxygenPsi?.toString()}
                              onValueChange={(v) => setFormData({...formData, maxOxygenPsi: Number(v)})}
                           />
                        </div>
                      )}
                  </div>

                  {/* Box Tracking  */}
                  <div className={`p-3 border-2 rounded-xl transition-all ${'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Boxes size={18} className="text-blue-600" />
                          <span className="text-sm font-bold">Box-Based Tracking</span>
                        </div>
                      </div>
                      <p className="text-xs text-gray-500">Track inventory by unopened boxes only.</p>
                  </div>

                  {/* Reagent Tracking */}
                  <div className={`p-3 border-2 rounded-xl transition-all ${(formData as any).isReagent ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <CalendarClock size={18} className={(formData as any).isReagent ? "text-orange-600" : "text-gray-400"} />
                          <span className="text-sm font-bold">Reagent (Degrades After Opening)?</span>
                        </div>
                        <Switch isSelected={!!(formData as any).isReagent} onValueChange={(val) => setFormData({...formData, isReagent: val} as any)} />
                      </div>
                      <p className="text-xs text-gray-500">Enable for Glucose strips, Control solutions, Eye wash that expire X days after opening.</p>
                      {(formData as any).isReagent && (
                        <Input 
                          type="number"
                          label="Days Valid After Opening"
                          size="sm"
                          variant="flat"
                          className="mt-2"
                          value={((formData as any).daysValidAfterOpening ?? 90).toString()}
                          onValueChange={(v) => setFormData({...formData, daysValidAfterOpening: Number(v)} as any)}
                        />
                      )}
                  </div>

                  
                  </div>
                  </>
                )}

                {/* --- STOCK INPUTS --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Stock Levels</h3>

                {/* Scenario A: Oxygen */}
                {formData.isOxygen && (
                   <div className="md:col-span-2 p-4 bg-blue-50 dark:bg-blue-900/10 rounded-xl border border-blue-100 text-center">
                      <p className="text-sm text-blue-800 dark:text-blue-200">
                        Tracking as Single Tank unit. Add multiple items for multiple tanks.
                      </p>
                   </div>
                )}

                {/* Scenario B: Box Tracking (Default) */}
                {!formData.isOxygen && !formData.tracksOpenStock && (
                  <div className="md:col-span-2 grid grid-cols-2 gap-4 bg-blue-50 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-100">
                      <Input 
                        type="number" 
                        label="Unopened Boxes" 
                        placeholder="0" 
                        variant="bordered"
                        value={formData.unopenedBoxes?.toString() ?? '0'}
                        onValueChange={(v) => setFormData({...formData, unopenedBoxes: Number(v)})}
                        description="Number of unopened boxes"
                      />
                      <Input 
                        type="number" 
                        label="Items Per Box (optional)" 
                        placeholder="e.g., 100" 
                        variant="bordered"
                        value={formData.itemsPerBox?.toString() ?? ''}
                        onValueChange={(v) => setFormData({...formData, itemsPerBox: v ? Number(v) : undefined})}
                        description="How many items in one box"
                      />
                  </div>
                )}

                {/* Scenario C: Standard Stock (Only if not oxygen and not tracking open stock) */}
                {!formData.isOxygen && !formData.tracksOpenStock && (
                  <>
                    <Input 
                      type="number" 
                      label="Current Stock" 
                      placeholder="0" 
                      variant="bordered"
                      className="md:col-span-2"
                      value={formData.totalStockQuantity?.toString() ?? ''}
                      onValueChange={handleValueChange('totalStockQuantity')}
                    />
                  </>
                )}

                {/* Asset fields: status + last checked + next expiration */}
                {formData.isAsset && (
                  <div className="md:col-span-2 mt-4 p-4 border rounded-xl bg-green-50 dark:bg-green-900/10">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Input
                        label="Asset Value (USD)"
                        placeholder="500"
                        type="number"
                        value={formData.assetValue != null ? String(formData.assetValue) : ''}
                        onValueChange={(v) => setFormData({...formData, assetValue: v ? Number(v) : undefined})}
                      />
                      {((formData as any).assetCategory !== 'AED') ? (
                        <Select label="Asset Status" variant="bordered" selectedKeys={formData.assetStatus ? [formData.assetStatus] : []} onSelectionChange={(k) => setFormData({...formData, assetStatus: Array.from(k)[0] as any})}>
                          <SelectItem key="Ready">Ready</SelectItem>
                          <SelectItem key="Not Ready">Not Ready</SelectItem>
                        </Select>
                      ) : null}
                      <div className="space-y-2">
                        <Select label="Asset Category" variant="bordered" selectedKeys={(formData as any).assetCategory ? [String((formData as any).assetCategory)] : []} onSelectionChange={(k) => setFormData({...formData, assetCategory: Array.from(k)[0] as any})}>
                          <SelectItem key="Generic">Generic</SelectItem>
                          <SelectItem key="AED">AED</SelectItem>
                          <SelectItem key="Radio">Radio</SelectItem>
                          <SelectItem key="Oxygen Tank">Oxygen Tank</SelectItem>
                        </Select>
                        {((formData as any).assetCategory === 'AED') && (
                          <Input
                            label="AED Model"
                            placeholder="e.g., Philips FRx"
                            value={(formData as any).assetModel ?? ''}
                            onValueChange={(v) => setFormData({...formData, assetModel: v})}
                          />
                        )}
                      </div>
                      {/* Per-unit expirations live only on `assets[]`; top-level fields removed */}
                      <Input
                        label="Asset Serial #"
                        placeholder="e.g., SN-12345"
                        value={(formData as any).assetSerial ?? ''}
                        onValueChange={(v) => setFormData({...formData, assetSerial: v})}
                      />
                    </div>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                      {/* Per-unit checks moved into each AED unit; top-level battery/pads/notes removed */}
                    </div>
                    {/* Per-unit Assets (Non-Fungible) - list editable when AED */}
                    {((formData as any).assetCategory === 'AED') && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm font-semibold">AED Units</div>
                          <Button size="sm" color="primary" variant="flat" onPress={() => addAsset()} startContent={<Plus size={12} />}>Add Unit</Button>
                        </div>
                        {(formData.assets || []).length === 0 ? (
                          <p className="text-xs text-gray-500">No AED units defined. Add units individually or enter serials as a batch.</p>
                        ) : (
                          <div className="space-y-2">
                            {(formData.assets || []).map((a, idx) => (
                              <div key={`${a.id ?? idx}-${idx}`} className="p-3 border rounded-md bg-white dark:bg-slate-900/40">
                                <div className="flex flex-wrap md:flex-nowrap items-end gap-2">
                                  <div className="w-40">
                                    <Input size="sm" className="w-full" label="Asset Tag / ID" value={a.assetTag ?? ''} onValueChange={(v) => updateAssetField(idx, 'assetTag', v)} />
                                  </div>
                                  <div className="w-36">
                                    <Input size="sm" className="w-full" label="Serial #" value={a.serial ?? ''} onValueChange={(v) => updateAssetField(idx, 'serial', v)} />
                                  </div>
                                  <div className="w-40">
                                    <Input size="sm" className="w-full" type="date" label="Pad Expiration" value={getDateString(a.padExpiration as any)} onValueChange={(v) => updateAssetField(idx, 'padExpiration', v ? new Date(v) : undefined)} />
                                  </div>
                                  <div className="w-40">
                                    <Input size="sm" className="w-full" type="date" label="Battery Expiration" value={getDateString(a.batteryExpiration as any)} onValueChange={(v) => updateAssetField(idx, 'batteryExpiration', v ? new Date(v) : undefined)} />
                                  </div>
                                  <div className="w-56 flex items-center justify-between">
                                    <Select size="sm" className="max-w-[280px] w-full" label="Status" variant="bordered" selectedKeys={a.status ? [a.status] : []} onSelectionChange={(k) => updateAssetField(idx, 'status', Array.from(k)[0] as any)}>
                                      <SelectItem key="Ready">Ready</SelectItem>
                                      <SelectItem key="Not Ready">Not Ready</SelectItem>
                                      <SelectItem key="Maintenance">Maintenance</SelectItem>
                                    </Select>
                                    <Button size="sm" className="ml-2 p-1" color="danger" variant="light" onPress={() => removeAsset(idx)}><Trash2 size={14} /></Button>
                                  </div>
                                </div>
                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                                  <Input size="sm" label="Assigned To (Statpack/Location)" value={assignedNames[a.assignedToId as string] ?? a.currentLocation ?? a.assignedToId ?? ''} onValueChange={(v) => updateAssetField(idx, 'assignedToId', v)} />
                                  <Input size="sm" label="Current Location" value={a.currentLocation ?? ''} onValueChange={(v) => updateAssetField(idx, 'currentLocation', v)} />
                                  <Input size="sm" type="date" label="Last Checked" value={getDateString(a.lastChecked as any)} onValueChange={(v) => updateAssetField(idx, 'lastChecked', v ? new Date(v) : undefined)} />
                                </div>
                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                                  <Select size="sm" label="Battery Status" variant="bordered" selectedKeys={(a as any).batteryStatus ? [String((a as any).batteryStatus)] : []} onSelectionChange={(k) => updateAssetField(idx, 'batteryStatus', Array.from(k)[0] as any)}>
                                    <SelectItem key="Good">Good</SelectItem>
                                    <SelectItem key="Low">Low</SelectItem>
                                    <SelectItem key="Unknown">Unknown</SelectItem>
                                  </Select>
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm">Pads Sealed?</span>
                                    <Switch isSelected={!!(a as any).padsSealed} onValueChange={(v) => updateAssetField(idx, 'padsSealed', v)} />
                                  </div>
                                  <Input size="sm" type="date" label="Next Expiration" value={getDateString((a as any).nextExpiration as any)} onValueChange={(v) => updateAssetField(idx, 'nextExpiration', v ? new Date(v) : undefined)} />
                                </div>
                                <div className="mt-2">
                                  <Input size="sm" label="Last Check Notes" value={(a as any).lastCheckNotes ?? ''} onValueChange={(v) => updateAssetField(idx, 'lastCheckNotes', v)} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                
                <div className="md:col-span-1">
                  <Input 
                    label="Unit Type" 
                    placeholder="e.g., box, count" 
                    variant="bordered"
                    value={formData.unit}
                    onValueChange={handleValueChange('unit')}
                  />
                </div>
                <div className="md:col-span-1">
                   <Input 
                    type="number" 
                    label="Reorder Threshold" 
                    placeholder="5" 
                    variant="bordered"
                    value={formData.reorderThreshold?.toString() ?? ''}
                    onValueChange={handleValueChange('reorderThreshold')}
                  />
                </div>

                {(showAdvanced || formData.hasVariants || ((formData.batches || []).length > 0)) && (
                  <>
                    <Divider className="md:col-span-2 my-2" />
                    <div className="flex flex-col gap-4 md:col-span-2 border-2 border-default-200 rounded-xl p-4">
                    {/* --- BATCH / LOTS --- */}
                    <Divider className="my-2" />
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Batches / Lots</span>
                          <span className="text-xs text-gray-400">Track lot numbers, expirations and per-lot stock.</span>
                        </div>
                        <Button size="sm" color="primary" variant="flat" onPress={addBatch} startContent={<Plus size={12} />}>Add Batch</Button>
                      </div>
                      {(formData.batches || []).length === 0 && (
                        <p className="text-xs text-gray-400">No batches added. Add a batch for lot-specific tracking.</p>
                      )}
                      <div className="space-y-2 mt-2">
                        {(formData.batches || []).map((b, bidx) => (
                          <div key={`${b.id}-${bidx}`} className="space-y-2 p-2 border rounded-md bg-gray-50 dark:bg-slate-800/40">
                            <div className={`grid grid-cols-1 gap-2 items-end ${(formData as any).isReagent ? 'md:grid-cols-7' : 'md:grid-cols-6'}`}>
                              {formData.hasVariants ? (
                                <Select size="sm" label="Variant" variant="bordered" selectedKeys={b.variantId ? [b.variantId] : []} onSelectionChange={(keys) => updateBatch(b.id, 'variantId', Array.from(keys)[0] as string)}>
                                  {(formData.variants || []).map(v => (<SelectItem key={v.id}>{v.name || v.id}</SelectItem>))}
                                </Select>
                              ) : null}
                              <Input size="sm" label="Lot # (optional)" value={b.lotNumber || ''} onValueChange={(v) => updateBatch(b.id, 'lotNumber', v)} />
                              <Input size="sm" type="date" label="Expiration" value={getDateString(b.expirationDate as Date)} onValueChange={(v) => updateBatch(b.id, 'expirationDate', v ? new Date(v) : undefined)} />
                              {(formData as any).isReagent && (
                                <Input size="sm" type="date" label="Opened Date" value={getDateString((b as any).openDate as Date)} onValueChange={(v) => updateBatch(b.id, 'openDate', v ? new Date(v) : undefined)} />
                              )}
                              <Input size="sm" type="number" label="Qty Total" value={String((b as any).stock ?? 0)} onValueChange={(v) => updateBatch(b.id, 'stock', Number(v))} />
                              <Input size="sm" type="date" label="Received" value={getDateString((b.receivedAt as Date) ?? undefined)} onValueChange={(v) => updateBatch(b.id, 'receivedAt', v ? new Date(v) : undefined)} />
                              <Input size="sm" label="Notes" value={(b as any).notes ?? ''} onValueChange={(v) => updateBatch(b.id, 'notes', v)} />
                              
                              {/* Purchase/Vendor Info */}
                              <Divider className="md:col-span-4 my-2" />
                              <div className="md:col-span-4 text-xs font-semibold text-gray-500 uppercase">Purchase Info (Optional)</div>
                              <Input size="sm" label="Supplier Name" placeholder="e.g., Medline" value={(b.purchase as any)?.supplierName ?? ''} onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), supplierName: v })} />
                              <Input size="sm" label="Price Per Unit" type="number" placeholder="0.00" value={(b.purchase as any)?.pricePerUnit?.toString() ?? ''} onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), pricePerUnit: v ? Number(v) : undefined })} />
                              <Input size="sm" label="Currency" placeholder="USD" value={(b.purchase as any)?.currency ?? ''} onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), currency: v })} />
                              <Input size="sm" label="PO / Invoice #" placeholder="PO-1234" value={(b.purchase as any)?.purchaseOrderId ?? ''} onValueChange={(v) => updateBatch(b.id, 'purchase', { ...(b.purchase || {}), purchaseOrderId: v })} />
                              
                              <div className="flex items-center gap-2">
                                <div className="flex items-center">
                                  <span className="text-xs mr-2">Serialized (unit-level)?</span>
                                  <Switch isSelected={!!b.serialized} onValueChange={(val) => updateBatch(b.id, 'serialized', val)} />
                                </div>
                                <div className="ml-auto flex items-center justify-end"><Button size="sm" color="danger" variant="light" onPress={() => removeBatch(b.id)}><Trash2 size={14} /></Button></div>
                              </div>
                              {b.serialized && (
                                <div className="mt-2 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-xs text-gray-500">Serial / Unit IDs (one per unit)</div>
                                    <Button size="sm" variant="flat" color="secondary" onPress={() => addBatchSerial(b.id)} startContent={<Plus size={12} />}>Add Serial</Button>
                                  </div>
                                  <div className="space-y-1">
                                    {(b.serialNumbers || []).map((s, si) => (
                                      <div key={`${b.id}-serial-${si}`} className="flex items-center gap-2">
                                        <Input size="sm" label={si === 0 ? 'Serials' : ''} value={s || ''} onValueChange={(v) => updateBatchSerial(b.id, si, v)} />
                                        <Button size="sm" color="danger" variant="light" onPress={() => removeBatchSerial(b.id, si)}><Trash2 size={12} /></Button>
                                      </div>
                                    ))}
                                    {/* Display a helper count check */}
                                    <div className="text-xs text-gray-400">Serials: {(b.serialNumbers || []).length} — Qty: {String((b as any).stock ?? 0)}</div>
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="bg-white dark:bg-slate-900/40 rounded-md p-2 border border-dashed border-gray-200 dark:border-slate-700">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">Locations for this batch</span>
                                <Button size="sm" variant="flat" color="secondary" onPress={() => addBatchLocation(b.id)} startContent={<Plus size={12} />}>Add Location</Button>
                              </div>
                              {(b.locations && b.locations.length > 0) ? (
                                <div className="space-y-2">
                                                            {b.locations.map((loc, lidx) => (
                                                              <div key={`${loc.id}-${lidx}`} className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                                                                <Select 
                                                                  size="sm"
                                                                  label="Area"
                                                                  variant="bordered"
                                                                  selectedKeys={loc.area ? [loc.area] : []}
                                                                  onSelectionChange={(keys) => updateBatchLocation(b.id, loc.id, 'area', Array.from(keys)[0] as LocationType)}
                                                                  className="md:col-span-2"
                                                                >
                                                                  {LOCATIONS.map((locOpt) => (<SelectItem key={locOpt}>{locOpt}</SelectItem>))}
                                                                </Select>

                                                                {loc.area === 'HQ' ? (
                                                                  <Select 
                                                                    size="sm"
                                                                    label="HQ Room"
                                                                    variant="bordered"
                                                                    selectedKeys={loc.room ? [loc.room] : []}
                                                                    onSelectionChange={(keys) => updateBatchLocation(b.id, loc.id, 'room', Array.from(keys)[0] as HQRoom)}
                                                                    className="md:col-span-1"
                                                                  >
                                                                    {HQ_ROOMS.map((r) => (<SelectItem key={r}>{r}</SelectItem>))}
                                                                  </Select>
                                                                ) : (
                                                                  <div className="hidden md:block" />
                                                                )}

                                                                <Input size="sm" label="Shelf / Bin" placeholder="Top Shelf, Bin 4" variant="bordered" value={loc.shelf ?? ''} onValueChange={(v) => updateBatchLocation(b.id, loc.id, 'shelf', v)} className="md:col-span-1" />

                                                                <Input size="sm" type="number" label="Qty here" value={String(loc.quantity ?? 0)} onValueChange={(v) => updateBatchLocation(b.id, loc.id, 'quantity', Number(v))} className="md:col-span-1" />

                                                                <div className="flex items-center justify-end"><Button size="sm" color="danger" variant="light" onPress={() => removeBatchLocation(b.id, loc.id)}><Trash2 size={14} /></Button></div>
                                                              </div>
                                                            ))}
                                </div>
                              ) : (
                                <p className="text-[11px] text-gray-500">Use location rows to split this batch across spots (e.g., 3 in back storage, 2 in Statpack).</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    </div>
                  </>
                )}

                <div className="md:col-span-2 mt-2">
                     <Textarea
                        label="Description (Optional)"
                        placeholder="Details..."
                        variant="bordered"
                        value={formData.description}
                        onValueChange={handleValueChange('description')}
                    />
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button color="danger" variant="light" onPress={onClose}>
                Cancel
              </Button>
              {statpack && (
                <Button
                  color="secondary"
                  variant="flat"
                  onPress={async () => {
                    try {
                      const items = (statpack.contents || []) as StatpackItem[];
                      const chosen = addWholePack ? items : items.filter(i => selectedPackItemIds.has(i.itemId));
                      if (chosen.length === 0) {
                        notify({ title: 'No items selected', description: 'Select items or toggle Add whole pack.' });
                        return;
                      }
                      await batchAddInventoryFromStatpack({
                        statpack,
                        selected: chosen,
                        defaults: {
                          location: formData.location,
                          room: formData.room,
                          shelf: formData.shelf,
                          reorderThreshold: Number(formData.reorderThreshold ?? 5),
                          unit: formData.unit || 'count',
                          
                        }
                      });
                      notify({ title: 'Added items from statpack', description: `${chosen.length} item(s) created and linked.` });
                      onClose();
                    } catch (e) {
                      notify({ title: 'Failed to add from statpack', description: 'Please try again.' });
                    }
                  }}
                >
                  Add Selected from Statpack
                </Button>
              )}
              <Button color="primary" onPress={() => handleSubmit(onClose)} className="font-semibold shadow-lg">
                {isEditMode ? 'Save Changes' : 'Add Item'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}