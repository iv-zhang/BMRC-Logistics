'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  Progress
} from '@heroui/react';
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
import { Statpack, StatpackItem } from '@/app/types';
import {
  ArrowLeft,
  Save,
  Minus,
  Plus,
  CheckCircle2,
  ShieldCheck,
  PackageOpen,
  AlertTriangle,
  RefreshCw
} from 'lucide-react';

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

  // Workflow
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [foundCounts, setFoundCounts] = useState<Record<string, number>>({});
  
  // Track seal status for current step in Check-in (True = Still Intact/Unused)
  const [currentSealIntact, setCurrentSealIntact] = useState<boolean | undefined>(undefined);
  
  // New: Track if they restocked the bag during checkin
  const [didRestock, setDidRestock] = useState(false);
  const [usageCalculated, setUsageCalculated] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.push(`/login?returnUrl=/mobile/checkin?id=${id}`);
        return;
      }
      setUser(u);
      if (id) await loadPack(id);
    });
    return () => unsubscribe();
  }, [id, router]);

  const loadPack = async (packId: string) => {
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as Statpack;
        setPack(data);

        // Pre-fill counts with 0 to force counting (unless sealed)
        const init: Record<string, number> = {};
        data.contents?.forEach((item, idx) => {
          init[`${item.itemId}_${idx}`] = 0; 
        });
        setFoundCounts(init);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const steps = useMemo<CheckinStep[]>(() => {
    if (!pack?.contents) return [];
    const result: CheckinStep[] = [];

    // Compartments
    pack.compartments?.forEach(comp => {
      const items = pack.contents.filter(i => i.compartmentId === comp.id);
      if (items.length > 0) {
        result.push({
          id: comp.id,
          name: comp.name,
          isSealed: comp.isSealed,
          sealNumber: comp.sealNumber,
          items
        });
      }
    });

    // Loose
    const loose = pack.contents.filter(i => !i.compartmentId);
    if (loose.length > 0) {
      const pockets = Array.from(new Set(loose.map(i => i.pocket || 'Main')));
      pockets.forEach(p => {
        result.push({
          id: `loose_${p}`,
          name: `${p} (Loose)`,
          isSealed: false,
          items: loose.filter(i => (i.pocket || 'Main') === p)
        });
      });
    }
    return result;
  }, [pack]);

  const currentStep = steps[activeStepIndex];

  // Logic: Items used/missing
  const missingItems = useMemo(() => {
    if (!pack?.contents) return [];
    return pack.contents.map((item, idx) => {
      const found = foundCounts[`${item.itemId}_${idx}`] || 0;
      const used = item.requiredQuantity - found;
      return { ...item, found, used, originalIndex: idx };
    }).filter(i => i.used > 0);
  }, [pack, foundCounts]);


  // Handlers
  const handleSealResponse = (isIntact: boolean) => {
    setCurrentSealIntact(isIntact);
    if (isIntact) {
      setFoundCounts(prev => {
        const next = { ...prev };
        currentStep.items.forEach(item => {
           const idx = pack?.contents.indexOf(item);
           if (idx !== undefined && idx > -1) {
             next[`${item.itemId}_${idx}`] = item.requiredQuantity; 
           }
        });
        return next;
      });
      handleNext();
    }
  };

  const handleNext = () => {
    if (activeStepIndex < steps.length - 1) {
      setActiveStepIndex(prev => prev + 1);
      setCurrentSealIntact(undefined);
      window.scrollTo(0, 0);
    } else {
      setUsageCalculated(true); // Move to Final Summary Screen
    }
  };

  const handleCountChange = (globalIdx: number, delta: number) => {
    const key = `${pack?.contents[globalIdx].itemId}_${globalIdx}`;
    setFoundCounts(prev => {
      const cur = prev[key] || 0;
      return { ...prev, [key]: Math.max(0, cur + delta) };
    });
  };

  const handleCompleteCheckin = async () => {
    if (!pack || !user) return;
    setSubmitting(true);
    try {
      const batch = writeBatch(db); // START BATCH

      const usageReport: string[] = [];
      let status: Statpack['status'] = 'Ready';

      const updatedContents = pack.contents.map((item, idx) => {
        const found = foundCounts[`${item.itemId}_${idx}`] || 0;
        const used = item.requiredQuantity - found; 
        
        if (used > 0) {
          usageReport.push(`${item.itemDetails?.name}: Used ${used}`);
          
          // --- INVENTORY UPDATE LOGIC ---
          // If they restocked, deduct the USED amount from Master Inventory
          if (didRestock) {
             const inventoryRef = doc(db, 'inventory', item.itemId);
             batch.update(inventoryRef, {
                totalStockQuantity: increment(-used)
             });
          }
        }

        // If restocked, bag is now full. If not, it stays at 'found' level.
        const finalQty = didRestock ? item.requiredQuantity : found;

        if (finalQty < item.requiredQuantity) {
          status = 'Restock Needed';
        }

        return { ...item, currentQuantity: finalQty };
      });

      // Update Pack
      const packRef = doc(db, 'statpacks', pack.id);
      batch.update(packRef, {
        contents: updatedContents,
        status: status,
        isCheckedOut: false,
        assignedToUserId: null,
        assignedToUserName: null,
        lastCheckedBy: user.uid,
        lastCheckedAt: serverTimestamp()
      });

      // Log
      const logRef = doc(collection(db, 'statpack_logs'));
      batch.set(logRef, {
        statpackId: pack.id,
        action: 'checkin',
        userId: user.uid,
        timestamp: serverTimestamp(),
        details: usageReport.length > 0 ? usageReport.join(', ') : 'No usage recorded',
        notes: `Check-in complete. Status: ${status}. ${didRestock ? 'Inventory Restocked.' : 'No restock performed.'}`
      });

      // COMMIT
      await batch.commit();

      router.push(`/mobile?id=${pack.id}`);

    } catch (e) {
      console.error(e);
      setSubmitting(false);
    }
  };

  if (loading) return <div className="flex h-screen items-center justify-center"><Spinner /></div>;
  if (!pack) return <div>Pack not found</div>;

  // VIEW: FINAL SUMMARY
  if (usageCalculated) {
     const hasUsage = missingItems.length > 0;
     
     return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 p-4 pb-32">
        <div className="max-w-md mx-auto space-y-6">
           <Button variant="light" onPress={() => setUsageCalculated(false)} startContent={<ArrowLeft size={16}/>}>Back</Button>
           
           <div className="text-center">
              <PackageOpen size={64} className="mx-auto text-primary mb-2" />
              <h2 className="text-2xl font-bold">Shift Summary</h2>
              <p className="text-gray-500">{hasUsage ? "Items used during shift:" : "No items used."}</p>
           </div>

           {hasUsage && (
             <Card className="border border-warning-200 bg-warning-50 dark:bg-warning-900/10">
                <CardBody>
                   <div className="flex items-center gap-2 text-warning-700 font-bold mb-3">
                      <AlertTriangle size={20} />
                      <h3>Usage Detected</h3>
                   </div>
                   <ul className="space-y-2 mb-4">
                      {missingItems.map((item, i) => (
                         <li key={i} className="flex justify-between text-sm">
                            <span>{item.itemDetails?.name}</span>
                            <span className="font-bold text-red-500">Used {item.used}</span>
                         </li>
                      ))}
                   </ul>

                   <div className="bg-white dark:bg-zinc-900 p-3 rounded-lg border border-warning-200">
                      <p className="text-sm font-bold mb-2">Restock Action</p>
                      <p className="text-xs text-gray-500 mb-3">
                         Did you refill these items from the Supply Closet?
                      </p>
                      <Button 
                         className="w-full"
                         color={didRestock ? "success" : "default"}
                         variant={didRestock ? "solid" : "bordered"}
                         startContent={didRestock ? <CheckCircle2 size={18}/> : <RefreshCw size={18}/>}
                         onPress={() => setDidRestock(!didRestock)}
                      >
                         {didRestock ? "Yes, I Restocked Everything" : "No, Bag Left Empty"}
                      </Button>
                      {didRestock && <p className="text-[10px] text-green-600 mt-2 text-center">Inventory will be updated automatically.</p>}
                   </div>
                </CardBody>
             </Card>
           )}

           <Button 
              size="lg" 
              color="primary" 
              className="w-full font-bold shadow-lg"
              isLoading={submitting}
              onPress={handleCompleteCheckin}
              startContent={<Save />}
           >
              Complete Check-In
           </Button>
        </div>
      </div>
     );
  }

  // VIEW: INSPECTION STEPS
  const showSealCheck = currentStep.isSealed && currentSealIntact === undefined;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 pb-32">
       <div className="sticky top-0 z-20 bg-white dark:bg-zinc-900 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <Button isIconOnly size="sm" variant="light" onPress={() => router.back()}><ArrowLeft/></Button>
          <div className="text-center">
            <h1 className="font-bold text-sm uppercase tracking-wider">{currentStep.name}</h1>
            <span className="text-xs text-gray-500">Checking In</span>
          </div>
          <div className="w-8"></div>
        </div>
        <Progress size="sm" value={((activeStepIndex) / steps.length) * 100} className="w-full" color="success"/>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-6">
        
        {showSealCheck && (
           <div className="text-center py-10 animate-fade-in">
              <ShieldCheck size={80} className="mx-auto text-success mb-6" />
              <h2 className="text-2xl font-bold mb-2">Usage Check</h2>
              <p className="text-gray-500 mb-6">Is the seal still intact?</p>
              
              <div className="grid gap-4">
                 <Button color="success" size="lg" className="h-16 font-bold" onPress={() => handleSealResponse(true)}>
                    YES - Seal Intact
                    <span className="text-xs font-normal opacity-70 block w-full">(No Items Used)</span>
                 </Button>
                 <Button color="warning" variant="flat" size="lg" className="h-16 font-bold" onPress={() => handleSealResponse(false)}>
                    NO - Seal Broken
                    <span className="text-xs font-normal opacity-70 block w-full">(I opened this kit)</span>
                 </Button>
              </div>
           </div>
        )}

        {!showSealCheck && (
           <div className="animate-fade-in">
             {currentStep.isSealed && (
               <div className="bg-blue-50 text-blue-700 p-3 rounded-lg mb-4 text-sm flex items-center gap-2">
                 <PackageOpen size={18} />
                 <span>Seal broken. Please count remaining items.</span>
               </div>
             )}

             <div className="space-y-3">
               {currentStep.items.map(item => {
                 const globalIdx = pack.contents.indexOf(item);
                 const key = `${item.itemId}_${globalIdx}`;
                 const count = foundCounts[key] || 0;
                 const req = item.requiredQuantity;
                 const used = req - count;

                 return (
                   <Card key={key}>
                      <CardBody className="flex items-center justify-between p-3">
                         <div>
                            <div className="font-bold text-sm">{item.itemDetails?.name}</div>
                            {used > 0 && <span className="text-xs text-amber-600 font-bold">Used: {used}</span>}
                         </div>
                         <div className="flex items-center gap-3 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1">
                            <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(globalIdx, -1)}><Minus size={16}/></Button>
                            <span className="font-mono font-bold w-6 text-center">{count}</span>
                            <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(globalIdx, 1)}><Plus size={16}/></Button>
                         </div>
                      </CardBody>
                   </Card>
                 );
               })}
             </div>

             <Button 
                size="lg" 
                color="primary" 
                className="w-full mt-8 font-bold shadow-lg" 
                onPress={handleNext}
                isLoading={submitting}
             >
                Next Section
             </Button>
           </div>
        )}

      </div>
    </div>
  );
}
