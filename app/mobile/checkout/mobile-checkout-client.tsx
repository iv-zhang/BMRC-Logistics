'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  Progress,
  Input,
  Textarea,
  Chip,
  Tooltip,
  Badge
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  doc,
  getDoc,
  collection,
  serverTimestamp,
  writeBatch,
  increment,
  Timestamp
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { Statpack, StatpackItem, StatpackPocket } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import {
  ArrowLeft,
  CheckCircle2,
  Minus,
  Plus,
  ClipboardCheck,
  ShieldCheck,
  AlertTriangle,
  Package,
  ListFilter,
  ArrowRight,
  CalendarDays,
  History,
  Layers // Icon for 'batch'
} from 'lucide-react';

interface CheckoutStep {
  id: string;
  name: string;
  type: 'compartment' | 'loose_pocket';
  parentPocket: StatpackPocket;
  isSealed: boolean;
  sealNumber?: string;
  expirationDate?: Date;
  items: StatpackItem[];
}

type ViewState = 'dashboard' | 'inspecting' | 'review';

export default function MobileCheckoutClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  // -- Data --
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // -- Workflow State --
  const [view, setView] = useState<ViewState>('dashboard');
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [filterPocket, setFilterPocket] = useState<StatpackPocket | 'all'>('all');

  // -- Inspection State --
  const [counts, setCounts] = useState<Record<string, number>>({});
  
  // Active Form State: Key: "itemId_index", Value: "YYYY-MM-DD" string (User input)
  const [expirationUpdates, setExpirationUpdates] = useState<Record<string, string>>({});
  
  // We keep lastKnownExps internally to detect significant deviations if needed later, 
  // but we won't show it to the user to prevent cheating.
  const [lastKnownExps, setLastKnownExps] = useState<Record<string, string>>({});

  const [missingExpirationKeys, setMissingExpirationKeys] = useState<Set<string>>(new Set());
  const [currentStepSealIntact, setCurrentStepSealIntact] = useState<boolean | undefined>(undefined);
  const [sealStatusByStep, setSealStatusByStep] = useState<Record<string, boolean>>({});

  // -- Form Data --
  const [eventName, setEventName] = useState('');
  const [notes, setNotes] = useState('');
  const [didRestock, setDidRestock] = useState(false);

  // 1. Auth & Load
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        const returnUrl = id ? `/mobile/checkout?id=${id}` : '/mobile/checkout';
        router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUser(u);
      if (!pack) await loadPack(id);
    });
    return () => unsubscribe();
  }, [id, router]);

  const loadPack = async (packId: string) => {
    if (!packId) return;
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        const rawData = snap.data();
        const convertDates = (obj: any): any => {
           if (!obj) return obj;
           if (obj instanceof Timestamp) return obj.toDate();
           if (Array.isArray(obj)) return obj.map(convertDates);
           if (typeof obj === 'object') {
             const newObj: any = {};
             for (const key in obj) newObj[key] = convertDates(obj[key]);
             return newObj;
           }
           return obj;
        };

        const data = { id: snap.id, ...convertDates(rawData) } as Statpack;
        setPack(data);
        
        const initialCounts: Record<string, number> = {};
        const knownExps: Record<string, string> = {};

        data.contents?.forEach((item, idx) => {
          initialCounts[`${item.itemId}_${idx}`] = 0;
          
          const expSource = item.expirationDate ?? item.itemDetails?.expirationDate;
          if (expSource instanceof Date) {
            knownExps[`${item.itemId}_${idx}`] = expSource.toISOString().split('T')[0];
          }
        });
        
        setCounts(initialCounts);
        setLastKnownExps(knownExps); 
        setExpirationUpdates({}); // ALWAYS start empty to force manual check
        setMissingExpirationKeys(new Set());
        setSealStatusByStep({});
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Helper: Check Expiration Status (for visual coloring after input)
  const getExpirationStatus = (dateString?: string) => {
    if (!dateString) return { status: 'empty', label: 'Required', color: 'default' as const };
    
    const date = new Date(dateString);
    const now = new Date();
    date.setHours(0,0,0,0);
    now.setHours(0,0,0,0);

    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { status: 'expired', label: `EXPIRED`, color: 'danger' as const };
    if (diffDays <= 30) return { status: 'warning', label: `Exp < 30d`, color: 'warning' as const };
    return { status: 'ok', label: `OK`, color: 'success' as const };
  };

  const requiresExpirationCheck = (item: StatpackItem) => {
     // Strict check: Only required if the inventory item explicitly tracks it
     return Boolean(item.itemDetails?.tracksExpiration || item.expirationDate);
  };

  const getMissingExpirationKeysForStep = (step: CheckoutStep) => {
    if (!pack?.contents) return [];
    if (step.isSealed && sealStatusByStep[step.id] === true) return [];

    return step.items.reduce<string[]>((acc, item) => {
      const globalIdx = pack.contents.indexOf(item);
      if (globalIdx < 0) return acc;
      
      if (requiresExpirationCheck(item)) {
        const key = `${item.itemId}_${globalIdx}`;
        // CRITICAL: We only accept it if the user has physically entered a date string
        if (!expirationUpdates[key] || expirationUpdates[key] === '') {
          acc.push(key);
        }
      }
      return acc;
    }, []);
  };

  // 2. Build Steps (Memoized)
  const steps = useMemo<CheckoutStep[]>(() => {
    if (!pack?.contents) return [];
    const result: CheckoutStep[] = [];

    // Compartments
    if (pack.compartments) {
      pack.compartments.forEach(comp => {
        const compItems = pack.contents.filter(i => i.compartmentId === comp.id);
        if (compItems.length > 0) {
          result.push({
            id: comp.id,
            name: comp.name,
            type: 'compartment',
            parentPocket: comp.parentPocket,
            isSealed: comp.isSealed,
            sealNumber: comp.sealNumber,
            expirationDate: comp.expirationDate,
            items: compItems
          });
        }
      });
    }

    // Loose
    const looseItems = pack.contents.filter(i => !i.compartmentId);
    if (looseItems.length > 0) {
      const pockets = Array.from(new Set(looseItems.map(i => i.pocket || 'main')));
      pockets.forEach(pocket => {
        const pocketItems = looseItems.filter(i => (i.pocket || 'main') === pocket);
        result.push({
          id: `loose_${pocket}`,
          name: `${pocket.replace('_', ' ')} (Loose Items)`,
          type: 'loose_pocket',
          parentPocket: pocket as StatpackPocket,
          isSealed: false, 
          items: pocketItems
        });
      });
    }
    return result.sort((a, b) => a.parentPocket.localeCompare(b.parentPocket));
  }, [pack]);

  const currentStep = useMemo(() => steps.find(s => s.id === activeStepId), [steps, activeStepId]);
  
  const filteredSteps = useMemo(() => {
    if (filterPocket === 'all') return steps;
    return steps.filter(s => s.parentPocket === filterPocket);
  }, [steps, filterPocket]);

  const progressValue = (completedSteps.size / steps.length) * 100;

  // 3. Logic: Discrepancies
  const discrepancies = useMemo(() => {
    if (!pack?.contents) return [];
    return pack.contents
      .map((item, idx) => {
        const current = counts[`${item.itemId}_${idx}`] || 0;
        const delta = item.requiredQuantity - current;
        return { ...item, currentCount: current, delta, originalIndex: idx };
      })
      .filter(d => d.delta > 0);
  }, [pack, counts]);

  // 4. Handlers
  const handleStartStep = (stepId: string) => {
    setActiveStepId(stepId);
    setView('inspecting');
    setCurrentStepSealIntact(undefined);
    window.scrollTo(0,0);
  };

  const handleFinishStep = () => {
    if (currentStep) {
      const missingKeys = getMissingExpirationKeysForStep(currentStep);
      if (missingKeys.length > 0) {
        setMissingExpirationKeys(prev => new Set([...prev, ...missingKeys]));
        alert('Verification Required: You must manually enter expiration dates for all tracked items.');
        return;
      }
    }
    if (activeStepId) {
      setCompletedSteps(prev => new Set(prev).add(activeStepId));
      setView('dashboard');
      setActiveStepId(null);
    }
  };

  const handleSealResponse = (isIntact: boolean) => {
    setCurrentStepSealIntact(isIntact);
    if (currentStep?.id) {
      setSealStatusByStep(prev => ({ ...prev, [currentStep.id]: isIntact }));
    }
    if (isIntact) {
      setCounts(prev => {
        const next = { ...prev };
        currentStep?.items.forEach(item => {
           const globalIdx = pack?.contents.indexOf(item);
           if (globalIdx !== undefined && globalIdx > -1) {
             next[`${item.itemId}_${globalIdx}`] = item.requiredQuantity;
           }
        });
        return next;
      });
      setTimeout(() => handleFinishStep(), 500);
    }
  };

  const handleCountChange = (globalIndex: number, delta: number) => {
    const key = `${pack?.contents[globalIndex].itemId}_${globalIndex}`;
    setCounts(prev => {
      const current = prev[key] || 0;
      return { ...prev, [key]: Math.max(0, current + delta) };
    });
  };

  const handleDateChange = (globalIndex: number, newValue: string) => {
    const key = `${pack?.contents[globalIndex].itemId}_${globalIndex}`;
    setExpirationUpdates(prev => ({
      ...prev,
      [key]: newValue
    }));
    setMissingExpirationKeys(prev => {
      if (!prev.has(key) || !newValue) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const handleCompleteCheckout = async () => {
    if (!pack || !user) return;
    const missingKeys = steps.flatMap(getMissingExpirationKeysForStep);
    if (missingKeys.length > 0) {
      setMissingExpirationKeys(new Set(missingKeys));
      alert('Incomplete: Please verify expiration dates for all items or confirm seals.');
      return;
    }
    setSubmitting(true);

    try {
      const batch = writeBatch(db); 
      
      const missingItemsLog: string[] = [];
      let newStatus: Statpack['status'] = 'In Use';
      
      const finalContents = pack.contents.map((item, idx) => {
        const counted = counts[`${item.itemId}_${idx}`] || 0;
        const missingAmount = item.requiredQuantity - counted;
        
        // Handle Expiration Logic
        const dateStr = expirationUpdates[`${item.itemId}_${idx}`];
        const existingExpDate = item.expirationDate ?? item.itemDetails?.expirationDate;
        const newExpDate = dateStr ? new Date(dateStr) : existingExpDate;

        if (missingAmount > 0) {
          missingItemsLog.push(`${item.itemDetails?.name || 'Item'} (Found: ${counted}/${item.requiredQuantity})`);
          if (didRestock) {
             const inventoryRef = doc(db, 'inventory', item.itemId);
             batch.update(inventoryRef, { 
                totalStockQuantity: increment(-missingAmount) 
             });
          }
        }
        
        const finalQty = didRestock ? item.requiredQuantity : counted;
        
        return { 
          ...item, 
          currentQuantity: finalQty,
          expirationDate: newExpDate 
        };
      });

      if (missingItemsLog.length > 0 && !didRestock) {
        newStatus = 'Restock Needed';
      }

      const hasExpired = finalContents.some(i => {
         if(!i.expirationDate) return false;
         return i.expirationDate < new Date();
      });
      if(hasExpired && newStatus === 'In Use') newStatus = 'Expired Items';


      if (missingItemsLog.length > 0) {
        const logRef = doc(collection(db, 'statpack_logs'));
        batch.set(logRef, {
          statpackId: pack.id,
          action: 'inventory_adjustment',
          userId: user.uid,
          timestamp: serverTimestamp(),
          details: didRestock ? 'Items missing at check-out, RESTOCKED.' : 'Items missing.',
          missingItems: missingItemsLog,
          notes: `Discrepancy in ${missingItemsLog.length} items.`
        });
      }

      const packRef = doc(db, 'statpacks', pack.id);
      batch.update(packRef, {
        contents: finalContents,
        status: newStatus,
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: user.displayName || user.email,
        checkedOutAt: serverTimestamp(),
        currentEvent: eventName
      });

      const checkoutLogRef = doc(collection(db, 'statpack_logs'));
      batch.set(checkoutLogRef, {
        statpackId: pack.id,
        action: 'checkout',
        userId: user.uid,
        timestamp: serverTimestamp(),
        notes: `Checkout complete. Event: ${eventName}.`
      });

      await batch.commit();
      router.push(`/mobile?id=${pack.id}`);
    } catch (e) {
      console.error(e);
      setSubmitting(false);
    }
  };

  // ... Render ...
  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner size="lg"/></div>;
  if (!pack) return <div className="p-6">Pack not found</div>;

  if (view === 'review') {
    const hasIssues = discrepancies.length > 0;
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 p-4 pb-32">
        <div className="max-w-md mx-auto space-y-6">
          <Button variant="light" onPress={() => setView('dashboard')} startContent={<ArrowLeft size={16}/>}>Back to Dashboard</Button>
          
          <div className="text-center space-y-2">
            <ClipboardCheck size={64} className={`mx-auto ${hasIssues ? 'text-warning' : 'text-success'}`} />
            <h2 className="text-2xl font-bold">Final Review</h2>
          </div>
          
          {hasIssues && (
             <Card className="border-danger border bg-danger-50 dark:bg-danger-900/20">
              <CardBody>
                <div className="flex items-center gap-2 text-danger font-bold mb-2">
                  <AlertTriangle size={20}/><h3>Discrepancies</h3>
                </div>
                <ul className="list-disc pl-5 space-y-1 mb-4 text-sm">
                  {discrepancies.map((d, i) => (
                    <li key={i}><b>{d.itemDetails?.name}</b>: {d.currentCount}/{d.requiredQuantity}</li>
                  ))}
                </ul>
                <div className="bg-white dark:bg-zinc-900 p-3 rounded-lg border border-danger-200">
                   <p className="text-sm font-bold mb-2">Did you restock these?</p>
                   <Button 
                      color={didRestock ? "success" : "danger"} 
                      variant={didRestock ? "solid" : "flat"} 
                      className="w-full font-bold"
                      startContent={didRestock ? <CheckCircle2/> : undefined}
                      onPress={() => setDidRestock(!didRestock)}
                   >
                      {didRestock ? "YES - Items Replaced" : "NO - Bag Incomplete"}
                   </Button>
                </div>
              </CardBody>
            </Card>
          )}

          <Input label="Event Name" value={eventName} onValueChange={setEventName} isRequired placeholder="e.g. Football Game"/>
          <Textarea label="Notes" value={notes} onValueChange={setNotes} />
          <Button size="lg" color="primary" className="w-full font-bold shadow-lg" isDisabled={!eventName} isLoading={submitting} onPress={handleCompleteCheckout}>Confirm & Check Out</Button>
        </div>
      </div>
    );
  }

  if (view === 'inspecting' && currentStep) {
    const showSealCheck = currentStep.isSealed && currentStepSealIntact === undefined;
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 pb-32">
        <div className="sticky top-0 z-20 bg-white dark:bg-zinc-900 shadow-sm px-4 py-3 flex items-center justify-between">
            <Button isIconOnly size="sm" variant="light" onPress={() => setView('dashboard')}><ArrowLeft/></Button>
            <div className="text-center">
              <h1 className="font-bold text-sm uppercase tracking-wider">{currentStep.name}</h1>
              <span className="text-xs text-gray-500 uppercase">{currentStep.type === 'compartment' ? 'Compartment' : 'Pocket'}</span>
            </div>
            <div className="w-8"></div>
        </div>
        <div className="p-4 max-w-lg mx-auto space-y-6">
          {showSealCheck && (
             <div className="text-center py-10 animate-fade-in">
                <ShieldCheck size={80} className="mx-auto text-primary mb-6" />
                <h2 className="text-2xl font-bold mb-2">Check Seal</h2>
                <div className="bg-gray-200 dark:bg-zinc-800 px-6 py-2 rounded-full inline-block mb-4">
                   <span className="font-mono text-xl tracking-widest font-bold">{currentStep.sealNumber || '----'}</span>
                </div>
                <p className="text-gray-500 mb-8">Is the seal intact?</p>
                <div className="grid gap-4">
                   <Button color="success" size="lg" className="h-14 font-bold text-white shadow-lg" onPress={() => handleSealResponse(true)}>YES - Seal Intact</Button>
                   <Button color="danger" variant="flat" size="lg" className="h-14" onPress={() => handleSealResponse(false)}>NO - Seal Broken / Missing</Button>
                </div>
             </div>
          )}
          {!showSealCheck && (
             <div className="animate-fade-in">
                {currentStep.isSealed && currentStepSealIntact === false && (
                  <div className="bg-warning-50 text-warning-700 p-3 rounded-lg mb-6 flex items-center gap-2 text-sm">
                     <AlertTriangle size={18} /><span>Seal broken. Perform manual count.</span>
                  </div>
                )}
                <div className="space-y-4">
                   {currentStep.items.map((item) => {
                      const globalIdx = pack.contents.indexOf(item);
                      const key = `${item.itemId}_${globalIdx}`;
                      const count = counts[key] || 0;
                      const req = item.requiredQuantity;
                      const isLow = count < req;
                      
                      const tracksExp = requiresExpirationCheck(item);
                      
                      // Active Logic
                      const enteredDate = expirationUpdates[key];
                      const expStatus = getExpirationStatus(enteredDate); 
                      const isExpMissing = missingExpirationKeys.has(key);
                      
                      return (
                        <Card 
                            key={key} 
                            className={`border transition-all ${isExpMissing ? 'border-danger ring-1 ring-danger' : isLow ? 'border-danger-200' : 'border-transparent'}`}
                        >
                          <CardBody className="p-3">
                             <div className="flex flex-row items-center justify-between mb-2">
                                <div className="flex-grow">
                                  <div className="font-semibold text-sm flex items-center gap-2">
                                    {item.itemDetails?.name || 'Unknown Item'}
                                  </div>
                                  <div className="text-xs text-gray-500">Par Level: {req}</div>
                                </div>
                                <div className="flex items-center gap-3 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1">
                                  <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(globalIdx, -1)}><Minus size={16}/></Button>
                                  <span className={`font-mono font-bold w-6 text-center ${isLow ? 'text-danger' : ''}`}>{count}</span>
                                  <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(globalIdx, 1)}><Plus size={16}/></Button>
                                </div>
                             </div>

                             {/* --- EXPIRATION INPUT (BLIND CHECK) --- */}
                             {tracksExp && (
                                <div className="mt-3 pt-3 border-t border-dashed border-gray-200 dark:border-zinc-700">
                                   <div className="flex flex-col gap-1 mb-2">
                                      <div className="flex items-center gap-2 text-xs font-semibold text-gray-600">
                                        <CalendarDays size={14} className="text-primary" />
                                        <span>Expiration Check Required</span>
                                      </div>
                                      {/* Helper for multiple items */}
                                      {item.requiredQuantity > 1 && (
                                        <div className="flex items-center gap-1 text-[10px] text-gray-400">
                                            <Layers size={10} />
                                            <span>Multiple items? Enter the <b>earliest</b> date found.</span>
                                        </div>
                                      )}
                                   </div>

                                   <div className="flex gap-2 items-center">
                                      <Input 
                                        type="date" 
                                        size="sm" 
                                        aria-label="Expiration Date"
                                        placeholder="YYYY-MM-DD"
                                        value={enteredDate || ''}
                                        onValueChange={(val) => handleDateChange(globalIdx, val)}
                                        color={isExpMissing ? "danger" : "default"}
                                        description={isExpMissing ? "You must check the label" : undefined}
                                        classNames={{
                                            input: "text-right font-mono" // Helps alignment
                                        }}
                                      />
                                      {enteredDate && (
                                        <Chip size="sm" color={expStatus.color} variant="flat" className="h-10 px-2 min-w-fit font-bold">
                                           {expStatus.label}
                                        </Chip>
                                      )}
                                   </div>
                                </div>
                             )}
                          </CardBody>
                        </Card>
                      );
                   })}
                </div>
                <Button size="lg" color="primary" className="w-full mt-8 font-bold shadow-lg" onPress={handleFinishStep}>Finish Section</Button>
             </div>
          )}
        </div>
      </div>
    );
  }

  // Dashboard View
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 pb-32">
      <div className="sticky top-0 z-20 bg-white dark:bg-zinc-900 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <Button isIconOnly size="sm" variant="light" onPress={() => router.back()}><ArrowLeft/></Button>
          <div className="text-center">
            <h1 className="font-bold text-sm uppercase tracking-wider">{pack.name}</h1>
            <span className="text-xs text-gray-500">Checkout Dashboard</span>
          </div>
          <div className="w-8"></div>
        </div>
        <Progress size="sm" value={progressValue} color={progressValue === 100 ? "success" : "primary"} className="w-full"/>
      </div>
      <div className="max-w-lg mx-auto">
        <div className="bg-white dark:bg-zinc-900 border-b border-gray-100 dark:border-zinc-800">
           <BagVisualizer statpack={pack} selectedPocket={filterPocket} onSelectPocket={setFilterPocket} />
        </div>
        <div className="px-4 pt-4 flex items-center gap-2">
           <ListFilter size={16} className="text-gray-500" />
           <span className="text-sm font-semibold text-gray-600 uppercase">
             {filterPocket === 'all' ? 'All Sections' : `${filterPocket.replace('_', ' ')} Sections`}
           </span>
        </div>
        <div className="p-4 grid gap-3">
           {filteredSteps.map(step => {
              const isComplete = completedSteps.has(step.id);
              return (
                <Card 
                  key={step.id} 
                  isPressable 
                  onPress={() => handleStartStep(step.id)}
                  className={`border-l-4 ${isComplete ? 'border-l-success' : 'border-l-primary'}`}
                >
                   <CardBody className="flex flex-row items-center justify-between p-4">
                      <div className="flex items-center gap-3">
                         {isComplete 
                            ? <CheckCircle2 className="text-success" size={22} />
                            : <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
                         }
                         <div>
                            <div className="font-bold">{step.name}</div>
                            <div className="text-xs text-gray-500 flex items-center gap-2">
                               {step.isSealed ? <ShieldCheck size={12}/> : <Package size={12}/>}
                               {step.items.length} Items
                            </div>
                         </div>
                      </div>
                      {!isComplete && <ArrowRight size={16} className="text-gray-400" />}
                   </CardBody>
                </Card>
              );
           })}
           {filteredSteps.length === 0 && <div className="text-center py-8 text-gray-400 text-sm">No checkout steps found for this pocket.</div>}
        </div>
      </div>
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/90 backdrop-blur-sm border-t dark:bg-zinc-900/90 dark:border-zinc-800 z-30">
         <div className="max-w-lg mx-auto">
            <Button 
               size="lg" 
               color={completedSteps.size === steps.length ? "success" : "primary"}
               className="w-full font-bold shadow-lg"
               onPress={() => setView('review')}
            >
               {completedSteps.size === steps.length ? "Finish Checkout" : `Review Progress (${completedSteps.size}/${steps.length})`}
            </Button>
         </div>
      </div>
    </div>
  );
}