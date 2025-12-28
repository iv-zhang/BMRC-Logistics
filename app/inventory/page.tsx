'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, Chip, Progress, Button, Spinner, useDisclosure, Input, 
  Select, SelectItem
} from '@heroui/react';
import { Boxes, Plus, Minus, Search, Wind, PackageOpen, Filter, X } from 'lucide-react';

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
          locations: Array.isArray(b.locations) ? b.locations.map((l: any) => ({
            id: l.id ?? crypto.randomUUID?.() ?? Math.random().toString(),
            name: l.name ?? '',
            quantity: Number(l.quantity ?? 0)
          })) : [],
        }));

        // Preserve expirable variants by folding them into batches
        if (variantBatches.length > 0) batches.push(...variantBatches);

        // If any batch has an expirationDate, preserve batch-level tracking.
        // Also preserve batches if the item explicitly tracksExpiration.
        // Otherwise treat batches as static stock and aggregate into master counts.
        const hasBatchExpirations = Boolean(data.tracksExpiration) || batches.some(b => !!b.expirationDate || !!b.lotNumber);
        if (hasBatchExpirations) {
          // Keep batches intact for lot-level UI; do not map batches into `variants`.
          // Variants remain reserved for size/option variations.
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

          expirationDate: getDate(data.expirationDate),
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
                      const found = existingBatches[i].locations.find((l: any) => (l.name || '') === (loc.name || ''));
                      if (found) found.quantity = Number(found.quantity ?? 0) + Number(loc.quantity ?? 0);
                      else existingBatches[i].locations.push({ id: uniqueId(), name: loc.name || '', quantity: Number(loc.quantity ?? 0) });
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

          // If payload has a top-level expirationDate but no explicit batches, treat as a single batch
          if (payload.expirationDate) {
            const pExp = payload.expirationDate instanceof Date ? payload.expirationDate : new Date(payload.expirationDate);
            let merged = false;
            for (let i = 0; i < existingBatches.length; i++) {
              const eb = existingBatches[i];
              const ebExp = eb.expirationDate ? (eb.expirationDate instanceof Date ? eb.expirationDate : (eb.expirationDate?.toDate ? eb.expirationDate.toDate() : new Date(eb.expirationDate))) : null;
              if (ebExp && sameDay(ebExp, pExp)) {
                existingBatches[i].stock = Number(existingBatches[i].stock ?? 0) + Number(payload.totalStockQuantity ?? 0);
                merged = true;
                break;
              }
            }
            if (!merged) {
              existingBatches.push({ id: uniqueId(), lotNumber: payload.lotNumber ?? '', expirationDate: pExp, stock: Number(payload.totalStockQuantity ?? 0), receivedAt: undefined, notes: '' });
            }
            const totalStock = existingBatches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0) + existingVariants.reduce((acc, v) => acc + Number(v.stock ?? 0), 0);
            await updateDoc(itemRef, { batches: existingBatches, totalStockQuantity: totalStock, updatedAt: serverTimestamp() });
            return;
          }

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

    // Normalize top-level dates
    if (payload.expirationDate) {
      if (typeof payload.expirationDate === 'string') {
        const d = new Date(payload.expirationDate);
        payload.expirationDate = isNaN(d.getTime()) ? null : d;
      } else if (!(payload.expirationDate instanceof Date)) {
        payload.expirationDate = null;
      }
    }
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
    }

    // If expiration tracking is enabled but no batches were provided, create a single batch
    // from the top-level expirationDate and totalStockQuantity so items that track
    // expiration always have per-lot entries.
    if (payload.tracksExpiration && (!Array.isArray(payload.batches) || payload.batches.length === 0)) {
      payload.batches = [{
        id: payload.id ?? uniqueId(),
        lotNumber: '',
        expirationDate: payload.expirationDate ?? null,
        stock: Number(payload.totalStockQuantity ?? 0),
        receivedAt: payload.receivedAt ?? undefined
      }];
    }

    // Batches -> normalize and also map into variants for backward compatibility
    if (Array.isArray(payload.batches)) {
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

      // If batches exist, ensure variants contain corresponding entries so UI and merge logic works
      // Decide whether batches represent true expirations or just static splits.
      // If the item explicitly tracks expiration, always preserve batch-level tracking.
      const hasBatchExpirations = Boolean(payload.tracksExpiration) || normBatches.some((b: any) => !!b.expirationDate);
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

    // If this item tracks expiration, prefer per-batch expirations.
    // Remove any top-level expiration to avoid treating it as a standalone expiry.
    if (payload.tracksExpiration) {
      delete payload.expirationDate;
    }

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

  const getEffectiveExpiration = (item: InventoryItem) => {
    if (!item.tracksExpiration) return null;

    let targetDate = item.expirationDate ? new Date(item.expirationDate) : null;
    let labelPrefix = "Exp";

    if (item.hasSecondaryExpiration && item.openedAt && item.secondaryExpirationDays) {
       const openDate = new Date(item.openedAt);
       const secondaryExpiry = new Date(openDate);
       secondaryExpiry.setDate(openDate.getDate() + item.secondaryExpirationDays);

       if (!targetDate || secondaryExpiry < targetDate) {
           targetDate = secondaryExpiry;
           labelPrefix = "Exp (Open)";
       }
    }

    if (!targetDate) return null;

    const now = new Date();
    const diffTime = targetDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { label: 'EXPIRED', color: 'danger' as const, isExpired: true };
    if (diffDays < 30) return { label: `${labelPrefix} in ${diffDays}d`, color: 'warning' as const, isExpired: false };
    return { label: `${labelPrefix}: ${targetDate.toLocaleDateString()}`, color: 'default' as const, isExpired: false };
  };

  // --- CSV Export / Import ---
  const exportInventoryCSV = () => {
    // Columns: itemId,itemName,batchId,lotNumber,expirationDate,batchStock,locationName,locationQuantity,notes,receivedAt
    const rows: string[] = [];
    rows.push(['itemId','itemName','batchId','lotNumber','expirationDate','batchStock','locationName','locationQuantity','notes','receivedAt'].join(','));
    inventory.forEach(item => {
      if (item.batches && item.batches.length > 0) {
        item.batches.forEach((b: any) => {
          if (b.locations && b.locations.length > 0) {
            b.locations.forEach((loc: any) => {
              rows.push([
                item.id,
                `"${(item.name || '').replace(/"/g,'""')}"`,
                b.id,
                `"${String(b.lotNumber || '').replace(/"/g,'""')}"`,
                b.expirationDate ? new Date(b.expirationDate).toISOString().split('T')[0] : '',
                b.stock ?? 0,
                `"${String(loc.name || '').replace(/"/g,'""')}"`,
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
              '',
              '',
              `"${String(b.notes || '').replace(/"/g,'""')}"`,
              b.receivedAt ? new Date(b.receivedAt).toISOString().split('T')[0] : ''
            ].join(','));
          }
        });
      } else {
        rows.push([item.id, `"${(item.name||'').replace(/"/g,'""')}"`, '', '', '', item.totalStockQuantity ?? 0, '', '', '', ''].join(','));
      }
    });

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
    // very small CSV parser supporting quoted fields
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    const rows: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      const obj: any = {};
      headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
      rows.push(obj);
    }
    return rows;
  };

  const handleCSVImport = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    const rows = parseCSV(text);
    // Expected headers: itemId,itemName,batchId,lotNumber,expirationDate,batchStock,locationName,locationQuantity,notes,receivedAt
    for (const r of rows) {
      try {
        const itemName = (r.itemName || r.name || '').trim();
        const itemId = (r.itemId || '').trim();
        const lot = (r.lotNumber || r.batchId || '').trim();
        const exp = r.expirationDate ? new Date(r.expirationDate) : undefined;
        const batchStock = Number(r.batchStock ?? r.batchQty ?? r.batch_quantity ?? 0);
        const locName = (r.locationName || '').trim() || (r.location || '').trim() || undefined;
        const locQty = Number(r.locationQuantity ?? r.qty ?? r.location_qty ?? batchStock ?? 0);
        const notes = r.notes || '';
        const receivedAt = r.receivedAt ? new Date(r.receivedAt) : undefined;

        // Build payload: name + batches
        const payload: any = {
          name: itemName || undefined,
          id: itemId || undefined,
          batches: [{ id: r.batchId || uniqueId(), lotNumber: lot || undefined, expirationDate: exp, stock: batchStock || locQty || 0, notes, receivedAt, locations: locName ? [{ id: uniqueId(), name: locName, quantity: locQty || batchStock || 0 }] : [] }]
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
       (item.batches || []).some((b: any) => (b.locations || []).some((loc: any) => (loc.name || '').toLowerCase().includes(filterLocation.toLowerCase())));

     return matchesSearch && matchesCategory && matchesLocation;
  });

  const lowStockItems = filteredInventory.filter(i => {
    if (i.hasVariants && i.variants && i.variants.length > 0) {
      return i.variants.some(v => v.stock <= (v.reorderThreshold ?? i.reorderThreshold));
    }
    return i.totalStockQuantity <= i.reorderThreshold;
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
    const next = before.map(it => {
      if (it.id !== itemId) return it;
      const total = Math.max(0, Number(it.totalStockQuantity ?? 0) + delta);
      return { ...it, totalStockQuantity: total } as InventoryItem;
    });
    setInventory(next);

    try {
      const itemObj = before.find(i => i.id === itemId) ?? ({} as InventoryItem);
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
              variant="outline"
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
                    {CATEGORIES.map(c => <SelectItem key={c}>{c}</SelectItem>)}
                </Select>

                <Select 
                    label="Location" 
                    size="sm"
                    selectedKeys={[filterLocation]} 
                    onChange={(e) => setFilterLocation(e.target.value)}
                >
                    <SelectItem key="all">All Locations</SelectItem>
                    {LOCATIONS.map(l => <SelectItem key={l}>{l}</SelectItem>)}
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
                  <Card key={item.id} isPressable onPress={() => openEditModal(item)} className={`border rounded-xl transition-all ${cardClasses}`}>
                        <CardBody className="p-4">
                            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                                {/* Left Side: Info */}
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                                        <h3 className="font-bold text-lg text-gray-800 dark:text-white">{item.name}</h3>
                                        <Chip size="sm" color={getCategoryColor(item.category)} variant="flat">{item.category}</Chip>
                                        {expStatus && (
                                            <Chip size="sm" color={expStatus.color} variant="flat" className="font-semibold">{expStatus.label}</Chip>
                                        )}
                                        {item.isOxygen && (
                                            <Chip size="sm" color="primary" variant="dot" startContent={<Wind size={12} />}>Oxygen</Chip>
                                        )}
                                    </div>
                                    <div className="text-xs text-gray-500 mb-1">
                                        {item.location} {item.room ? `/ ${item.room}` : ''} - {item.shelf}
                                    </div>
                                    {/** combine feature removed */}
                                    {/* Details toggle: stops propagation so card press opens edit modal instead */}
                                    <div className="mt-2">
                                      <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); toggleExpand(item.id); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleExpand(item.id); } }}
                                        className="inline-flex items-center px-2 py-1 text-sm rounded-md bg-gray-100 dark:bg-slate-700 text-gray-700 hover:bg-gray-200 cursor-pointer"
                                      >
                                        Details
                                      </div>
                                    </div>
                                    
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
                                    {expanded && item.batches && item.batches.length > 0 && (
                                      <div className="mt-3">
                                        <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Batches / Lots</div>
                                        <div className="flex flex-wrap gap-2">
                                          {item.batches.map((b: any, bidx: number) => (
                                            <div key={`${b.id}-${bidx}`} className="px-3 py-2 border rounded-md bg-white/60 dark:bg-slate-800/60 min-w-[180px]">
                                              <div className="text-xs text-gray-500">{b.lotNumber || 'No lot #'}</div>
                                              <div className="font-bold text-sm">{b.stock} units</div>
                                              <div className="text-xs text-gray-400">{b.expirationDate ? new Date(b.expirationDate).toLocaleDateString() : 'No exp set'}</div>
                                              {b.locations && b.locations.length > 0 && (
                                                <div className="mt-1 space-y-1">
                                                  {b.locations.map((loc: any, lidx: number) => (
                                                    <div key={`${loc.id}-${lidx}`} className="text-[11px] text-gray-500 flex justify-between gap-2">
                                                      <span className="truncate">{loc.name || 'Location'}</span>
                                                      <span className="font-semibold text-gray-700 dark:text-gray-200">{loc.quantity}</span>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                </div>

                                {/* Right Side: Stock & Gauges (compact when collapsed) */}
                                {expanded ? (
                                  <div className="flex flex-col items-end min-w-[120px]">
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
                        </CardBody>
                    </Card>
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
      </div>
    </div>
  );
}