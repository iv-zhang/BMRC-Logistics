'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Spinner, Progress } from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  doc,
  getDoc,
  collection,
  serverTimestamp,
  writeBatch,
  increment
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { Statpack, StatpackItem, User } from '@/app/types';
import { ArrowLeft } from 'lucide-react';

interface CheckinStep {
  id: string;
  name: string;
  isSealed: boolean;
  sealNumber?: string;
  items: StatpackItem[];
}

export default function MobileCheckinClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Checkin State
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  const [oxygenReadings, setOxygenReadings] = useState<Record<string, string>>({});
  const [assetChecksMap, setAssetChecksMap] = useState<Record<string, any>>({});
  const [inventorySerials, setInventorySerials] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) setUser(u);
      else router.push('/login');
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!id) return;
    const fetchPack = async () => {
      try {
        const ref = doc(db, 'statpacks', id);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          setPack({ ...snap.data(), id: snap.id } as Statpack);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchPack();
  }, [id]);

  // When pack is loaded, prefetch inventory serials for asset items
  useEffect(() => {
    if (!pack) return;
    const itemIds = Array.from(new Set((pack.contents || []).map(c => c.itemId)));
    itemIds.forEach(async (iid) => {
      try {
        const ref = doc(db, 'inventory', iid);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as any;
          // collect serials from batches
          const serials: string[] = [];
          if (Array.isArray(data.batches)) {
            data.batches.forEach((b: any) => {
              if (Array.isArray(b.serialNumbers)) serials.push(...b.serialNumbers.filter(Boolean));
            });
          }
          setInventorySerials(prev => ({ ...prev, [iid]: serials }));
        }
      } catch (e) {
        console.warn('Failed to fetch inventory for serials', iid, e);
      }
    });
  }, [pack]);

  // Group items into steps
  const steps = useMemo<CheckinStep[]>(() => {
    if (!pack) return [];
    
    const _steps: CheckinStep[] = [];
    
    // 1. Compartments
    if (pack.compartments) {
        pack.compartments.forEach(comp => {
            const items = pack.contents?.filter(i => i.compartmentId === comp.id) || [];
            if (items.length > 0) {
                _steps.push({
                    id: comp.id,
                    name: comp.name,
                    isSealed: comp.isSealed,
                    sealNumber: comp.sealNumber,
                    items
                });
            }
        });
    }

    // 2. Loose Pockets
    const loose = pack.contents?.filter(i => !i.compartmentId) || [];
    if (loose.length > 0) {
        _steps.push({
            id: 'loose',
            name: 'Loose Items / Pockets',
            isSealed: false,
            items: loose
        });
    }

    return _steps;
  }, [pack]);

  const handleUsageChange = (itemIdxInStep: number, delta: number) => {
     const key = `${activeStepIndex}-${itemIdxInStep}`;
     setUsageCounts(prev => {
        const cur = prev[key] || 0;
        const newVal = Math.max(0, cur + delta);
        return { ...prev, [key]: newVal };
     });
  };

  const handleOxygenChange = (itemId: string, val: string) => {
      setOxygenReadings(prev => ({ ...prev, [itemId]: val }));
  };

  const handleAssetCheckChange = (statpackItemId: string, patch: Partial<any>) => {
    setAssetChecksMap(prev => ({ ...prev, [statpackItemId]: { ...(prev[statpackItemId] || {}), ...patch } }));
  };

  const handleNext = () => {
    if (activeStepIndex < steps.length - 1) {
        setActiveStepIndex(prev => prev + 1);
        window.scrollTo(0,0);
    } else {
        handleFinish();
    }
  };

  const handleFinish = async () => {
    if (!pack || !user) return;
    setSubmitting(true);

    try {
      // Resolve user's preferred display name: prefer Firestore `users.{uid}.fullName`, then Firebase displayName, then email
      let resolvedName = user.displayName || user.email || 'Unknown User';
      try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const d = userSnap.data() as Partial<User> | undefined;
          if (d?.fullName) resolvedName = d.fullName;
        }
      } catch (e) {
        console.warn('Failed to read user profile for name resolution', e);
      }

      const batch = writeBatch(db);
      const packRef = doc(db, 'statpacks', pack.id);

      const totalUsed = Object.values(usageCounts).reduce((a, b) => a + b, 0);

      batch.update(packRef, {
        isCheckedOut: false,
        lastCheckedBy: resolvedName,
        lastCheckedAt: serverTimestamp(),
        status: totalUsed > 0 ? 'Restock Needed' : 'Ready',
        assignedToUserId: null,
        assignedToUserName: null,
      });

      // Log Entry
      const logRef = doc(collection(db, 'statpack_logs'));
      batch.set(logRef, {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkin',
        userId: user.uid,
        userName: resolvedName,
        timestamp: serverTimestamp(),
        itemsUsed: usageCounts,
        oxygenReadings,
        assetChecks: assetChecksMap,
      });

      // Update Master Inventory Oxygen Levels
      Object.entries(oxygenReadings).forEach(([itemId, psiStr]) => {
        const psi = parseInt(psiStr);
        if (!isNaN(psi)) {
          const inventoryRef = doc(db, 'inventory', itemId);
          batch.update(inventoryRef, {
            oxygenPsi: psi,
            updatedAt: serverTimestamp(),
          });
        }
      });

      // Update Master Inventory for used items (decrement stock)
      // Build a mapping of itemId -> total used across steps
      const perItemUsage: Record<string, number> = {};
      steps.forEach((step, sIdx) => {
        step.items.forEach((it, idx) => {
          const key = `${sIdx}-${idx}`;
          const used = Number(usageCounts[key] ?? 0);
          if (used > 0) {
            perItemUsage[it.itemId] = (perItemUsage[it.itemId] || 0) + used;
          }
        });
      });

      Object.entries(perItemUsage).forEach(([itemId, usedCount]) => {
        const inventoryRef = doc(db, 'inventory', itemId);
        batch.update(inventoryRef, {
          totalStockQuantity: increment(-usedCount),
          updatedAt: serverTimestamp(),
        });
      });

      // Update inventory asset checks for AEDs / assets that were checked present
      for (const [statpackItemId, checks] of Object.entries(assetChecksMap)) {
        try {
          // find the statpack item to get mapping to inventory itemId
          const spi = (pack.contents || []).find(i => {
            const key = (i as any).id ?? `${i.itemId}-${i.compartmentId ?? 'loose'}`;
            return key === statpackItemId || i.itemId === statpackItemId;
          });
          if (!spi) continue;

          // Prefer itemDetails if provided; otherwise fetch inventory doc to check assetCategory
          let isAED = false;
          if ((spi as any).itemDetails) {
            isAED = Boolean((spi as any).itemDetails?.assetCategory === 'AED');
          } else {
            try {
              const invSnap = await getDoc(doc(db, 'inventory', spi.itemId));
              if (invSnap.exists()) {
                const d = invSnap.data() as any;
                isAED = Boolean(d?.assetCategory === 'AED');
              }
            } catch (e) {
              // ignore fetch errors and skip
            }
          }

          if (!isAED) continue;

          const inventoryRef = doc(db, 'inventory', spi.itemId);
          // If present, update inventory assetChecks and lastChecked
          if (checks.present) {
            batch.update(inventoryRef, {
              assetLastChecked: serverTimestamp(),
              assetChecks: checks,
              updatedAt: serverTimestamp(),
            });
          } else {
            // If missing, mark status to Not Ready (do not decrement asset counts here)
            batch.update(inventoryRef, {
              assetStatus: 'Not Ready',
              updatedAt: serverTimestamp(),
            });
          }
        } catch (e) {
          console.warn('Failed to schedule inventory asset update', e);
        }
      }

      await batch.commit();

      router.push(`/mobile?id=${pack.id}`);
    } catch (e) {
      console.error(e);
      alert('Check-in failed');
      setSubmitting(false);
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;
  if (!pack) return <div className="p-6">Pack not found</div>;
  if (steps.length === 0) return <div className="p-6">Empty pack configuration</div>;

  const progress = ((activeStepIndex) / steps.length) * 100;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-20">
      <div className="bg-white dark:bg-slate-800 p-4 sticky top-0 z-20 border-b border-gray-200 dark:border-slate-700 shadow-sm">
         <div className="flex items-center gap-2 mb-2">
            <Button isIconOnly size="sm" variant="light" onPress={() => router.back()}><ArrowLeft size={18}/></Button>
            <div>
                <h1 className="font-bold text-lg">Check-in: {pack.name}</h1>
                <p className="text-xs text-gray-500">Report usage & O2 levels</p>
            </div>
         </div>
         <Progress size="sm" value={progress} color="primary" className="mb-0"/>
      </div>

      <div className="max-w-md mx-auto p-4">
        <div className="mb-6 text-center">
          <h2 className="text-xl font-bold">{pack.name}</h2>
          <p className="text-sm text-gray-500">Simulate a mobile QR scan to record a check-in.</p>
        </div>

        <div className="space-y-4">
          <Button
            fullWidth
            size="lg"
            color="primary"
            className="font-bold shadow-md"
            onPress={handleFinish}
            isLoading={submitting}
          >
            Simulate QR Scan
          </Button>
        </div>
      </div>
    </div>
  );
}