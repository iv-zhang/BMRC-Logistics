'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, Chip, Progress, Button, Spinner, useDisclosure, Input, 
  Select, SelectItem
} from '@heroui/react';
import { Boxes, Plus, Minus, Search, Wind, PackageOpen, Filter, X, Edit2, ChevronDown } from 'lucide-react';

// Firebase Imports
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { 
  collection, 
  addDoc,
  doc,
  updateDoc, 
  deleteDoc,
  onSnapshot, 
  query, 
  orderBy, 
  serverTimestamp, 
  Timestamp,
  getDoc
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 

import InventoryModal from '@/app/components/additemmodal';
import { getOldestValidBatch, getSmartPickInstructions, isBatchExpired } from '@/app/utils/batchHelpers';

// Types
import { InventoryItem, ItemCategory, LocationType, User } from '@/app/types';

// Constants for Filters
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const LOCATIONS: LocationType[] = ['HQ', 'CPR Closet', 'Shed'];

export default function InventoryPage() {
  const uniqueId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const isAdmin = userRole === 'admin';

  // --- SEARCH & FILTER STATE ---
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterLocation, setFilterLocation] = useState<string>('all');

  // --- AUTH & ROLE LOGIC ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) setUser(currentUser);
      else router.push('/login');
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userRef, (snapshot) => {
        const data = snapshot.data() as User | undefined;
        setUserRole(data?.role ?? 'member');
    });
    return () => unsubscribe();
  }, [user]);

  // --- DATA FETCHING ---
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => {
        const data = doc.data();
        const getDate = (ts: unknown) => {
          if (!ts) return undefined;
          if (ts instanceof Timestamp) return ts.toDate();
          if (ts instanceof Date) return ts;
          if (typeof ts === 'string') {
            const parsed = new Date(ts);
            return isNaN(parsed.getTime()) ? undefined : parsed;
          }
          return undefined;
        };

        // normalize variants with defaults and per-variant reorder thresholds
        // Filter out any variant-like entries that are actually batches/lots
        // (they typically have `lotNumber` or `expirationDate`). Keep variants
        // strictly for sizing/options (e.g., S/M/L). Convert any expirable
        // variants into batches so lot tracking is preserved.
        const rawVariants = (data.variants || []) as any[];
        const variantBatches = rawVariants
          .filter(v => v.lotNumber || v.expirationDate)
          .map(v => ({
            id: v.id ?? (crypto.randomUUID?.() ?? Math.random().toString()),
            lotNumber: v.lotNumber ?? '',
            expirationDate: getDate(v.expirationDate),
            stock: Number(v.stock ?? 0),
            receivedAt: getDate((v as any).receivedAt),
            notes: v.notes ?? `Variant: ${v.name ?? ''}`,
            // variant-derived batches are not serialized
            serialized: false,
            serialNumbers: [],
            locations: [],
          }));

        const variants = rawVariants
          .filter(v => !v.lotNumber && !v.expirationDate)
          .map(v => ({
            id: v.id,
            name: v.name,
            quantityPerUnit: v.quantityPerUnit ?? data.quantityPerUnit ?? 1,
            stock: v.stock ?? 0,
            lotNumber: v.lotNumber ?? null,
            expirationDate: getDate(v.expirationDate),
            reorderThreshold: v.reorderThreshold ?? data.reorderThreshold ?? 0
          }));

        // Normalize batches (legacy or explicit batch storage) into both `batches` and `variants` for UI
        const rawBatches = (data.batches || []) as any[];
        const batches = rawBatches.map(b => ({
          id: b.id,
          lotNumber: b.lotNumber ?? b.lot ?? '',
          expirationDate: getDate(b.expirationDate),
          stock: Number(b.stock ?? 0),
          receivedAt: getDate(b.receivedAt),
          notes: b.notes,
          // preserve serialized flag and serialNumbers for asset tracking
          serialized: !!b.serialized,
          serialNumbers: Array.isArray(b.serialNumbers) ? b.serialNumbers.slice() : [],
          locations: Array.isArray(b.locations) ? b.locations.map((l: any) => ({
            id: l.id ?? crypto.randomUUID?.() ?? Math.random().toString(),
            name: l.name ?? '',
            quantity: Number(l.quantity ?? 0)
          })) : [],
        }));

        // Preserve expirable variants by folding them into batches
        if (variantBatches.length > 0) batches.push(...variantBatches);

        // If any batch has an expirationDate OR is serialized, preserve batch-level tracking.
        // Also preserve batches if the item explicitly tracksExpiration.
        // Otherwise treat batches as static stock and aggregate into master counts.
        const hasBatchExpirations = batches.some(b => !!b.expirationDate || !!b.lotNumber || !!(b as any).serialized);
        if (hasBatchExpirations) {
          // Keep batches intact for lot-level UI; do not map batches into `variants`.
          // Variants remain reserved for size/option variations.
          // Ensure totalStockQuantity reflects batch sums when batches exist.
          const batchSum = batches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
          data.totalStockQuantity = data.totalStockQuantity ?? batchSum;
        } else {
          // Aggregate static batches into the master total (don't expose per-lot UI)
          const staticTotal = batches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
          // prefer explicit totalStockQuantity if provided, otherwise use aggregated total
          data.totalStockQuantity = data.totalStockQuantity ?? staticTotal;
          // clear batches so UI treats this as a static-tracked item
          batches.length = 0;
        }

        return {
          id: doc.id,
          ...data,
          // Sanitization
          location: data.location || 'HQ',
          totalStockQuantity: data.totalStockQuantity ?? 0,
          unopenedQuantity: data.unopenedQuantity ?? 0,
          openedQuantity: data.openedQuantity ?? 0,
          quantityPerUnit: data.quantityPerUnit ?? 1,
          oxygenPsi: data.oxygenPsi ?? 0,
          maxOxygenPsi: data.maxOxygenPsi ?? 2000,
          variants,
          batches,

          openedAt: getDate(data.openedAt),
          createdAt: getDate(data.createdAt) || new Date(),
          updatedAt: getDate(data.updatedAt) || new Date(),
        } as InventoryItem;
      });

      setInventory(items);
      setLoading(false);
    }, (error) => console.error("Inventory listener error:", error));

    return () => unsubscribe();
  }, [user]);

  // --- CRUD HANDLERS ---
  const handleAddItem = async (newItemData: Partial<InventoryItem>) => {
    try {
      const payload = preparePayload(newItemData);
      // Try to find an existing master item to merge into (match by name + location)
      const nameKey = (payload.name || '').toString().trim().toLowerCase();
      const locationKey = (payload.location || 'HQ').toString();
      const match = inventory.find(i => (i.name || '').toString().trim().toLowerCase() === nameKey && (i.location || 'HQ') === locationKey);

      if (match) {
        // Merge payload into existing item as variants-aware update
        const itemRef = doc(db, 'inventory', match.id);
        try {
          const snap = await getDoc(itemRef);
          if (!snap.exists()) {
            // fallback: create new
            await addDoc(collection(db, 'inventory'), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
            return;
          }

          const data = snap.data() as any;
          const existingVariants: any[] = Array.isArray(data.variants) ? data.variants.slice() : [];
          const existingBatches: any[] = Array.isArray(data.batches) ? data.batches.slice() : [];

          // Helper to compare dates by Y/M/D
          const sameDay = (a: any, b: Date) => {
            if (!a || !b) return false;
            const ad = (a instanceof Date) ? a : (a?.toDate ? a.toDate() : new Date(a));
            return ad.getFullYear() === b.getFullYear() && ad.getMonth() === b.getMonth() && ad.getDate() === b.getDate();
          };

          // If payload provides explicit batches, merge them into existing batches (batches are for expirations)
          if (Array.isArray(payload.batches) && payload.batches.length > 0) {
            payload.batches.forEach((pb: any) => {
              const pExp = pb.expirationDate instanceof Date ? pb.expirationDate : (pb.expirationDate ? new Date(pb.expirationDate) : null);
              let merged = false;
              for (let i = 0; i < existingBatches.length; i++) {
                const eb = existingBatches[i];
                const ebExp = eb.expirationDate ? (eb.expirationDate instanceof Date ? eb.expirationDate : (eb.expirationDate?.toDate ? eb.expirationDate.toDate() : new Date(eb.expirationDate))) : null;
                const sameLot = (eb.lotNumber || '') && (pb.lotNumber || '') ? (String(eb.lotNumber) === String(pb.lotNumber)) : true;
                if ((pExp && ebExp && sameDay(ebExp, pExp)) || (!pExp && !ebExp && sameLot)) {
                  existingBatches[i].stock = Number(existingBatches[i].stock ?? 0) + Number(pb.stock ?? 0);
                  // merge locations if present
                  if (Array.isArray(pb.locations) && pb.locations.length > 0) {
                    existingBatches[i].locations = existingBatches[i].locations || [];
                    pb.locations.forEach((loc: any) => {
                      const locKey = (loc.name ?? '').toString();
                      const found = existingBatches[i].locations.find((l: any) => (l.name || '').toString() === locKey);
                      if (found) found.quantity = Number(found.quantity ?? 0) + Number(loc.quantity ?? 0);
                      else existingBatches[i].locations.push({ id: uniqueId(), name: loc.name ?? '', quantity: Number(loc.quantity ?? 0) });
                    });
                  }
                  merged = true;
                  break;
                }
              }
              if (!merged) {
                existingBatches.push({ id: pb.id ?? uniqueId(), lotNumber: pb.lotNumber ?? '', expirationDate: pExp ?? null, stock: Number(pb.stock ?? 0), receivedAt: pb.receivedAt ?? undefined, notes: pb.notes ?? '', locations: Array.isArray(pb.locations) ? pb.locations.map((l: any) => ({ id: l.id ?? uniqueId(), name: l.name ?? '', quantity: Number(l.quantity ?? 0) })) : [] });
              }
            });

            const totalStock = existingBatches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0) + existingVariants.reduce((acc, v) => acc + Number(v.stock ?? 0), 0);
            await updateDoc(itemRef, { batches: existingBatches, totalStockQuantity: totalStock, updatedAt: serverTimestamp() });
            return;
          }

          // If payload provides variants (sizing/options), merge by id or name — DO NOT merge by expiration
          if (Array.isArray(payload.variants) && payload.variants.length > 0) {
            payload.variants.forEach((v: any) => {
              const nameKey = (v.name || '').toString().trim().toLowerCase();
              let merged = false;
              for (let i = 0; i < existingVariants.length; i++) {
                const ev = existingVariants[i];
                const evName = (ev.name || '').toString().trim().toLowerCase();
                if ((v.id && ev.id === v.id) || (nameKey && evName === nameKey)) {
                  existingVariants[i].stock = Number(existingVariants[i].stock ?? 0) + Number(v.stock ?? 0);
                  existingVariants[i].quantityPerUnit = v.quantityPerUnit ?? existingVariants[i].quantityPerUnit ?? data.quantityPerUnit ?? 1;
                  existingVariants[i].reorderThreshold = v.reorderThreshold ?? existingVariants[i].reorderThreshold ?? data.reorderThreshold ?? 0;
                  merged = true;
                  break;
                }
              }
              if (!merged) {
                // If a variant carries expiration info, convert that to a batch instead (batches track expirations)
                if (v.expirationDate) {
                  const vExp = v.expirationDate instanceof Date ? v.expirationDate : new Date(v.expirationDate);
                  existingBatches.push({ id: uniqueId(), lotNumber: v.lotNumber ?? '', expirationDate: vExp, stock: Number(v.stock ?? 0), receivedAt: undefined, notes: `Variant: ${v.name ?? ''}`, locations: [] });
                } else {
                  existingVariants.push({ id: v.id ?? uniqueId(), name: v.name ?? '', quantityPerUnit: Number(v.quantityPerUnit ?? data.quantityPerUnit ?? 1), stock: Number(v.stock ?? 0), reorderThreshold: Number(v.reorderThreshold ?? data.reorderThreshold ?? 0) });
                }
              }
            });

            const totalStock = existingVariants.reduce((acc, v) => acc + Number(v.stock ?? 0), 0) + existingBatches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
            await updateDoc(itemRef, { variants: existingVariants, batches: existingBatches, totalStockQuantity: totalStock, updatedAt: serverTimestamp() });
            return;
          }

            // No top-level expiration handling here; batch expirations are used exclusively.

          // No variants or expirations: increment master total
          const incTotal = Number(data.totalStockQuantity ?? 0) + Number(payload.totalStockQuantity ?? 0);
          await updateDoc(itemRef, { totalStockQuantity: incTotal, updatedAt: serverTimestamp() });
        } catch (err) {
          console.error('Merge add failed, creating new item', err);
          await addDoc(collection(db, 'inventory'), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        }
      } else {
        await addDoc(collection(db, 'inventory'), {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      console.error("Error adding item: ", error);
      alert("Failed to add item.");
    }
  };

  

  const handleUpdateItem = async (id: string, updatedData: Partial<InventoryItem>) => {
    try {
      const itemRef = doc(db, 'inventory', id);
      const payload = preparePayload(updatedData);
      await updateDoc(itemRef, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error updating item: ", error);
      alert("Failed to update item.");
    }
  };

  // Prepare payload: convert ISO strings to Date for known date fields and normalize numbers
  function preparePayload(data: Partial<InventoryItem> | any) {
    const payload: any = { ...(data || {}) };

    // Note: top-level expirationDate is no longer used — batch expirations are authoritative.
    if (payload.openedAt) {
      if (typeof payload.openedAt === 'string') {
        const d = new Date(payload.openedAt);
        payload.openedAt = isNaN(d.getTime()) ? null : d;
      } else if (!(payload.openedAt instanceof Date)) {
        payload.openedAt = null;
      }
    }

    // Normalize numeric fields
    payload.totalStockQuantity = Number(payload.totalStockQuantity ?? 0);
    payload.reorderThreshold = Number(payload.reorderThreshold ?? 0);
    payload.unopenedQuantity = Number(payload.unopenedQuantity ?? 0);
    payload.openedQuantity = Number(payload.openedQuantity ?? 0);
    payload.quantityPerUnit = Number(payload.quantityPerUnit ?? 1);

    // Variants
    if (Array.isArray(payload.variants)) {
      payload.variants = payload.variants.map((v: any) => {
        const out: any = { ...v };
        if (out.expirationDate) {
          if (typeof out.expirationDate === 'string') {
            const d = new Date(out.expirationDate);
            out.expirationDate = isNaN(d.getTime()) ? null : d;
          } else if (!(out.expirationDate instanceof Date)) {
            out.expirationDate = null;
          }
        }
        out.quantityPerUnit = Number(out.quantityPerUnit ?? 1);
        out.stock = Number(out.stock ?? 0);
        out.reorderThreshold = Number(out.reorderThreshold ?? payload.reorderThreshold ?? 0);
        // remove any undefined fields inside variant
        Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
        return out;
      });
      // Convert any variant entries that include expiration/lot info into batches
      const convertedBatches: any[] = [];
      const keptVariants: any[] = [];
      (payload.variants || []).forEach((v: any) => {
        if (v.expirationDate || v.lotNumber) {
          const b = {
            id: v.id ?? uniqueId(),
            lotNumber: v.lotNumber ?? '',
            expirationDate: v.expirationDate ?? null,
            stock: Number(v.stock ?? 0),
            receivedAt: undefined,
            notes: `Converted from variant ${v.name ?? ''}`,
            locations: []
          };
          convertedBatches.push(b);
        } else {
          keptVariants.push(v);
        }
      });
      payload.variants = keptVariants;
      if (convertedBatches.length > 0) {
        payload.batches = [...(payload.batches || []), ...convertedBatches];
      }
      // Also accept any `batches` nested on variants (created by the UI) and flatten them into top-level batches
      const variantNestedBatches: any[] = [];
      payload.variants = (payload.variants || []).map((vv: any) => {
        if (Array.isArray(vv.batches) && vv.batches.length > 0) {
          vv.batches.forEach((vb: any) => {
            variantNestedBatches.push({ ...vb, notes: vb.notes ?? `Variant: ${vv.name ?? ''}` });
          });
        }
        // remove nested batches from variant to keep storage backward-compatible
        const out = { ...vv };
        delete out.batches;
        return out;
      });
      if (variantNestedBatches.length > 0) {
        payload.batches = [...(payload.batches || []), ...variantNestedBatches];
      }
    }

    // Do not synthesize batches from a top-level expiration; only explicit batches carry expirations.

    // Batches -> normalize and also map into variants for backward compatibility
    // Only normalize batches when they are provided and non-empty. If an empty
    // array is passed it likely means "no change" or an intentional empty,
    // so avoid overwriting a user-specified `totalStockQuantity` with zeros.
    if (Array.isArray(payload.batches) && payload.batches.length > 0) {
      const normBatches = payload.batches.map((b: any) => {
        const out: any = { ...b };
        if (out.expirationDate) {
          if (typeof out.expirationDate === 'string') {
            const d = new Date(out.expirationDate);
            out.expirationDate = isNaN(d.getTime()) ? null : d;
          } else if (!(out.expirationDate instanceof Date)) {
            out.expirationDate = null;
          }
        }
        out.stock = Number(out.stock ?? 0);
        out.receivedAt = out.receivedAt ? (out.receivedAt instanceof Date ? out.receivedAt : new Date(out.receivedAt)) : undefined;
        out.locations = Array.isArray(out.locations) ? out.locations.map((l: any) => ({
          id: l.id ?? uniqueId(),
          name: l.name ?? '',
          quantity: Number(l.quantity ?? 0)
        })) : [];
        return out;
      });
      payload.batches = normBatches;

      // If batches contain expirations or serialized data, treat them as batch-tracked;
      // otherwise aggregate as static splits. Serialized batches must be preserved.
      const hasBatchExpirations = normBatches.some((b: any) => !!b.expirationDate || !!b.lotNumber || !!b.serialized || (Array.isArray(b.serialNumbers) && b.serialNumbers.length > 0));
      if (hasBatchExpirations) {
        // Preserve batch-level tracking and derive total from batches.
        payload.totalStockQuantity = normBatches.reduce((acc: number, b: any) => acc + Number(b.stock ?? 0), 0);
        // Do NOT map batches into `variants` — variants are for sizing/options.
      } else {
        // No expirations found on batches: treat as static aggregated stock
        payload.totalStockQuantity = normBatches.reduce((acc: number, b: any) => acc + Number(b.stock ?? 0), 0);
        // Remove batches so UI and storage treat this as a static-tracked item
        delete payload.batches;
      }
    }

    // Top-level expiration fields are ignored; only batch expirations persist.

    // Remove any undefined fields (including nested) to avoid Firestore errors
    const removeUndefinedDeep = (obj: any) => {
      if (obj === null || obj === undefined) return;
      if (Array.isArray(obj)) {
        for (let i = obj.length - 1; i >= 0; i--) {
          const v = obj[i];
          if (v === undefined) {
            obj.splice(i, 1);
          } else if (typeof v === 'object' && v !== null) {
            removeUndefinedDeep(v);
          }
        }
        return;
      }
      if (typeof obj === 'object') {
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (v === undefined) {
            delete obj[k];
          } else if (typeof v === 'object' && v !== null) {
            removeUndefinedDeep(v);
            // If object became empty, leave as-is (Firestore accepts empty objects)
          }
        });
      }
    };

    removeUndefinedDeep(payload);

    return payload;
  }

  const openAddModal = () => { setSelectedItem(null); onOpen(); };
  const openEditModal = (item: InventoryItem) => { setSelectedItem(item); onOpen(); };

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const isItemExpanded = (id: string) => !!expandedItems[id];

  // Batch modal state
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchModalItem, setBatchModalItem] = useState<InventoryItem | null>(null);

  const openBatchModal = (item: InventoryItem) => { setBatchModalItem(item); setBatchModalOpen(true); };
  const closeBatchModal = () => { setBatchModalOpen(false); setBatchModalItem(null); };
  const toggleBatchModal = (item: InventoryItem) => {
    if (batchModalOpen && batchModalItem?.id === item.id) {
      // collapse
      setBatchModalOpen(false);
      setBatchModalItem(null);
    } else {
      setBatchModalItem(item);
      setBatchModalOpen(true);
    }
  };

  // --- HELPERS ---
  const getCategoryColor = (category: ItemCategory) => {
    switch (category) {
      case 'Meds': return 'danger';    
      case 'Trauma': return 'warning'; 
      case 'Airway': return 'primary'; 
      case 'PPE': return 'success';
      case 'Vitals': return 'secondary';
      default: return 'default';
    }
  };

  const getStockStatusColor = (current: number, threshold: number) => {
    if (current === 0) return 'text-red-600 dark:text-red-400';
    if (current <= threshold) return 'text-orange-500 dark:text-orange-400';
    return 'text-green-600 dark:text-green-400';
  };

  const getStatus = (item: InventoryItem) => {
    const exp = getEffectiveExpiration(item);
    if (exp?.isExpired) return { emoji: '🔴', label: 'Critical/Expired', color: 'danger' };
    const qty = Number(item.totalStockQuantity ?? 0);
    const threshold = Number(item.reorderThreshold ?? 0);
    if (qty <= 0) return { emoji: '🔴', label: 'Out', color: 'danger' };
    if (threshold > 0 && qty <= threshold) return { emoji: '🟡', label: 'Low Stock', color: 'warning' };
    return { emoji: '🟢', label: 'Good', color: 'success' };
  };

  const formatPar = (item: InventoryItem) => {
    const par = Number(item.reorderThreshold ?? 0);
    if (!par || par <= 0) return '—';
    return `${par} ${item.unit ?? 'units'}`;
  };

  const expColorClass = (date?: Date | null) => {
    if (!date) return 'text-gray-500';
    const d = new Date(date);
    const diff = Math.ceil((d.getTime() - Date.now()) / (1000*60*60*24));
    if (diff < 0) return 'text-red-600';
    if (diff < 30) return 'text-orange-500';
    return 'text-green-600';
  };

  const getEffectiveExpiration = (item: InventoryItem) => {
    // Determine nearest batch expiration (if any). Top-level expiration is ignored.
    if (!item.batches || item.batches.length === 0) return null;
    const dates = (item.batches || [])
      .map((b: any) => b.expirationDate ? new Date(b.expirationDate) : null)
      .filter(Boolean) as Date[];
    if (dates.length === 0) return null;
    let targetDate = dates.reduce((a, b) => a < b ? a : b);

    const now = new Date();
    const diffTime = targetDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { label: 'EXPIRED', color: 'danger' as const, isExpired: true };
    if (diffDays < 30) return { label: `Exp in ${diffDays}d`, color: 'warning' as const, isExpired: false };
    return { label: `Exp: ${targetDate.toLocaleDateString()}`, color: 'default' as const, isExpired: false };
  };

  // --- CSV Export / Import ---
  const exportInventoryCSV = () => {
    // Columns: itemId,itemName,batchId,lotNumber,expirationDate,batchStock,locationName,locationQuantity,notes,receivedAt
    const rows: string[] = [];
    rows.push(['itemId','itemName','batchId','lotNumber','expirationDate','batchStock','room','area','shelf','locationQuantity','notes','receivedAt'].join(','));
    inventory.forEach(item => {
      if (item.batches && item.batches.length > 0) {
        item.batches.forEach((b: any) => {
            if (b.locations && b.locations.length > 0) {
            b.locations.forEach((loc: any) => {
              const room = item.location || '';
              const area = item.room || '';
              // Prefer a more specific location label for shelf if it's distinct
              const shelf = (loc.name && loc.name !== room && loc.name !== area) ? loc.name : (item.shelf || '');
              rows.push([
                item.id,
                `"${(item.name || '').replace(/"/g,'""')}"`,
                b.id,
                `"${String(b.lotNumber || '').replace(/"/g,'""')}"`,
                b.expirationDate ? new Date(b.expirationDate).toISOString().split('T')[0] : '',
                b.stock ?? 0,
                `"${String(room).replace(/"/g,'""')}"`,
                `"${String(area).replace(/"/g,'""')}"`,
                `"${String(shelf).replace(/"/g,'""')}"`,
                loc.quantity ?? 0,
                `"${String(b.notes || '').replace(/"/g,'""')}"`,
                b.receivedAt ? new Date(b.receivedAt).toISOString().split('T')[0] : ''
              ].join(','));
            });
          } else {
            rows.push([
              item.id,
              `"${(item.name || '').replace(/"/g,'""')}"`,
              b.id,
              `"${String(b.lotNumber || '').replace(/"/g,'""')}"`,
              b.expirationDate ? new Date(b.expirationDate).toISOString().split('T')[0] : '',
              b.stock ?? 0,
              `"${String(item.location || '').replace(/"/g,'""')}"`,
              `"${String(item.room || '').replace(/"/g,'""')}"`,
              `"${String(item.shelf || '').replace(/"/g,'""')}"`,
              '',
              `"${String(b.notes || '').replace(/"/g,'""')}"`,
              b.receivedAt ? new Date(b.receivedAt).toISOString().split('T')[0] : ''
            ].join(','));
          }
        });
      } else {
        rows.push([item.id, `"${(item.name||'').replace(/"/g,'""')}"`, '', '', '', item.totalStockQuantity ?? 0, `"${String(item.location || '').replace(/"/g,'""')}"`, `"${String(item.room || '').replace(/"/g,'""')}"`, `"${String(item.shelf || '').replace(/"/g,'""')}"`, '', '', ''].join(','));
      }
    });

    // Use CRLF line endings and include a UTF-8 BOM so Google Sheets/Excel detect UTF-8 correctly
    const csv = rows.join('\r\n');
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory_export_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const parseCSV = (text: string) => {
    // small CSV parser supporting quoted fields and tolerant header normalization
    // Normalize to CRLF-or-LF splitting and remove any UTF-8 BOM from the first header
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const rawHeaders = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    // strip BOM from first header if present and lower-case headers for tolerant matching
    const headers = rawHeaders.map((h, idx) => (idx === 0 ? h.replace(/^\uFEFF/, '') : h).toLowerCase());
    const rows: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      const obj: any = {};
      headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
      rows.push(obj);
    }
    return rows;
  };

  const parseFlexibleDate = (s?: string) => {
    if (!s) return undefined;
    const trimmed = (s || '').toString().trim();
    if (!trimmed) return undefined;
    // Accept ISO-like YYYY-MM-DD
    const iso = new Date(trimmed);
    if (!isNaN(iso.getTime())) return iso;
    // Accept common US format MM/DD/YYYY or M/D/YY
    const m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      let year = Number(m[3]);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      const mo = Number(m[1]) - 1;
      const day = Number(m[2]);
      const d = new Date(year, mo, day);
      if (!isNaN(d.getTime())) return d;
    }
    return undefined;
  };

  const handleCSVImport = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    const rows = parseCSV(text);
    // Expected (normalized lowercase) headers include: room, area, shelf (or locationname)
    for (const r of rows) {
      try {
        const itemName = ((r.itemname || r.name || r.item_name) || '').toString().trim();
        const itemId = (r.itemid || r.id || '').toString().trim() || undefined;
        const lot = ((r.lotnumber || r.batchid || r.lot || r.batch_id) || '').toString().trim();
        const exp = parseFlexibleDate(r.expirationdate || r.expiry || r.expiration || r.exp_date);
        const batchStock = Number(r.batchstock ?? r.batchqty ?? r.batch_quantity ?? r.qty ?? 0) || 0;
        // Combine room/area/shelf into a single location label for internal storage
        const roomField = (r.room || r.location || r.locationname || '').toString().trim();
        const areaField = (r.area || r.subroom || r.zone || '').toString().trim();
        const shelfField = (r.shelf || r.box || r.slot || '').toString().trim();
        const locParts = [roomField, areaField, shelfField].filter(p => p && p.length > 0);
        const locName = locParts.length > 0 ? locParts.join(' / ') : undefined;
        const locQty = Number(r.locationquantity ?? r.location_qty ?? r.qty ?? 0) || 0;
        const notes = (r.notes || r.note || '').toString();
        const receivedAt = parseFlexibleDate(r.receivedat || r.received_at || r.received);

        // Build payload: name + batches
        const payload: any = {
          name: itemName || undefined,
          id: itemId || undefined,
          batches: [{ id: r.batchid || r.batch_id || uniqueId(), lotNumber: lot || undefined, expirationDate: exp, stock: batchStock || locQty || 0, notes, receivedAt, locations: locName ? [{ id: uniqueId(), name: locName, quantity: locQty || batchStock || 0 }] : [] }]
        };

        await handleAddItem(payload);
      } catch (err) {
        console.error('CSV row import failed', err, r);
      }
    }
    alert('CSV import completed (rows processed).');
  };

  // --- ADVANCED FILTERING LOGIC ---
  const filteredInventory = inventory.filter(item => {
     // 1. Text Search (Checks Name, Location, Shelf, Room, Description)
     const query = searchQuery.toLowerCase().trim();
     const matchesSearch = !query || 
        item.name.toLowerCase().includes(query) ||
        item.location.toLowerCase().includes(query) ||
        (item.shelf && item.shelf.toLowerCase().includes(query)) ||
        (item.room && item.room.toLowerCase().includes(query)) ||
        (item.description && item.description.toLowerCase().includes(query));

     // 2. Category Filter
     const matchesCategory = filterCategory === 'all' || item.category === filterCategory;

     // 3. Location Filter (match item location or any batch location label)
    const matchesLocation = filterLocation === 'all' || item.location === filterLocation ||
      (item.batches || []).some((b: any) => (b.locations || []).some((loc: any) => ((loc.name || '')).toLowerCase().includes(filterLocation.toLowerCase())));

     return matchesSearch && matchesCategory && matchesLocation;
  });

  const lowStockItems = filteredInventory.filter(i => {
    // Only Back Room counts are considered for reorder alerts (Back Room = true inventory).
    // If batches exist, sum only quantities in batch.locations where location === 'Back Room'.
    let backRoomCount = 0;
    if (i.batches && i.batches.length > 0) {
      // Batches are treated as central storage records: sum their `stock` fields.
      backRoomCount = i.batches.reduce((acc: number, b: any) => acc + Number(b.stock ?? 0), 0);
    } else {
      // No batches: only treat master item as Back Room if its room is Back Room
      backRoomCount = (i.location === 'HQ' && i.room === 'Back Room') ? Number(i.totalStockQuantity ?? 0) : 0;
    }

    if (backRoomCount === 0) return false;

    const threshold = Number(i.reorderThreshold ?? 0);
    if (threshold <= 0) return false;

    if (i.hasVariants && i.variants && i.variants.length > 0) {
      // For variants, consider variant-level batches when present; otherwise use variant.stock.
      return i.variants.some(v => {
        const variantBackRoom = (v as any).batches && (v as any).batches.length > 0 ? (v as any).batches.reduce((a: number, bb: any) => a + Number(bb.stock ?? 0), 0) : Number(v.stock ?? 0);
        const vThreshold = Number(v.reorderThreshold ?? threshold);
        return variantBackRoom <= vThreshold;
      });
    }

    return backRoomCount <= threshold;
  });

  // --- QUICK ADJUST HELPERS ---
  const adjustVariantStock = async (item: InventoryItem, variantId: string, delta: number) => {
    try {
      const itemRef = doc(db, 'inventory', item.id);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) return;
      const data = snap.data() as any;
      const variants = (data.variants || []).map((v: any) => {
        if (v.id === variantId) {
          return { ...v, stock: Math.max(0, Number(v.stock ?? 0) + delta) };
        }
        return v;
      });
      const totalStock = variants.reduce((acc: number, v: any) => acc + Number(v.stock ?? 0), 0);
      await updateDoc(itemRef, { variants, totalStockQuantity: totalStock, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Variant update failed', err);
      alert('Failed to update variant stock');
    }
  };

  const adjustNonVariantStock = async (item: InventoryItem, delta: number) => {
    try {
      const itemRef = doc(db, 'inventory', item.id);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) return;
      const data = snap.data() as any;

      if (data.tracksOpenStock) {
        let unopened = Number(data.unopenedQuantity ?? 0);
        let opened = Number(data.openedQuantity ?? 0);
        const qtyPer = Number(data.quantityPerUnit ?? 1);

        if (delta < 0) {
          let toConsume = Math.abs(Math.floor(delta));
          const usedFromOpen = Math.min(opened, toConsume);
          opened -= usedFromOpen;
          toConsume -= usedFromOpen;

          while (toConsume > 0 && unopened > 0) {
            unopened -= 1;
            const take = Math.min(qtyPer, toConsume);
            // open a box and take 'take' items from it; leftover stays in opened
            opened += (qtyPer - take);
            toConsume -= take;
          }
        } else {
          // increment open items
          opened += Math.floor(delta);
        }

        const totalUnits = Number(unopened) + (opened > 0 ? 1 : 0);
        await updateDoc(itemRef, { unopenedQuantity: unopened, openedQuantity: opened, totalStockQuantity: totalUnits, updatedAt: serverTimestamp() });
      } else {
        const total = Math.max(0, Number(data.totalStockQuantity ?? 0) + delta);
        await updateDoc(itemRef, { totalStockQuantity: total, updatedAt: serverTimestamp() });
      }
    } catch (err) {
      console.error('Non-variant update failed', err);
      alert('Failed to update stock');
    }
  };

  // --- Restock Forward Staging ---
  const handleRestockForward = async (item: InventoryItem) => {
    if (!item) return;
    if (item.location !== 'HQ' || item.room !== 'Back Room') {
      alert('Restock Forward Staging should be used from items stored in the Back Room.');
      return;
    }

    // FIFO Smart Pick: Guide user to oldest valid batch
    let pickInstructions = '';
    if (item.batches && item.batches.length > 0) {
      const oldestBatch = getOldestValidBatch(item.batches, item);
      if (oldestBatch) {
        pickInstructions = getSmartPickInstructions(oldestBatch, item);
      } else {
        alert('⚠️ All batches are expired or out of stock. Cannot restock.');
        return;
      }
    }

    const promptMsg = pickInstructions
      ? `${pickInstructions}\n\nQuantity to move to Forward Staging (this will expense from Back Room):`
      : 'Quantity to move to Forward Staging (this will expense from Back Room):';

    // If any serialized units exist, require unit-level selection
    try {
      const itemRef = doc(db, 'inventory', item.id);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) return;
      const data = snap.data() as any;

      const batches: any[] = Array.isArray(data.batches) ? data.batches : [];
      const serializedUnits: { batchId: string; lotNumber?: string; serial: string }[] = [];
      for (const b of batches) {
        if (b && b.serialized && Array.isArray(b.serialNumbers)) {
          for (const s of b.serialNumbers) {
            serializedUnits.push({ batchId: b.id, lotNumber: b.lotNumber, serial: s });
          }
        }
      }

      if (serializedUnits.length > 0) {
        // Present indexed list of available serialized units and ask user to choose which to move
        const lines = serializedUnits.map((u, i) => `${i + 1}: ${u.batchId}${u.lotNumber ? ' (' + u.lotNumber + ')' : ''} - ${u.serial}`);
        const choice = prompt(`Select units to move by comma-separated index (e.g. 1,3):\n\n${lines.join('\n')}`);
        if (!choice) return;
        const idxs = choice.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < serializedUnits.length);
        if (idxs.length === 0) return;

        // For each selected unit, remove serial from its batch and decrement counts
        const batchMap: Record<string, { removeSerials: string[] }> = {};
        for (const i of idxs) {
          const u = serializedUnits[i];
          batchMap[u.batchId] = batchMap[u.batchId] || { removeSerials: [] };
          batchMap[u.batchId].removeSerials.push(u.serial);
        }

        // Apply updates locally and persist
        for (const b of batches) {
          const plan = batchMap[b.id];
          if (!plan) continue;
          const beforeSerials = Array.isArray(b.serialNumbers) ? b.serialNumbers.slice() : [];
          const nextSerials = beforeSerials.filter((s: string) => !plan.removeSerials.includes(s));
          b.serialNumbers = nextSerials;
          b.stock = nextSerials.length;
        }

        // Update totalStockQuantity by subtracting moved units
        const movedCount = idxs.length;
        const current = Number(data.totalStockQuantity ?? 0);
        const newTotal = Math.max(0, current - movedCount);
        await updateDoc(itemRef, { batches, totalStockQuantity: newTotal, updatedAt: serverTimestamp() });

        // Log the forward restock action with serials
        await addDoc(collection(db, 'inventory_logs'), {
          itemId: item.id,
          itemName: item.name,
          action: 'restock_forward',
          quantity: movedCount,
          serials: idxs.map(i => serializedUnits[i].serial),
          batchIds: Array.from(new Set(idxs.map(i => serializedUnits[i].batchId))),
          userId: user?.uid ?? null,
          userName: (user as any)?.email ?? null,
          timestamp: serverTimestamp(),
          notes: `Restocked Forward Staging (unit-level)`
        });
        return;
      }

      // Fallback: no serialized units, numeric-quantity flow
      const qtyStr2 = prompt(promptMsg, '1');
      if (!qtyStr2) return;
      const qty = Math.max(0, Math.floor(Number(qtyStr2) || 0));
      if (qty <= 0) return;

      const currentTotal = Number(data.totalStockQuantity ?? 0);
      const newTotal2 = Math.max(0, currentTotal - qty);
      await updateDoc(itemRef, { totalStockQuantity: newTotal2, updatedAt: serverTimestamp() });

      // Log the forward restock action for traceability
      await addDoc(collection(db, 'inventory_logs'), {
        itemId: item.id,
        itemName: item.name,
        action: 'restock_forward',
        quantity: qty,
        userId: user?.uid ?? null,
        userName: (user as any)?.email ?? null,
        timestamp: serverTimestamp(),
        notes: `Restocked Forward Staging from Back Room to Forward Staging`
      });
    } catch (err) {
      console.error('Restock forward failed', err);
      alert('Failed to restock forward staging');
    }
  };

  // Optimistic UI handlers: update local state immediately, then persist to Firestore
  const handleVariantClick = async (itemId: string, variantId: string, delta: number) => {
    const before = inventory;
    const next = before.map(it => {
      if (it.id !== itemId) return it;
      const variants = (it.variants || []).map(v => ({ ...v, stock: v.id === variantId ? Math.max(0, Number(v.stock ?? 0) + delta) : v.stock }));
      const total = variants.reduce((acc: number, v: any) => acc + Number(v.stock ?? 0), 0);
      return { ...it, variants, totalStockQuantity: total } as InventoryItem;
    });
    setInventory(next);

    try {
      const itemObj = before.find(i => i.id === itemId) ?? ({} as InventoryItem);
      await adjustVariantStock(itemObj, variantId, delta);
    } catch (err) {
      console.error('Persist variant failed, reverting', err);
      setInventory(before);
      alert('Failed to update variant stock');
    }
  };

  const handleNonVariantClick = async (itemId: string, delta: number) => {
    const before = inventory;
    const itemObj = before.find(i => i.id === itemId);
    if (!itemObj) return;

    // Quick path: if the inventory has serialized batches, handle unit-level updates
    try {
      const itemRef = doc(db, 'inventory', itemId);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) return;
      const data = snap.data() as any;

      const batches: any[] = Array.isArray(data.batches) ? data.batches.slice() : [];
      const serializedBatches = batches.filter((b: any) => !!b.serialized && Array.isArray(b.serialNumbers));

      if (serializedBatches.length > 0) {
        // For serialized assets, we need explicit serials to add/remove.
        if (delta < 0) {
          // Remove last N serials (LIFO across batches) and persist
          let toRemove = Math.abs(delta);
          const removedSerials: string[] = [];
          // operate on batches in reverse so newer serials are removed first
          for (let bi = batches.length - 1; bi >= 0 && toRemove > 0; bi--) {
            const b = batches[bi];
            if (!Array.isArray(b.serialNumbers) || b.serialNumbers.length === 0) continue;
            while (b.serialNumbers.length > 0 && toRemove > 0) {
              const s = b.serialNumbers.pop();
              if (s) removedSerials.push(s);
              toRemove -= 1;
            }
            b.stock = b.serialNumbers.length;
          }

          const total = Math.max(0, (Number(data.totalStockQuantity ?? 0) - removedSerials.length));

          // Optimistic UI
          const next = before.map(it => it.id === itemId ? ({ ...it, batches: batches.map((bb:any) => ({ ...bb })), totalStockQuantity: total }) : it);
          setInventory(next);

          // Persist
          await updateDoc(itemRef, { batches, totalStockQuantity: total, updatedAt: serverTimestamp() });

          // Log removal
          await addDoc(collection(db, 'inventory_logs'), {
            itemId,
            itemName: data.name ?? itemObj.name,
            action: 'remove_serials',
            quantity: removedSerials.length,
            serials: removedSerials,
            userId: user?.uid ?? null,
            userName: (user as any)?.email ?? null,
            timestamp: serverTimestamp(),
            notes: 'Quick remove via asset buttons'
          });
          return;
        } else if (delta > 0) {
          // For increments, prompt user to enter serial(s) (comma-separated) to add
          const input = prompt('Enter new serial numbers to add (comma-separated):', '');
          if (!input) return;
          const newSerials = input.split(',').map(s => s.trim()).filter(Boolean);
          if (newSerials.length === 0) return;

          // Append new serials to the first serialized batch (or create one)
          let targetBatch = batches.find((b: any) => !!b.serialized);
          if (!targetBatch) {
            targetBatch = { id: uniqueId(), lotNumber: '', expirationDate: null, stock: 0, receivedAt: undefined, notes: '', locations: [], serialized: true, serialNumbers: [] };
            batches.push(targetBatch);
          }
          targetBatch.serialNumbers = Array.isArray(targetBatch.serialNumbers) ? targetBatch.serialNumbers.concat(newSerials) : newSerials.slice();
          targetBatch.stock = targetBatch.serialNumbers.length;

          const total = Number(data.totalStockQuantity ?? 0) + newSerials.length;

          const next = before.map(it => it.id === itemId ? ({ ...it, batches: batches.map((bb:any) => ({ ...bb })), totalStockQuantity: total }) : it);
          setInventory(next);

          await updateDoc(itemRef, { batches, totalStockQuantity: total, updatedAt: serverTimestamp() });

          await addDoc(collection(db, 'inventory_logs'), {
            itemId,
            itemName: data.name ?? itemObj.name,
            action: 'add_serials',
            quantity: newSerials.length,
            serials: newSerials,
            userId: user?.uid ?? null,
            userName: (user as any)?.email ?? null,
            timestamp: serverTimestamp(),
            notes: 'Quick add via asset buttons'
          });
          return;
        }
      }

      // Fallback to existing non-serialized behavior
      const next = before.map(it => {
        if (it.id !== itemId) return it;
        const total = Math.max(0, Number(it.totalStockQuantity ?? 0) + delta);
        return { ...it, totalStockQuantity: total } as InventoryItem;
      });
      setInventory(next);

      await adjustNonVariantStock(itemObj, delta);
    } catch (err) {
      console.error('Persist non-variant failed, reverting', err);
      setInventory(before);
      alert('Failed to update stock');
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto">
        
        {/* Header Title */}
        <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Boxes className="text-indigo-600" size={28} />
              Master Inventory
            </h1>
            <p className="text-gray-600 dark:text-gray-400">Manage the supply closet</p>
        </div>

        {/* Search & Actions Bar */}
        <div className="flex flex-col md:flex-row gap-3 mb-4 items-stretch md:items-center">
            <div className="flex-1 relative">
                <Input
                    placeholder="Search by name, location, shelf..."
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    startContent={<Search size={18} className="text-gray-400" />}
                    endContent={
                        searchQuery && (
                            <button onClick={() => setSearchQuery('')} className="text-gray-400 hover:text-gray-600">
                                <X size={16} />
                            </button>
                        )
                    }
                    classNames={{
                        inputWrapper: "bg-white dark:bg-slate-800 shadow-sm hover:shadow-md transition-shadow h-12"
                    }}
                />
            </div>
            
            <Button 
                isIconOnly={false} 
                variant={showFilters ? "solid" : "bordered"} 
                color={showFilters ? "primary" : "default"}
                onPress={() => setShowFilters(!showFilters)}
                className="h-12 px-4 bg-white dark:bg-slate-800 border-default-200"
                startContent={<Filter size={18} />}
            >
                Filters
            </Button>

            <Button 
              onPress={openAddModal} 
              color="primary" 
              className="h-12 px-6 font-semibold shadow-md bg-indigo-600"
              startContent={<Plus size={20} />}
            >
              Add Item
            </Button>
            <Button
              onPress={() => router.push('/mobile/quick-count')}
              variant="bordered"
              className="h-12 px-4"
            >
              Quick Count (mobile)
            </Button>
            <Button 
              onPress={() => exportInventoryCSV()} 
              variant="flat"
              className="h-12 px-4"
            >
              Export CSV
            </Button>
            <label className="h-12 flex items-center px-4 bg-white dark:bg-slate-800 border-default-200 rounded-md cursor-pointer">
              <input id="csv-import" type="file" accept="text/csv" onChange={(e) => handleCSVImport(e.target.files?.[0])} style={{display: 'none'}} />
              <span className="text-sm">Import CSV</span>
            </label>
        </div>

        {/* Expandable Filter Panel */}
        {showFilters && (
            <div className="mb-6 p-4 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700 grid grid-cols-1 md:grid-cols-3 gap-4 animate-appearance-in">
                <Select 
                    label="Category" 
                    size="sm"
                    selectedKeys={[filterCategory]} 
                    onChange={(e) => setFilterCategory(e.target.value)}
                >
                    <SelectItem key="all">All Categories</SelectItem>
                    {(CATEGORIES.map(c => <SelectItem key={c}>{c}</SelectItem>) as unknown) as any}
                </Select>

                <Select 
                    label="Location" 
                    size="sm"
                    selectedKeys={[filterLocation]} 
                    onChange={(e) => setFilterLocation(e.target.value)}
                >
                    <SelectItem key="all">All Locations</SelectItem>
                    {(LOCATIONS.map(l => <SelectItem key={l}>{l}</SelectItem>) as unknown) as any}
                </Select>
                
                <div className="flex items-end">
                    <Button size="sm" color="danger" variant="flat" onPress={() => {setFilterCategory('all'); setFilterLocation('all'); setSearchQuery('');}}>
                        Clear All
                    </Button>
                </div>
            </div>
        )}

        {/* Content */}
        <div className="grid grid-cols-1 gap-4">
            {filteredInventory.length === 0 && (
                <div className="text-center py-10 text-gray-500">
                    <p>No items found matching your search.</p>
                </div>
            )}
            
            {filteredInventory.map((item) => {
                const expStatus = getEffectiveExpiration(item);
                const isExpired = expStatus?.isExpired;
                const cardClasses = isExpired 
                    ? "border-red-300 bg-red-50/70 dark:bg-red-900/20"
                    : "bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 hover:shadow-md";
                const expanded = isItemExpanded(item.id);

                return (
                  <div
                    key={item.id}
                    className={`relative cursor-pointer` }
                    onClick={() => {
                      toggleBatchModal(item);
                    }}
                  >
                    <Card className={`border rounded-xl transition-all ${cardClasses}`}>
                        <CardBody className="p-4">
                            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                                {/* Left Side: Info */}
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                                        <h3 className="font-bold text-lg text-gray-800 dark:text-white">{item.name}</h3>
                                        <Chip size="sm" color={getCategoryColor(item.category)} variant="flat">{item.category}</Chip>
                                        {item.isAsset && item.assetCategory === 'AED' && (
                                          <Chip size="sm" color="danger" variant="flat">AED{item.assetModel ? ` • ${item.assetModel}` : ''}</Chip>
                                        )}
                                        {expStatus && (
                                            <Chip size="sm" color={expStatus.color} variant="flat" className="font-semibold">{expStatus.label}</Chip>
                                        )}
                                        {item.isOxygen && (
                                            <Chip size="sm" color="primary" variant="dot" startContent={<Wind size={12} />}>Oxygen</Chip>
                                        )}
                                    </div>
                                    <div className="text-xs text-gray-500 mb-1">
                                        {item.batches && item.batches.length > 0 ? (
                                          <span>Batch-tracked locations</span>
                                        ) : (
                                          <span>{item.location} {item.room ? `/ ${item.room}` : ''} {item.shelf ? `- ${item.shelf}` : ''}</span>
                                        )}
                                    </div>
                                    {/** combine feature removed */}
                                    {/* Details button removed; entire card is clickable to toggle batches */}
                                    
                                    {/* Detailed Stock Info for Box Tracking */}
                                    {item.tracksOpenStock && (
                                        <div className="flex items-center gap-2 mt-2 text-sm text-gray-700 dark:text-gray-300">
                                            <PackageOpen size={16} className="text-purple-500" />
                                            <span>
                                                <span className="font-bold">{item.unopenedQuantity}</span> Sealed
                                            </span>
                                            <span className="text-gray-300">|</span>
                                            <span>
                                                <span className="font-bold">{item.openedQuantity}</span> / {item.quantityPerUnit} in Open Box
                                            </span>
                                        </div>
                                    )}
                                    {expanded && (
                                      <div className="mt-3">
                                        {Array.isArray(item.assets) && item.assets.length > 0 && !(item.batches && item.batches.length > 0) ? (
                                          <>
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Units / Assets</div>
                                            <div className="w-full overflow-x-auto">
                                              <div className="grid grid-cols-6 gap-2 text-xs text-gray-500 font-semibold border-b pb-2">
                                                <div>Asset Tag</div>
                                                <div>Serial</div>
                                                <div>Pad Exp</div>
                                                <div>Battery Exp</div>
                                                <div>Last Checked</div>
                                                <div>Location</div>
                                              </div>
                                              <div className="divide-y">
                                                {item.assets.map((a: any) => (
                                                  <div key={a.id ?? a.serial} className="grid grid-cols-6 gap-2 items-center py-2 text-sm text-gray-700">
                                                    <div className="truncate">{a.assetTag ?? a.id ?? '—'}</div>
                                                    <div className="truncate">{a.serial ?? '—'}</div>
                                                    <div className={`${expColorClass(a.padExpiration)} text-sm`}>{a.padExpiration ? new Date(a.padExpiration).toLocaleDateString() : '—'}</div>
                                                    <div className={`${expColorClass(a.batteryExpiration)} text-sm`}>{a.batteryExpiration ? new Date(a.batteryExpiration).toLocaleDateString() : '—'}</div>
                                                    <div className="truncate">{a.lastChecked ? new Date(a.lastChecked).toLocaleDateString() : '—'}</div>
                                                    <div className="truncate">{a.currentLocation ?? a.assignedToId ?? item.location ?? '—'}</div>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          </>
                                        ) : (
                                          <>
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Batches / Locations</div>
                                            <div className="w-full overflow-x-auto">
                                              <div className="grid grid-cols-4 gap-2 text-xs text-gray-500 font-semibold border-b pb-2">
                                                <div>Location</div>
                                                <div>Expiration</div>
                                                <div className="text-right">Quantity</div>
                                                <div>Lot #</div>
                                              </div>
                                              <div className="divide-y">
                                                {item.batches && item.batches.length > 0 ? (
                                                  item.batches.map((b: any) => (
                                                    (b.locations && b.locations.length > 0) ? (
                                                      b.locations.map((loc: any) => (
                                                        <div key={loc.id} className="grid grid-cols-4 gap-2 items-center py-2 text-sm text-gray-700">
                                                          <div className="truncate">{loc.name || item.location || 'Location'}</div>
                                                          <div className={`${expColorClass(b.expirationDate)} text-sm`}>{b.expirationDate ? new Date(b.expirationDate).toLocaleDateString() : '—'}</div>
                                                          <div className="text-right font-semibold">{loc.quantity}</div>
                                                          <div className="truncate">{b.lotNumber || '—'}</div>
                                                        </div>
                                                      ))
                                                    ) : (
                                                      <div key={b.id} className="grid grid-cols-4 gap-2 items-center py-2 text-sm text-gray-700">
                                                        <div className="truncate">{item.location || 'Location'}</div>
                                                        <div className={`${expColorClass(b.expirationDate)} text-sm`}>{b.expirationDate ? new Date(b.expirationDate).toLocaleDateString() : '—'}</div>
                                                        <div className="text-right font-semibold">{b.stock}</div>
                                                        <div className="truncate">{b.lotNumber || '—'}</div>
                                                      </div>
                                                    )
                                                  ))
                                                ) : (
                                                  <div className="py-2 text-sm text-gray-600">No batches / locations for this item.</div>
                                                )}
                                              </div>
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    )}
                                </div>

                                {/* Right Side: Stock & Gauges (compact when collapsed) */}
                                {expanded ? (
                                  <div className="flex flex-col items-end min-w-[120px]">
                                      <div className="flex items-center gap-2 mb-2">
                                          <div className="text-xs text-gray-400 mr-2">Par: {formatPar(item)}</div>
                                          <div className="text-xs"><span className="ml-1 text-sm font-medium">{getStatus(item).label}</span></div>
                                          <div className="flex items-center gap-2">
                                            <Button isIconOnly size="sm" variant="light" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); openEditModal(item); }} className="ml-2"><Edit2 size={14} /></Button>
                                            {item.location === 'HQ' && item.room === 'Back Room' && !item.isAsset && (
                                              <Button size="sm" variant="flat" color="secondary" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); handleRestockForward(item); }}>Restock Forward</Button>
                                            )}
                                          </div>
                                      </div>
                                        {item.isOxygen ? (
                                          <div className="w-32 text-right">
                                              <p className="text-sm font-bold text-blue-600 mb-1">{item.oxygenPsi} PSI</p>
                                              <Progress 
                                                size="sm" 
                                                value={((item.oxygenPsi ?? 0) / (item.maxOxygenPsi ?? 1)) * 100} 
                                                color={(item.oxygenPsi ?? 0) < 500 ? "danger" : "primary"}
                                                aria-label="Oxygen Level"
                                              />
                                              <p className="text-[10px] text-gray-400 mt-1">Capacity: {item.maxOxygenPsi}</p>
                                          </div>
                                      ) : item.hasVariants && item.variants && item.variants.length > 0 ? (
                                        <div className="w-48 text-right space-y-2">
                                          {item.variants.map((v, vidx) => (
                                            <div key={`${v.id}-${vidx}`} className="flex flex-col items-end">
                                                <div className="flex items-center gap-2 min-w-[140px] justify-center">
                                                  <div
                                                    role="button"
                                                    tabIndex={0}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                    onClick={(e) => { e.stopPropagation(); handleVariantClick(item.id, v.id, -1); }}
                                                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleVariantClick(item.id, v.id, -1); } }}
                                                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                                    aria-label={`Decrease ${v.name}`}
                                                  >
                                                    <Minus size={12} />
                                                  </div>

                                                  <div className="flex flex-col items-center">
                                                    <div className="w-12 flex items-center justify-center">
                                                      <p className={`font-bold text-lg ${getStockStatusColor(v.stock, v.reorderThreshold ?? item.reorderThreshold)}`}>{v.stock}</p>
                                                    </div>
                                                    <p className="text-xs text-gray-500 uppercase mt-1">{v.name}</p>
                                                  </div>

                                                  <div
                                                    role="button"
                                                    tabIndex={0}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                    onClick={(e) => { e.stopPropagation(); handleVariantClick(item.id, v.id, 1); }}
                                                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleVariantClick(item.id, v.id, 1); } }}
                                                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                                    aria-label={`Increase ${v.name}`}
                                                  >
                                                    <Plus size={12} />
                                                  </div>
                                                </div>
                                            </div>
                                          ))}
                                        </div>
                                      ) : item.hasVariants && item.variants && item.variants.length > 0 ? (
                                        <div className="w-48 text-right space-y-2">
                                          {item.variants.map((v, vidx) => (
                                            <div key={`${v.id}-${vidx}`} className="flex flex-col items-end">
                                                <div className="flex items-center gap-2 min-w-[140px] justify-center">
                                                  <div
                                                    role="button"
                                                    tabIndex={0}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                    onClick={(e) => { e.stopPropagation(); handleVariantClick(item.id, v.id, -1); }}
                                                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleVariantClick(item.id, v.id, -1); } }}
                                                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                                    aria-label={`Decrease ${v.name}`}
                                                  >
                                                    <Minus size={12} />
                                                  </div>

                                                  <div className="flex flex-col items-center">
                                                    <div className="w-12 flex items-center justify-center">
                                                      <p className={`font-bold text-lg ${getStockStatusColor(v.stock, v.reorderThreshold ?? item.reorderThreshold)}`}>{v.stock}</p>
                                                    </div>
                                                    <p className="text-xs text-gray-500 uppercase mt-1">{v.name}</p>
                                                  </div>

                                                  <div
                                                    role="button"
                                                    tabIndex={0}
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                    onClick={(e) => { e.stopPropagation(); handleVariantClick(item.id, v.id, 1); }}
                                                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleVariantClick(item.id, v.id, 1); } }}
                                                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                                    aria-label={`Increase ${v.name}`}
                                                  >
                                                    <Plus size={12} />
                                                  </div>
                                                </div>
                                            </div>
                                          ))}
                                        </div>
                                      ) : item.isAsset ? (
                                        <div className="flex flex-col items-end">
                                          <div className="flex items-center gap-3 min-w-[160px] justify-center">
                                            <div
                                              role="button"
                                              tabIndex={0}
                                              onPointerDown={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => e.stopPropagation()}
                                              onTouchStart={(e) => e.stopPropagation()}
                                              onClick={(e) => { e.stopPropagation(); handleNonVariantClick(item.id, -1); }}
                                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNonVariantClick(item.id, -1); } }}
                                              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                              aria-label={`Decrease ${item.name}`}
                                            >
                                              <Minus size={12} />
                                            </div>

                                            <div className="flex flex-col items-center">
                                              <div className="w-40 grid grid-cols-3 gap-2">
                                                {(() => {
                                                  // Prefer explicit per-unit `assets[]` for non-fungible items (AEDs). Fall back to batch.serialNumbers or numeric placeholders.
                                                  const units: { label: string; meta?: string; raw?: any }[] = [];
                                                  if (Array.isArray((item as any).assets) && (item as any).assets.length > 0) {
                                                    (item as any).assets.forEach((a: any) => {
                                                      const label = a.assetTag || a.serial || a.id || '—';
                                                      let meta = a.currentLocation || '';
                                                      if (!meta && a.padExpiration) meta = `Pads: ${new Date(a.padExpiration).toLocaleDateString()}`;
                                                      else if (!meta && a.batteryExpiration) meta = `Battery: ${new Date(a.batteryExpiration).toLocaleDateString()}`;
                                                      units.push({ label, meta, raw: a });
                                                    });
                                                  } else if (item.batches && item.batches.length > 0) {
                                                    item.batches.forEach((b: any) => {
                                                      if (Array.isArray(b.serialNumbers) && b.serialNumbers.length > 0) {
                                                        b.serialNumbers.forEach((s: string) => units.push({ label: s, meta: b.lotNumber }));
                                                      }
                                                    });
                                                  }

                                                  if (units.length === 0) {
                                                    const n = Number(item.totalStockQuantity ?? 0) || 0;
                                                    for (let i = 0; i < n; i++) units.push({ label: String(i + 1) });
                                                  }

                                                  return units.map((u, ui) => (
                                                    <div key={`asset-${item.id}-${ui}`} className={`p-2 rounded-md border ${ (u.raw?.status || item.assetStatus) === 'Ready' ? 'border-green-400 bg-green-50' : (u.raw?.status || item.assetStatus) === 'Not Ready' ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white'} text-xs flex flex-col items-center justify-center`} onClick={(e) => { e.stopPropagation(); openEditModal(item); }}>
                                                      <div className="font-semibold">{u.label}</div>
                                                      <div className="text-[10px] text-gray-500">{u.meta || ''}</div>
                                                    </div>
                                                  ));
                                                })()}
                                              </div>
                                              <p className="text-xs text-gray-500 uppercase mt-2">Assets</p>
                                            </div>

                                            <div
                                              role="button"
                                              tabIndex={0}
                                              onPointerDown={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => e.stopPropagation()}
                                              onTouchStart={(e) => e.stopPropagation()}
                                              onClick={(e) => { e.stopPropagation(); handleNonVariantClick(item.id, 1); }}
                                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNonVariantClick(item.id, 1); } }}
                                              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                              aria-label={`Increase ${item.name}`}
                                            >
                                              <Plus size={12} />
                                            </div>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="flex flex-col items-end">
                                          <div className="flex items-center gap-3 min-w-[160px] justify-center">
                                            <div
                                              role="button"
                                              tabIndex={0}
                                              onPointerDown={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => e.stopPropagation()}
                                              onTouchStart={(e) => e.stopPropagation()}
                                              onClick={(e) => { e.stopPropagation(); handleNonVariantClick(item.id, -1); }}
                                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNonVariantClick(item.id, -1); } }}
                                              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                              aria-label={`Decrease ${item.name}`}
                                            >
                                              <Minus size={12} />
                                            </div>

                                            <div className="flex flex-col items-center">
                                              <div className="w-16 flex items-center justify-center">
                                                <p className={`text-3xl font-bold ${getStockStatusColor(item.totalStockQuantity, item.reorderThreshold)}`}>{item.totalStockQuantity}</p>
                                              </div>
                                              <p className="text-xs text-gray-500 uppercase mt-1">Total Units</p>
                                            </div>

                                            <div
                                              role="button"
                                              tabIndex={0}
                                              onPointerDown={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => e.stopPropagation()}
                                              onTouchStart={(e) => e.stopPropagation()}
                                              onClick={(e) => { e.stopPropagation(); handleNonVariantClick(item.id, 1); }}
                                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNonVariantClick(item.id, 1); } }}
                                              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-white bg-slate-600 hover:bg-slate-700 shadow-sm"
                                              aria-label={`Increase ${item.name}`}
                                            >
                                              <Plus size={12} />
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                  </div>
                                ) : (
                                  <div className="flex flex-col items-end min-w-[120px]">
                                    <div className="flex items-center gap-2 mb-2">
                                      <div className="text-xs text-gray-400">Par: {formatPar(item)}</div>
                                      <div className="text-xs">{getStatus(item).label}</div>
                                      <div className="flex items-center gap-2">
                                        <Button isIconOnly size="sm" variant="light" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); openEditModal(item); }} className="ml-2"><Edit2 size={14} /></Button>
                                        {item.location === 'HQ' && item.room === 'Back Room' && !item.isAsset && (
                                          <Button size="sm" variant="flat" color="secondary" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); handleRestockForward(item); }}>Restock Forward</Button>
                                        )}
                                      </div>
                                    </div>
                                    <div className="w-16 flex items-center justify-center">
                                      <p className={`text-3xl font-bold ${getStockStatusColor(item.totalStockQuantity, item.reorderThreshold)}`}>{item.totalStockQuantity}</p>
                                    </div>
                                    <p className="text-xs text-gray-500 uppercase mt-1">Total Units</p>
                                  </div>
                                )}
                            </div>

                            {/* Standard Stock Progress Bar (if not Oxygen) */}
                            {!item.isOxygen && !item.hasVariants && (
                              <div className="mt-3">
                                <Progress 
                                  size="sm" 
                                  value={item.reorderThreshold > 0 ? (item.totalStockQuantity / (item.reorderThreshold * 2)) * 100 : 100} 
                                  color={item.totalStockQuantity <= item.reorderThreshold ? "warning" : "success"}
                                  aria-label="Stock level"
                                  className="h-1"
                                />
                              </div>
                            )}
                        <div className="flex justify-center mt-3">
                          <Button isIconOnly size="sm" variant="ghost" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); toggleBatchModal(item); }} className={`transform transition-transform duration-200 ${batchModalOpen && batchModalItem?.id === item.id ? 'rotate-180' : 'rotate-0'}`}><ChevronDown size={16} /></Button>
                        </div>
                        </CardBody>
                    </Card>

                    {/* Inline Batch Dropdown (in document flow so it pushes content) */}
                    {batchModalOpen && batchModalItem?.id === item.id && (
                      <div className="mt-3" onClick={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); }}>
                        <Card className="bg-white dark:bg-slate-800 rounded-xl shadow-lg border p-0 transform origin-top animate-appearance-in transition-all duration-200">
                          <CardBody className="p-4">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="font-semibold">Batches — {batchModalItem.name}</h4>
                              <Button size="sm" variant="flat" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); closeBatchModal(); }}>Close</Button>
                            </div>
                            <div className="space-y-3 max-h-64 overflow-y-auto">
                              {batchModalItem.batches && batchModalItem.batches.length > 0 ? (
                                batchModalItem.batches.map((b: any) => (
                                  <Card key={b.id} className="border rounded-md p-0 bg-gray-50 dark:bg-slate-900">
                                    <CardBody className="p-3">
                                      <div className="flex justify-between items-start">
                                        <div>
                                          <div className="font-semibold text-gray-800 dark:text-white">{b.lotNumber || 'Lot: —'}</div>
                                          <div className="text-sm text-gray-500">Expiration: {b.expirationDate ? new Date(b.expirationDate).toLocaleDateString() : '—'}</div>
                                        </div>
                                        <div className="text-right">
                                          <div className="font-bold text-gray-800 dark:text-white">{b.stock ?? 0}</div>
                                          <div className="text-sm text-gray-500">Total</div>
                                        </div>
                                      </div>
                                      {b.locations && b.locations.length > 0 && (
                                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-700">
                                          {b.locations.map((loc: any) => (
                                            <div key={loc.id} className="flex justify-between">
                                              <div className="truncate">{loc.name}</div>
                                              <div className="font-semibold">{loc.quantity}</div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </CardBody>
                                  </Card>
                                ))
                              ) : (
                                // If no batches exist but the inventory item tracks discrete assets,
                                // render those assets in the same card-list style as batches so
                                // the UX is consistent with the batches popup.
                                (batchModalItem.assets && batchModalItem.assets.length > 0) ? (
                                  batchModalItem.assets.map((a: any) => (
                                    <Card key={a.id ?? a.serial ?? (a.assetTag ?? Math.random().toString())} className="border rounded-md p-0 bg-gray-50 dark:bg-slate-900">
                                      <CardBody className="p-3">
                                        <div className="flex justify-between items-start">
                                          <div className="min-w-0">
                                            <div className="font-semibold text-gray-800 dark:text-white">{a.assetTag || a.serial || '—'}</div>
                                            <div className="text-sm text-gray-500">Serial: {a.serial || '—'}</div>
                                            <div className="text-sm text-gray-500">Location: {a.currentLocation || batchModalItem.location || '—'}</div>
                                          </div>
                                          <div className="text-right">
                                            <div className="font-bold text-gray-800 dark:text-white">{a.status || (a.inService === false ? 'Out' : 'In')}</div>
                                            <div className="text-sm text-gray-500">Last Checked: {a.lastChecked ? new Date(a.lastChecked).toLocaleDateString() : '—'}</div>
                                          </div>
                                        </div>
                                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-700">
                                          <div>Pad Exp: {a.padExpiration ? new Date(a.padExpiration).toLocaleDateString() : '—'}</div>
                                          <div>Battery Exp: {a.batteryExpiration ? new Date(a.batteryExpiration).toLocaleDateString() : '—'}</div>
                                          {a.nextExpiration && <div>Next Exp: {new Date(a.nextExpiration).toLocaleDateString()}</div>}
                                          {a.lastCheckNotes && <div className="col-span-2">Notes: {a.lastCheckNotes}</div>}
                                        </div>
                                      </CardBody>
                                    </Card>
                                  ))
                                ) : (
                                  <div className="text-sm text-gray-600">No batches / locations for this item.</div>
                                )
                              )}
                            </div>
                          </CardBody>
                        </Card>
                      </div>
                    )}
                  </div>
                );
            })}
        </div>

        <InventoryModal 
            key={`${selectedItem?.id ?? 'new'}-${isOpen ? 'open' : 'closed'}`}
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            onAddItem={handleAddItem}
            onUpdateItem={handleUpdateItem}
            initialData={selectedItem}
            canToggleExpiration={isAdmin}
        />

        {/* global modal removed; batches are shown inline per-card */}
      </div>
    </div>
  );
}