'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  Progress,
  Chip,
  Input
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
  RefreshCw,
  Wind
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

  // Checkin State
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  const [oxygenReadings, setOxygenReadings] = useState<Record<string, string>>({});

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
        const batch = writeBatch(db);
        const packRef = doc(db, 'statpacks', pack.id);
        
        const totalUsed = Object.values(usageCounts).reduce((a, b) => a + b, 0);
        
        batch.update(packRef, {
            isCheckedOut: false,
            lastCheckedBy: user.fullName || user.email,
            lastCheckedAt: serverTimestamp(),
            status: totalUsed > 0 ? 'Restock Needed' : 'Ready',
            assignedToUserId: null,
            assignedToUserName: null
        });

        // Log Entry
        const logRef = doc(collection(db, 'statpack_logs'));
        batch.set(logRef, {
            statpackId: pack.id,
            statpackName: pack.name,
            action: 'checkin',
            userId: user.uid,
            userName: user.fullName || user.email,
            timestamp: serverTimestamp(),
            itemsUsed: usageCounts, 
            oxygenReadings 
        });

        // Update Master Inventory Oxygen Levels
        Object.entries(oxygenReadings).forEach(([itemId, psiStr]) => {
            const psi = parseInt(psiStr);
            if (!isNaN(psi)) {
               const inventoryRef = doc(db, 'inventory', itemId);
               batch.update(inventoryRef, { 
                   oxygenPsi: psi,
                   updatedAt: serverTimestamp()
               });
            }
        });

        await batch.commit();
        
        // FIX: Correct redirect path to mobile dashboard
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

  const currentStep = steps[activeStepIndex];
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
        
        {/* Step Header */}
        <div className="mb-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
                {currentStep.isSealed ? <ShieldCheck className="text-amber-500"/> : <PackageOpen className="text-blue-500"/>}
                {currentStep.name}
            </h2>
            <p className="text-gray-500 text-sm">Did you use any items from here?</p>
        </div>

        <div className="space-y-4">
            {currentStep.items.map((item, idx) => {
                const key = `${activeStepIndex}-${idx}`;
                const used = usageCounts[key] || 0;
                const isOxygen = item.itemDetails?.isOxygen;

                return (
                   <Card key={idx} className={`border ${used > 0 ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/10' : 'border-gray-200 dark:border-slate-700'}`}>
                      <CardBody className="flex flex-col gap-3">
                         <div className="flex justify-between items-start">
                             <div>
                                <div className="font-bold text-sm flex items-center gap-2">
                                    {item.itemDetails?.name}
                                    {isOxygen && (
                                       <Chip size="sm" color="primary" variant="flat" startContent={<Wind size={10}/>} className="h-5 text-[10px]">
                                          Oxygen
                                       </Chip>
                                    )}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Pack Qty: {item.currentQuantity}
                                </div>
                             </div>
                             
                             {/* Usage Counter */}
                             <div className="flex items-center gap-3 bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
                                <Button isIconOnly size="sm" variant="light" onPress={() => handleUsageChange(idx, -1)}><Minus size={16}/></Button>
                                <span className={`font-mono font-bold w-6 text-center ${used > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{used}</span>
                                <Button isIconOnly size="sm" variant="light" onPress={() => handleUsageChange(idx, 1)}><Plus size={16}/></Button>
                             </div>
                         </div>

                         {/* Oxygen Input during Check-in */}
                         {isOxygen && (
                            <div className="pt-2 border-t border-dashed border-gray-300 dark:border-slate-600">
                                <Input
                                    type="number"
                                    label="Report O2 PSI"
                                    placeholder="e.g. 1800"
                                    size="sm"
                                    variant="bordered"
                                    startContent={<Wind size={14} className="text-blue-500"/>}
                                    value={oxygenReadings[item.itemId] || ''}
                                    onValueChange={(val) => handleOxygenChange(item.itemId, val)}
                                    color="primary"
                                />
                            </div>
                         )}
                      </CardBody>
                   </Card>
                );
            })}
        </div>

        <div className="mt-8">
            <Button 
                fullWidth 
                size="lg" 
                color="primary" 
                className="font-bold shadow-md"
                onPress={handleNext}
                isLoading={submitting}
            >
                {activeStepIndex === steps.length - 1 ? 'Finish Check-in' : 'Next Section'}
            </Button>
        </div>

      </div>
    </div>
  );
}