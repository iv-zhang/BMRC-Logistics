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
  Divider,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  RadioGroup,
  Radio,
  Switch
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
import { Statpack, StatpackItem, StatpackPocket, User } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import {
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  AlertTriangle,
  Package,
  ListFilter,
  Wind,
  CalendarDays,
  ThermometerSnowflake, 
  Layers,
  Map as MapIcon,
  Check,
  Hand,
  AlertOctagon,
  Unlock,
  Lock
} from 'lucide-react';

// --- Types ---
interface IssueReport {
  itemId: string;
  itemName: string;
  issueType: 'missing' | 'expired' | 'damaged' | 'other';
  isReplaced: boolean;
  replacedQuantity: number;
  newExpirationDate?: string;
  notes: string;
}

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

// --- Helpers ---
const getDate = (ts: any): Date | undefined => {
  if (!ts) return undefined;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts);
  return undefined;
};

const toInputDate = (d?: Date): string => {
    if (!d) return '';
    try {
        return d.toISOString().split('T')[0];
    } catch (e) {
        return '';
    }
};

export default function MobileCheckoutClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Checkout Navigation
  const [view, setView] = useState<'intro' | 'steps' | 'review'>('intro');
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
    const [autoReviewMode, setAutoReviewMode] = useState(false);
    const [stepOrder, setStepOrder] = useState<string[]>([]);
  
  // Modals
  const { isOpen: isMapOpen, onOpen: onMapOpen, onOpenChange: onMapChange } = useDisclosure();
  const { isOpen: isIssueOpen, onOpen: onIssueOpen, onOpenChange: onIssueChange } = useDisclosure();

  // Data Collection
  const [sealCheck, setSealCheck] = useState<Record<string, boolean>>({}); 
  const [verifiedItems, setVerifiedItems] = useState<Record<string, boolean>>({}); 
  const [issueReports, setIssueReports] = useState<Record<string, IssueReport>>({}); 
  const [notes, setNotes] = useState('');
  
  // Inputs
  const [oxygenReadings, setOxygenReadings] = useState<Record<string, string>>({});
  const [sealExpirations, setSealExpirations] = useState<Record<string, string>>({}); 
  const [itemExpirations, setItemExpirations] = useState<Record<string, string>>({}); 

  // Temporary State for Issue Modal
  const [currentIssueItem, setCurrentIssueItem] = useState<StatpackItem | null>(null);
  const [tempIssueData, setTempIssueData] = useState<Partial<IssueReport>>({
      issueType: 'missing',
      isReplaced: false,
      replacedQuantity: 1,
      newExpirationDate: '',
      notes: ''
  });

  // --- Auth & Data Fetching ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) setUser(u);
      else router.push('/login');
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
        if (!id || !user) return;
    const fetchPack = async () => {
      try {
        const ref = doc(db, 'statpacks', id);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data();
          const packData = {
             id: snap.id,
             ...data,
             checkedOutAt: getDate(data.checkedOutAt),
             lastCheckedAt: getDate(data.lastCheckedAt),
             compartments: (data.compartments || []).map((c: any) => ({
                 ...c,
                 expirationDate: getDate(c.expirationDate)
             })),
             contents: (data.contents || []).map((i: any) => ({
                 ...i,
                 expirationDate: getDate(i.expirationDate)
             }))
          } as Statpack;

          setPack(packData);

                    // initialize step order when pack loads
                    // (use IDs so order can be mutated independently of the computed `steps` array)
                    setStepOrder((packData.compartments || []).map((c: any) => c.id).concat(
                        (['main', 'front_aux', 'side_left', 'side_right'] as StatpackPocket[])
                            .flatMap(pocket => (packData.contents || []).filter((i: any) => i.pocket === pocket && !i.compartmentId).length > 0 ? [`loose_${pocket}`] : [])
                    ));
          
          // Pre-fill expiration dates
          const initialSealExps: Record<string, string> = {};
          packData.compartments?.forEach(c => {
              if (c.expirationDate) initialSealExps[c.id] = toInputDate(c.expirationDate);
          });
          setSealExpirations(initialSealExps);

          const initialItemExps: Record<string, string> = {};
          packData.contents?.forEach(i => {
              if (i.expirationDate) initialItemExps[i.itemId] = toInputDate(i.expirationDate);
          });
          setItemExpirations(initialItemExps);

        } else {
          setError('Statpack not found.');
        }
      } catch (err) {
        console.error(err);
        setError('Error loading statpack.');
      } finally {
        setLoading(false);
      }
    };
    fetchPack();
  }, [id, user]);

    const steps = useMemo<CheckoutStep[]>(() => {
    if (!pack) return [];
    const _steps: CheckoutStep[] = [];
    if (pack.compartments) {
      pack.compartments.forEach(comp => {
        const itemsInComp = pack.contents?.filter(i => i.compartmentId === comp.id) || [];
        _steps.push({
          id: comp.id,
          name: comp.name,
          type: 'compartment',
          parentPocket: comp.parentPocket,
          isSealed: comp.isSealed,
          sealNumber: comp.sealNumber,
          expirationDate: comp.expirationDate,
          items: itemsInComp
        });
      });
    }
    const pockets: StatpackPocket[] = ['main', 'front_aux', 'side_left', 'side_right'];
    pockets.forEach(pocket => {
       const looseItems = pack.contents?.filter(i => i.pocket === pocket && !i.compartmentId) || [];
       if (looseItems.length > 0) {
         let niceName = 'Main Compartment (Loose)';
         if (pocket === 'front_aux') niceName = 'Front Aux Pocket';
         if (pocket === 'side_left') niceName = 'Left Side Pocket';
         if (pocket === 'side_right') niceName = 'Right Side Pocket';
         _steps.push({
            id: `loose_${pocket}`,
            name: niceName,
            type: 'loose_pocket',
            parentPocket: pocket,
            isSealed: false,
            items: looseItems
         });
       }
    });
    return _steps;
  }, [pack]);

    // Resolve the current step from `stepOrder` index
    const currentStep: CheckoutStep | undefined = useMemo(() => {
        const id = stepOrder[activeStepIndex];
        if (!id) return steps[activeStepIndex];
        return steps.find(s => s.id === id) || steps[activeStepIndex];
    }, [stepOrder, activeStepIndex, steps]);

    // Ensure activeStepIndex is within bounds if stepOrder changes
    useEffect(() => {
        if (stepOrder.length === 0) return;
        if (activeStepIndex >= stepOrder.length) setActiveStepIndex(Math.max(0, stepOrder.length - 1));
    }, [stepOrder, activeStepIndex]);

  // --- Handlers ---

  const handleSealToggle = (compId: string, valid: boolean) => {
    setSealCheck(prev => ({ ...prev, [compId]: valid }));
  };

  const handleVerifyToggle = (itemId: string) => {
      // Logic: If it has an issue, clicking verify clears the issue and verifies it.
      // If it's verified, clicking un-verifies it.
      
      if (issueReports[itemId]) {
          setIssueReports(prev => {
              const copy = { ...prev };
              delete copy[itemId];
              return copy;
          });
          setVerifiedItems(prev => ({ ...prev, [itemId]: true }));
          return;
      }

      setVerifiedItems(prev => {
          const isCurrentlyVerified = !!prev[itemId];
          if (isCurrentlyVerified) {
              const copy = { ...prev };
              delete copy[itemId];
              return copy;
          } else {
              return { ...prev, [itemId]: true };
          }
      });
  };

  const openIssueModal = (item: StatpackItem) => {
      setCurrentIssueItem(item);
      if (issueReports[item.itemId]) {
          setTempIssueData(issueReports[item.itemId]);
      } else {
          setTempIssueData({
              issueType: 'missing',
              isReplaced: false,
              replacedQuantity: item.requiredQuantity || 1,
              newExpirationDate: '',
              notes: ''
          });
      }
      onIssueOpen();
  };

  const saveIssueReport = () => {
      if (!currentIssueItem) return;
      
      const report: IssueReport = {
          itemId: currentIssueItem.itemId,
          itemName: currentIssueItem.itemDetails?.name || 'Unknown Item',
          issueType: tempIssueData.issueType || 'missing',
          isReplaced: tempIssueData.isReplaced || false,
          replacedQuantity: tempIssueData.replacedQuantity || 1,
          newExpirationDate: tempIssueData.newExpirationDate,
          notes: tempIssueData.notes || ''
      };

      setIssueReports(prev => ({ ...prev, [currentIssueItem.itemId]: report }));
      
      // Un-verify if it was verified
      setVerifiedItems(prev => {
          const copy = { ...prev };
          delete copy[currentIssueItem.itemId];
          return copy;
      });

      onIssueChange();
  };

  const handleOxygenChange = (itemId: string, value: string) => {
    setOxygenReadings(prev => ({ ...prev, [itemId]: value }));
  };

  const handleSealExpirationChange = (compId: string, val: string) => {
    setSealExpirations(prev => ({ ...prev, [compId]: val }));
  };

  const handleItemExpirationChange = (itemId: string, val: string) => {
    setItemExpirations(prev => ({ ...prev, [itemId]: val }));
  };

  // --- Navigation & Finish ---

    const handleStepComplete = () => {
        const step = currentStep;
        if (!step) return;
        if (!isStepComplete(step)) {
            alert('Please verify this step before continuing.');
            return;
        }

        setCompletedSteps(prev => new Set(prev).add(step.id));

        // If we're in auto-review mode, jump to the next incomplete step across the dynamic order
        if (autoReviewMode) {
            const nextIncompleteIndex = stepOrder.findIndex(id => {
                const s = steps.find(ss => ss.id === id);
                return !!s && !isStepComplete(s);
            });
            if (nextIncompleteIndex !== -1) {
                setActiveStepIndex(nextIncompleteIndex);
                return;
            }
            // All done
            setAutoReviewMode(false);
            setView('review');
            return;
        }

        if (activeStepIndex < (stepOrder.length || steps.length) - 1) {
            setActiveStepIndex(prev => prev + 1);
        } else {
            setView('review');
        }
    };

  const jumpToPocket = (pocket: StatpackPocket | 'all') => {
    if (pocket === 'all') return;
        // Reorder stepOrder so incomplete steps outside this pocket move to the end
        const pocketIds = steps.filter(s => s.parentPocket === pocket).map(s => s.id);
        if (pocketIds.length === 0) {
            alert('No items configured in this pocket.');
            return;
        }

        const incompleteOtherIds = stepOrder.filter(id => {
            const s = steps.find(ss => ss.id === id);
            return !!s && s.parentPocket !== pocket && !completedSteps.has(id);
        });

        const newOrder = stepOrder.filter(id => !incompleteOtherIds.includes(id)).concat(incompleteOtherIds);
        setStepOrder(newOrder);

        // Jump to first incomplete in pocket within the new order; fall back to pocket's first id
        const firstIncompleteIndex = newOrder.findIndex(id => pocketIds.includes(id) && !isStepComplete(steps.find(s => s.id === id)!));
        if (firstIncompleteIndex !== -1) {
                setActiveStepIndex(firstIncompleteIndex);
                setView('steps');
                if (isMapOpen) onMapChange();
                return;
        }

        const firstIndex = newOrder.findIndex(id => pocketIds.includes(id));
        if (firstIndex !== -1) {
                setActiveStepIndex(firstIndex);
                setView('steps');
                if (isMapOpen) onMapChange();
        }
  };

  const handleFinish = async () => {
    if (!pack || !user) return;
    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      const packRef = doc(db, 'statpacks', pack.id);
      
      // 1. Update Compartment Expirations (Seals) & Sanitize Undefined
      const updatedCompartments = pack.compartments?.map(c => {
          let newExp = c.expirationDate;
          if (sealExpirations[c.id]) {
              newExp = new Date(sealExpirations[c.id]);
          }
          return { 
              ...c, 
              expirationDate: newExp || null, // Convert undefined to null
              sealNumber: c.sealNumber || null 
          };
      }) || [];

      // 2. Update Content Expirations & Sanitize Undefined
      const updatedContents = pack.contents?.map(i => {
          let newExp = i.expirationDate;
          const issue = issueReports[i.itemId];
          
          if (issue && issue.isReplaced && issue.newExpirationDate) {
              newExp = new Date(issue.newExpirationDate);
          } else if (itemExpirations[i.itemId]) {
              newExp = new Date(itemExpirations[i.itemId]);
          }

          return { 
              ...i, 
              expirationDate: newExp || null, // Convert undefined to null
              variantName: i.variantName || null,
              lotNumber: i.lotNumber || null
          };
      }) || [];

      // 3. Determine Status
      const unresolvedIssues = Object.values(issueReports).some(r => !r.isReplaced);
      const status = unresolvedIssues ? 'Restock Needed' : 'In Use';

            // 4. Safe User Name logic: prefer Firestore `users.{uid}.fullName` when available
            let safeUserName = user.displayName || user.email || 'Unknown User';
            try {
                const userRef = doc(db, 'users', user.uid);
                const userSnap = await getDoc(userRef);
                if (userSnap.exists()) {
                    const ud = userSnap.data() as Partial<User> | undefined;
                    if (ud?.fullName) safeUserName = ud.fullName;
                }
            } catch (e) {
                console.warn('Failed to read user profile for name resolution', e);
            }

      batch.update(packRef, {
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: safeUserName,
        checkedOutAt: serverTimestamp(),
        status: status,
        currentEvent: 'Shift Start',
        compartments: updatedCompartments,
        contents: updatedContents
      });

      // 5. Log Entry
      const logRef = doc(collection(db, 'statpack_logs'));
      batch.set(logRef, {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkout',
        userId: user.uid,
        userName: safeUserName,
        timestamp: serverTimestamp(),
        notes: notes,
        issues: {
          sealChecks: sealCheck,
          oxygenReadings,
          issueReports,
          verifiedCount: Object.keys(verifiedItems).length
        }
      });

      // 6. Update Inventory
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

            // For replaced items, prefer decrementing the specific inventory variant/lot that matches the provided expiration date.
            for (const report of Object.values(issueReports)) {
                if (!report.isReplaced || !report.replacedQuantity || report.replacedQuantity <= 0) continue;

                const inventoryRef = doc(db, 'inventory', report.itemId);
                try {
                    const invSnap = await getDoc(inventoryRef);
                    if (!invSnap.exists()) {
                        // fallback: decrement master total
                        batch.update(inventoryRef, { totalStockQuantity: increment(-report.replacedQuantity), updatedAt: serverTimestamp() });
                        continue;
                    }

                    const invData: any = invSnap.data();
                    const variants: any[] = Array.isArray(invData.variants) ? invData.variants.slice() : [];
                    const batches: any[] = Array.isArray(invData.batches) ? invData.batches.slice() : [];
                    let handled = false;

                    // Normalize incoming date (compare only date part)
                    let targetDate: Date | null = null;
                    if (report.newExpirationDate) {
                        try {
                            targetDate = new Date(report.newExpirationDate);
                            if (isNaN(targetDate.getTime())) targetDate = null;
                        } catch (e) {
                            targetDate = null;
                        }
                    }

                    // 1) Prefer adjusting batches (expiration-tracking) when available
                    if (!handled && batches.length > 0 && targetDate) {
                        const sameDay = (a?: any, b?: Date) => {
                            if (!a || !b) return false;
                            const ad = (a instanceof Date) ? a : (a?.toDate ? a.toDate() : new Date(a));
                            return ad.getFullYear() === b.getFullYear() && ad.getMonth() === b.getMonth() && ad.getDate() === b.getDate();
                        };

                        for (let i = 0; i < batches.length; i++) {
                            const b = batches[i];
                            if (sameDay(b.expirationDate, targetDate) || ((b.lotNumber || '') && (report as any).lotNumber && String(b.lotNumber) === String((report as any).lotNumber))) {
                                batches[i] = { ...b, stock: Math.max(0, Number(b.stock ?? 0) - Number(report.replacedQuantity)) };
                                const totalAfter = batches.reduce((acc, bb) => acc + Number(bb.stock ?? 0), 0) + variants.reduce((acc, vv) => acc + Number(vv.stock ?? 0), 0);
                                batch.update(inventoryRef, { batches, totalStockQuantity: totalAfter, updatedAt: serverTimestamp() });
                                handled = true;
                                break;
                            }
                        }
                    }

                    // 2) Legacy: if no batches matched, try matching variant expirations
                    if (!handled && targetDate) {
                        const sameDay = (a?: any, b?: Date) => {
                            if (!a || !b) return false;
                            const ad = (a instanceof Date) ? a : (a?.toDate ? a.toDate() : new Date(a));
                            return ad.getFullYear() === b.getFullYear() && ad.getMonth() === b.getMonth() && ad.getDate() === b.getDate();
                        };

                        for (let i = 0; i < variants.length; i++) {
                            const v = variants[i];
                            if (sameDay(v.expirationDate, targetDate)) {
                                // decrement this variant's stock
                                const newStock = Math.max(0, Number(v.stock ?? 0) - Number(report.replacedQuantity));
                                variants[i] = { ...v, stock: newStock };
                                const totalAfter = (invData.totalStockQuantity ?? 0) - Number(report.replacedQuantity);
                                batch.update(inventoryRef, { variants, totalStockQuantity: totalAfter, updatedAt: serverTimestamp() });
                                handled = true;
                                break;
                            }
                        }
                    }

                    if (!handled) {
                        // No matching batch/variant found; fall back to decrementing master total and optionally set top-level expiration if provided
                        const updatePayload: any = { totalStockQuantity: increment(-report.replacedQuantity), updatedAt: serverTimestamp() };
                        if (report.newExpirationDate) {
                            try {
                                const d = new Date(report.newExpirationDate);
                                if (!isNaN(d.getTime())) updatePayload.expirationDate = d;
                            } catch (e) {}
                        }
                        batch.update(inventoryRef, updatePayload);
                    }
                } catch (err) {
                    console.error('Error resolving inventory for replacement', err);
                    // best-effort fallback
                    batch.update(inventoryRef, { totalStockQuantity: increment(-report.replacedQuantity), updatedAt: serverTimestamp() });
                }
            }

      await batch.commit();
      router.push(`/mobile?id=${pack.id}`); 
    } catch (err) {
      console.error(err);
      alert('Failed to submit checkout. See console for details.');
      setSubmitting(false);
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner size="lg" /></div>;
  if (error) return <div className="p-6 text-center text-red-500">{error}</div>;
  if (!pack) return null;

    const progressVal = (completedSteps.size / (stepOrder.length || steps.length)) * 100;

  const isStepComplete = (step: CheckoutStep) => {
      if (step.isSealed) {
          if (sealCheck[step.id] === undefined) return false;
          if (sealCheck[step.id] === true) return true;
      }

      return step.items.every(item => {
          const isVerified = !!verifiedItems[item.itemId];
          const hasIssue = !!issueReports[item.itemId];
          const isOxygen = item.itemDetails?.isOxygen;

          if (isOxygen && !hasIssue) {
              return isVerified && oxygenReadings[item.itemId] && parseInt(oxygenReadings[item.itemId]) >= 0;
          }
          return isVerified || hasIssue;
      });
  };

  // --- VIEW: INTRO ---
  if (view === 'intro') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-20">
         <div className="bg-white dark:bg-slate-800 px-4 py-3 sticky top-0 z-20 border-b border-gray-200 dark:border-slate-700 shadow-sm flex items-center gap-3">
            <Button isIconOnly variant="light" onPress={() => router.back()} size="sm">
               <ArrowLeft size={20} />
            </Button>
            <div className="flex flex-col">
                <h1 className="text-sm font-bold leading-tight">{pack.name} Checkout</h1>
                <p className="text-[10px] text-gray-500">Tap pocket or start below</p>
            </div>
         </div>

         <div className="p-4 max-w-lg mx-auto">
            <Card className="mb-6 border-none shadow-none bg-transparent overflow-visible">
               <CardBody className="p-0 overflow-visible">
                  <div className="relative pt-12 flex justify-center">
                      <div className="absolute top-0 z-30 animate-bounce left-1/2 transform -translate-x-1/2">
                          <div className="bg-blue-600 text-white text-xs px-4 py-2 rounded-full shadow-lg flex items-center gap-2 font-semibold ring-2 ring-white dark:ring-slate-800 whitespace-nowrap">
                             <Hand size={14} />
                             <span>Tap a pocket to jump!</span>
                          </div>
                      </div>
                      <BagVisualizer statpack={pack} selectedPocket={'all'} onSelectPocket={jumpToPocket} />
                  </div>
               </CardBody>
            </Card>

            <Button size="lg" color="primary" className="w-full font-bold shadow-lg" onPress={() => setView('steps')}>
              Start Linear Checkout
            </Button>
         </div>
      </div>
    );
  }

  // --- VIEW: STEPS ---
  if (view === 'steps') {
    const isSealIntact = currentStep.isSealed && sealCheck[currentStep.id] === true;

    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex flex-col">
        <div className="bg-white dark:bg-slate-800 px-4 py-2 sticky top-0 z-20 border-b border-gray-200 dark:border-slate-700 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-2 overflow-hidden">
                  <Button isIconOnly size="sm" variant="light" onPress={() => setView('intro')}><ArrowLeft size={18}/></Button>
                  <div className="flex flex-col truncate">
                      <span className="font-bold text-sm">Step {activeStepIndex + 1}/{(stepOrder.length || steps.length)}</span>
                      <span className="text-[10px] text-gray-500 truncate">{currentStep?.name}</span>
                  </div>
               </div>
           <div className="flex gap-2 shrink-0">
               <Button size="sm" variant="flat" color="secondary" onPress={onMapOpen} startContent={<MapIcon size={14}/>}>Map</Button>
               <Button size="sm" variant="flat" onPress={() => {
                   const firstIncomplete = stepOrder.findIndex(id => {
                       const s = steps.find(ss => ss.id === id);
                       return !!s && !isStepComplete(s);
                   });
                   if (firstIncomplete !== -1) {
                       // Enter auto-review mode: jump to first incomplete and automatically walk remaining steps
                       setAutoReviewMode(true);
                       setActiveStepIndex(firstIncomplete);
                       setView('steps');
                   } else {
                       setView('review');
                   }
               }}>Review</Button>
           </div>
        </div>
        
        <Progress size="sm" value={progressVal} color="success" aria-label="Progress" className="rounded-none"/>

        <div className="flex-1 overflow-y-auto p-4 max-w-lg mx-auto w-full pb-32">
           <div className="flex justify-between items-start mb-4">
               <div>
                    <h2 className="text-xl font-bold mb-1">{currentStep.name}</h2>
                    <p className="text-gray-500 text-sm flex items-center gap-2">
                        {currentStep.type === 'compartment' ? <Layers size={14}/> : <Package size={14}/>}
                        {currentStep.type === 'compartment' ? 'Sealed Compartment' : 'Loose Items'}
                    </p>
               </div>
               {currentStep.parentPocket && (
                   <Chip size="sm" variant="flat" color="primary" className="capitalize">
                       {currentStep.parentPocket.replace('_', ' ')}
                   </Chip>
               )}
           </div>

           {/* SEAL CHECK */}
           {currentStep.isSealed && (
              <Card className={`mb-6 border-l-4 ${sealCheck[currentStep.id] === true ? 'border-l-green-500 bg-green-100 dark:bg-green-900/20' : 'border-l-amber-500'}`}>
                 <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-row items-center justify-between">
                        <div>
                           <div className="font-bold text-foreground flex items-center gap-2">
                              {sealCheck[currentStep.id] === true ? <Lock className="text-green-600"/> : <Unlock className="text-amber-600"/>}
                              Seal Status
                           </div>
                           <div className="text-xs text-gray-500">Exp: {currentStep.sealNumber || 'N/A'}</div>
                        </div>
                        <div className="flex gap-2">
                           <Button size="sm" color={sealCheck[currentStep.id] === false ? "danger" : "default"} variant={sealCheck[currentStep.id] === false ? "solid" : "bordered"} onPress={() => handleSealToggle(currentStep.id, false)}>Broken</Button>
                           <Button size="sm" color={sealCheck[currentStep.id] === true ? "success" : "default"} variant={sealCheck[currentStep.id] === true ? "solid" : "bordered"} onPress={() => handleSealToggle(currentStep.id, true)}>Intact</Button>
                        </div>
                    </div>
                    {sealCheck[currentStep.id] === true && (
                        <p className="text-xs text-green-700 font-semibold flex items-center gap-1">
                            <CheckCircle2 size={12}/> Contents Verified via Seal
                        </p>
                    )}
                    
                    <Divider />
                    <div>
                        <div className="text-xs font-semibold text-gray-500 mb-1 flex items-center gap-1"><CalendarDays size={12} /> Seal Expiration</div>
                        <Input type="date" size="sm" aria-label="Seal Expiration" value={sealExpirations[currentStep.id] || ''} onValueChange={(val) => handleSealExpirationChange(currentStep.id, val)} />
                    </div>
                 </CardBody>
              </Card>
           )}

           {/* ITEMS LIST */}
           {(!currentStep.isSealed || !isSealIntact) ? (
               <div className="space-y-3">
                  {currentStep.items.map(item => {
                     const hasIssue = !!issueReports[item.itemId];
                     const isVerified = verifiedItems[item.itemId] && !hasIssue;
                     const isOxygen = item.itemDetails?.isOxygen;
                     const tracksExpiration = item.itemDetails?.tracksExpiration;

                     return (
                        <div 
                            key={item.itemId} 
                            onClick={() => handleVerifyToggle(item.itemId)}
                            className="cursor-pointer"
                        >
                            <Card 
                                className={`border-2 transition-all relative group ${
                                    hasIssue ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/10' : 
                                    isVerified ? 'border-green-500 bg-green-50 dark:bg-green-900/10' : 
                                    'border-gray-200 dark:border-slate-700 hover:border-gray-300'
                                }`}
                            >
                               <CardBody className="flex flex-row items-start justify-between p-3 gap-3">
                                  <div className="flex-1">
                                     <div className="font-bold text-sm flex items-center gap-2">
                                        {item.itemDetails?.name}
                                        {isOxygen && <Chip size="sm" color="primary" variant="flat" startContent={<Wind size={10}/>} className="h-5 text-[10px]">O2</Chip>}
                                     </div>
                                     {item.variantName && <div className="text-[10px] text-gray-400">Var: {item.variantName}</div>}
                                     <div className="text-xs text-gray-500 mt-1">Qty: {item.requiredQuantity} {item.itemDetails?.unit}</div>

                                     {hasIssue && (
                                         <div className="mt-2 text-xs text-amber-700 bg-amber-100 dark:bg-amber-900/30 p-1.5 rounded-lg inline-block border border-amber-200 dark:border-amber-800">
                                             <div className="font-bold flex items-center gap-1 uppercase">
                                                 <AlertTriangle size={10}/> {issueReports[item.itemId].issueType}
                                             </div>
                                             {issueReports[item.itemId].isReplaced && <div className="mt-0.5 ml-3.5">Replaced (+{issueReports[item.itemId].replacedQuantity})</div>}
                                         </div>
                                     )}

                                     {/* Input wrapper with w-fit */}
                                     {!hasIssue && tracksExpiration && (
                                        <div className="mt-3 w-fit" onClick={(e) => e.stopPropagation()}>
                                            <div className="text-[10px] uppercase text-gray-400 font-bold mb-1 flex items-center gap-1"><ThermometerSnowflake size={10} /> Earliest Expiration</div>
                                            <Input type="date" size="sm" variant="faded" aria-label="Item Expiration" value={itemExpirations[item.itemId] || ''} onValueChange={(val) => handleItemExpirationChange(item.itemId, val)} className="max-w-[160px]" />
                                        </div>
                                     )}

                                     {/* Input wrapper with w-fit */}
                                     {isOxygen && !hasIssue && (
                                        <div className="mt-3 w-fit max-w-[150px]" onClick={(e) => e.stopPropagation()}>
                                            <div className="text-[10px] uppercase text-gray-400 font-bold mb-1">Current Level</div>
                                            <Input type="number" size="sm" label="PSI" placeholder="0" variant="faded" startContent={<Wind size={14} className="text-gray-400"/>} value={oxygenReadings[item.itemId] || ''} onValueChange={(val) => handleOxygenChange(item.itemId, val)} color={parseInt(oxygenReadings[item.itemId]) < 500 ? "danger" : parseInt(oxygenReadings[item.itemId]) < 1000 ? "warning" : "success"} isRequired />
                                        </div>
                                     )}
                                  </div>

                                  <div className="flex flex-col items-center gap-3">
                                     <div className={`p-1.5 rounded-full transition-colors ${isVerified ? 'text-green-600 bg-green-200 dark:bg-green-800' : 'text-gray-300 dark:text-gray-600'}`}>
                                        <CheckCircle2 size={28} />
                                     </div>
                                     
                                     <div onClick={(e) => e.stopPropagation()}>
                                        <Button 
                                            isIconOnly size="sm" 
                                            color={hasIssue ? "warning" : "default"} 
                                            variant={hasIssue ? "solid" : "light"} 
                                            onPress={() => openIssueModal(item)}
                                            className="opacity-60 hover:opacity-100"
                                        >
                                            <AlertTriangle size={18} />
                                        </Button>
                                     </div>
                                  </div>
                               </CardBody>
                            </Card>
                        </div>
                     );
                  })}
               </div>
           ) : (
               <div className="flex flex-col items-center justify-center py-10 text-gray-400 bg-gray-100/50 dark:bg-slate-800/50 rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700">
                   <Lock size={48} className="mb-2 opacity-50" />
                   <p className="font-semibold">Compartment Sealed</p>
                   <p className="text-xs">Individual item verification skipped.</p>
               </div>
           )}
        </div>

        {/* BOTTOM NAV */}
        <div className="p-4 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 fixed bottom-0 left-0 right-0 z-20 shadow-xl">
            <div className="max-w-lg mx-auto flex gap-3">
               <Button fullWidth variant="bordered" isDisabled={activeStepIndex === 0} onPress={() => setActiveStepIndex(prev => prev - 1)}>Back</Button>
                             <Button fullWidth color="primary" onPress={handleStepComplete} isDisabled={!isStepComplete(currentStep)}>
                 {activeStepIndex === steps.length - 1 ? 'Review' : 'Next Step'}
               </Button>
            </div>
        </div>

        {/* MAP MODAL */}
        <Modal isOpen={isMapOpen} onOpenChange={onMapChange} placement="center" size="full" classNames={{ base: "m-0 rounded-none h-full", header: "border-b border-gray-200 dark:border-slate-700", body: "p-4 bg-gray-50 dark:bg-slate-900" }}>
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1"><h3>Jump to Pocket</h3></ModalHeader>
                        <ModalBody className="flex items-center justify-center">
                             <BagVisualizer statpack={pack} selectedPocket={'all'} onSelectPocket={jumpToPocket} />
                        </ModalBody>
                        <ModalFooter><Button color="danger" variant="light" onPress={onClose}>Close Map</Button></ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>

        {/* ISSUE REPORT MODAL */}
        <Modal isOpen={isIssueOpen} onOpenChange={onIssueChange} placement="center" size="sm" backdrop="blur">
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader>Report Issue: {currentIssueItem?.itemDetails?.name}</ModalHeader>
                        <ModalBody>
                            <p className="text-sm text-gray-500 mb-2">What is wrong with this item?</p>
                            <RadioGroup 
                                value={tempIssueData.issueType} 
                                onValueChange={(val: string) => setTempIssueData(prev => ({...prev, issueType: val as IssueReport['issueType']}))}
                            >
                                <Radio value="missing" description="Item is not in the bag">Missing / Not Found</Radio>
                                <Radio value="expired" description="Expiration date passed">Expired</Radio>
                                <Radio value="damaged" description="Broken or open seal">Damaged / Compromised</Radio>
                                <Radio value="other">Other Issue</Radio>
                            </RadioGroup>

                            <Divider className="my-2"/>

                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="font-bold text-sm">Did you replace it?</span>
                                    <span className="text-xs text-gray-500">Available from inventory</span>
                                </div>
                                <Switch 
                                    isSelected={tempIssueData.isReplaced} 
                                    onValueChange={(val) => setTempIssueData(prev => ({...prev, isReplaced: val}))}
                                />
                            </div>

                            {tempIssueData.isReplaced && (
                                <div className="mt-2 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-100 dark:border-blue-800 space-y-3">
                                    <div>
                                        <Input 
                                            type="number" 
                                            label="Quantity Replaced" 
                                            placeholder="1" 
                                            size="sm"
                                            variant="bordered"
                                            value={tempIssueData.replacedQuantity?.toString()}
                                            onValueChange={(v) => setTempIssueData(prev => ({...prev, replacedQuantity: parseInt(v) || 0}))}
                                        />
                                        <p className="text-[10px] text-blue-600 mt-1 flex items-center gap-1"><AlertOctagon size={10}/> Stock will be automatically deducted.</p>
                                    </div>

                                    {currentIssueItem?.itemDetails?.tracksExpiration && (
                                        <Input 
                                            type="date"
                                            label="New Item Expiration"
                                            size="sm"
                                            variant="bordered"
                                            color="primary"
                                            value={tempIssueData.newExpirationDate}
                                            onValueChange={(v) => setTempIssueData(prev => ({...prev, newExpirationDate: v}))}
                                            isRequired
                                        />
                                    )}
                                </div>
                            )}

                            <Textarea 
                                label="Notes" 
                                placeholder="Details..." 
                                minRows={2}
                                value={tempIssueData.notes} 
                                onValueChange={(v) => setTempIssueData(prev => ({...prev, notes: v}))} 
                            />
                        </ModalBody>
                        <ModalFooter>
                            <Button variant="light" color="danger" onPress={onClose}>Cancel</Button>
                            <Button color="warning" onPress={saveIssueReport} className="font-bold shadow-md">Log Issue</Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>

      </div>
    );
  }

  // --- VIEW: REVIEW ---
    if (view === 'review') {
        const issueCount = Object.keys(issueReports).length;
        const unresolved = Object.values(issueReports).filter(r => !r.isReplaced).length;
        const allStepsVerified = (stepOrder.length || steps.length) > 0 ? (stepOrder.length ? stepOrder.every(id => {
            const s = steps.find(ss => ss.id === id);
            return !!s && isStepComplete(s);
        }) : steps.every(isStepComplete)) : true;
        const remaining = (stepOrder.length ? stepOrder.filter(id => {
            const s = steps.find(ss => ss.id === id);
            return !!s && !isStepComplete(s);
        }).length : steps.filter(s => !isStepComplete(s)).length);

        return (
       <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-6 pb-24">
          <div className="max-w-lg mx-auto">
             <Button isIconOnly variant="light" onPress={() => setView('steps')} className="mb-4"><ArrowLeft /></Button>
             <h1 className="text-2xl font-bold mb-6">Review Checkout</h1>
             
             {issueCount > 0 ? (
                <div className={`p-4 rounded-xl mb-6 border ${unresolved > 0 ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                   <div className="flex items-center gap-2 font-bold mb-2">
                      <AlertTriangle />
                      <span>{issueCount} Issues Reported</span>
                   </div>
                   <div className="text-sm space-y-2">
                       {Object.values(issueReports).map(issue => (
                           <div key={issue.itemId} className="flex justify-between border-b border-black/5 pb-1">
                               <span>{issue.itemName} ({issue.issueType})</span>
                               <span className={`font-bold ${issue.isReplaced ? 'text-green-600' : 'text-red-600'}`}>{issue.isReplaced ? 'Replaced' : 'Not Replaced'}</span>
                           </div>
                       ))}
                   </div>
                   {unresolved > 0 ? <p className="text-xs mt-3 font-bold">Pack Status: Restock Needed</p> : <p className="text-xs mt-3 font-bold text-green-700">All issues resolved. Pack Status: In Use</p>}
                </div>
             ) : (
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 p-4 rounded-xl mb-6">
                   <div className="flex items-center gap-2 text-green-600 font-bold mb-2"><CheckCircle2 /><span>All Items Verified</span></div>
                   <p className="text-sm text-gray-600 dark:text-gray-300">Pack is ready for service.</p>
                </div>
             )}

                 <Textarea label="Shift Notes" placeholder="Any damage or comments?" value={notes} onValueChange={setNotes} className="mb-6" />

                 {!allStepsVerified && (
                     <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded">
                         {remaining} step(s) remain incomplete. Please finish verification before completing checkout.
                     </div>
                 )}

                 <Button 
                     size="lg" 
                     color={unresolved > 0 ? "warning" : "success"} 
                     className="w-full font-bold shadow-lg"
                     onPress={() => {
                          if (!allStepsVerified) {
                                const firstIncomplete = steps.findIndex(s => !isStepComplete(s));
                                if (firstIncomplete !== -1) {
                                     setActiveStepIndex(firstIncomplete);
                                     setView('steps');
                                }
                                alert('Please complete all verification steps before finalizing checkout.');
                                return;
                          }
                          handleFinish();
                     }}
                     isLoading={submitting}
                     isDisabled={!allStepsVerified}
                 >
                     {unresolved > 0 ? 'Submit Report (Needs Restock)' : 'Complete Checkout'}
                 </Button>
          </div>
       </div>
    );
  }

  return null;
}