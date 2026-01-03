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
import MapModal from '@/app/components/MapModal';
import IssueModal from '@/app/components/IssueModal';
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
    const [completedPockets, setCompletedPockets] = useState<Set<StatpackPocket>>(new Set());
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
    // AED-specific checks collected during checkout (keyed by itemId)
    const [aedChecks, setAedChecks] = useState<Record<string, {
        powerOn?: boolean;
        padsSealed?: boolean;
        padExpiration?: string;
        batteryExpiration?: string;
        notes?: string;
    }>>({});

  
  
  // Inputs
  const [oxygenReadings, setOxygenReadings] = useState<Record<string, string>>({});
  const [sealExpirations, setSealExpirations] = useState<Record<string, string>>({}); 
  const [itemExpirations, setItemExpirations] = useState<Record<string, string>>({}); 
  const [expirationMismatches, setExpirationMismatches] = useState<Record<string, { entered?: string; system?: string; acknowledged?: boolean }>>({});
  const [stepProblems, setStepProblems] = useState<string[] | null>(null);
  // Modal state for expiration mismatch: derive visibility from this data (null = closed)
  const [mismatchModalData, setMismatchModalData] = useState<{ itemId?: string; entered?: string; system?: string } | null>(null);
  // Debugging UI toggle
  const [debugOpen, setDebugOpen] = useState(false);
  // Acknowledge confirmation data for mismatches
  const [ackConfirm, setAckConfirm] = useState<{ key: string; entered: string; system: string } | null>(null);

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

                    // initialize step order when pack loads - now using pocket IDs directly
                    const pocketsWithContent: StatpackPocket[] = [];
                    (['main', 'front_aux', 'side_left', 'side_right'] as StatpackPocket[]).forEach(pocket => {
                      const hasCompartments = (packData.compartments || []).some((c: any) => c.parentPocket === pocket);
                      const hasLooseItems = (packData.contents || []).some((i: any) => i.pocket === pocket && !i.compartmentId);
                      if (hasCompartments || hasLooseItems) {
                        pocketsWithContent.push(pocket);
                      }
                    });
                    setStepOrder(pocketsWithContent);
          
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
    
    // Group by pocket: combine sealed compartments and loose items into one step per pocket
    const pockets: StatpackPocket[] = ['main', 'front_aux', 'side_left', 'side_right'];
    pockets.forEach(pocket => {
      // Get all compartments in this pocket
      const compartments = pack.compartments?.filter(c => c.parentPocket === pocket) || [];
      // Get all loose items in this pocket (not in any compartment)
      const looseItems = pack.contents?.filter(i => i.pocket === pocket && !i.compartmentId) || [];
      
      // Skip if pocket is empty
      if (compartments.length === 0 && looseItems.length === 0) return;
      
      // Collect all items from compartments
      const compartmentItems = compartments.flatMap(comp => 
        pack.contents?.filter(i => i.compartmentId === comp.id) || []
      );
      
      // Combine all items in this pocket
      const allItems = [...compartmentItems, ...looseItems];
      
      // Determine pocket name
      let niceName = 'Main Compartment';
      if (pocket === 'front_aux') niceName = 'Front Aux Pocket';
      if (pocket === 'side_left') niceName = 'Left Side Pocket';
      if (pocket === 'side_right') niceName = 'Right Side Pocket';
      
      _steps.push({
        id: pocket,
        name: niceName,
        type: 'compartment', // Use 'compartment' type even if it has loose items
        parentPocket: pocket,
        isSealed: false, // Will be handled per compartment in the UI
        items: allItems
      });
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

  const handleAedToggle = (itemId: string, field: 'powerOn' | 'padsSealed', val: boolean) => {
      setAedChecks(prev => {
          const nextForItem = { ...(prev[itemId] || {}), [field]: val } as any;
          const next = { ...prev, [itemId]: nextForItem };
          // mark item as verified only when basic AED checks are true
          setVerifiedItems(prevV => ({ ...prevV, [itemId]: !!(nextForItem.powerOn && nextForItem.padsSealed) }));
          return next;
      });
  };

  const handleAedExpirationChange = async (itemId: string, field: 'padExpiration' | 'batteryExpiration', val: string) => {
    // First set the value
    setAedChecks(prev => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [field]: val } }));
    // Check for expiration mismatch with inventory data
    if (!val) return;
    const entered = val || '';
    const packItem = pack?.contents?.find((i: any) => i.itemId === itemId);

    const openMismatchForSystem = (systemVal?: string) => {
      if (systemVal && entered !== systemVal) {
        // Record an inline mismatch (keyed by item_field) so we can show a popup near the input.
        // Mark as unacknowledged initially so it blocks completion until the user explicitly acknowledges.
        setExpirationMismatches(prev => ({ ...prev, [`${itemId}_${field}`]: { entered, system: systemVal, acknowledged: false } }));
        return true;
      }
      return false;
    };

    // 1) Prefer asset data included on the pack item (fast-path)
    try {
      const assetInstanceFromPack = packItem?.itemDetails?.assets?.find((asset: any) => {
        return (packItem?.serialNumber && asset.serial === packItem.serialNumber) || (asset.assignedToId === pack?.id);
      });
      const systemExpirationFromPack = assetInstanceFromPack ? (field === 'padExpiration' ? assetInstanceFromPack.padExpiration : assetInstanceFromPack.batteryExpiration) : undefined;
      const systemValFromPack = systemExpirationFromPack ? toInputDate(getDate(systemExpirationFromPack)) : '';
      if (openMismatchForSystem(systemValFromPack)) return;
    } catch (err) {
      // fall through to inventory lookup
    }

    // 2) If pack doesn't include asset instances, fetch inventory doc for this item and look for the asset instance
    try {
      const inventoryRef = doc(db, 'inventory', itemId);
      const invSnap = await getDoc(inventoryRef);
      if (invSnap.exists()) {
        const inv = invSnap.data() as any;
        const assets = Array.isArray(inv.assets) ? inv.assets : Array.isArray(inv.assetInstances) ? inv.assetInstances : [];
        const assetInstance = assets.find((asset: any) => {
          return (packItem?.serialNumber && asset.serial === packItem.serialNumber) || (asset.assignedToId === pack?.id);
        });
        const systemExpiration = assetInstance ? (field === 'padExpiration' ? assetInstance.padExpiration : assetInstance.batteryExpiration) : undefined;
        const systemVal = systemExpiration ? toInputDate(getDate(systemExpiration)) : '';
        if (openMismatchForSystem(systemVal)) return;
      }
    } catch (err) {
      console.warn('Failed to lookup inventory asset for AED expiration mismatch check', err);
    }
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
    // If this is a critical item (AED or epipen), validate against system value and prompt user
    const findPackItem = () => pack?.contents?.find((i: any) => i.itemId === itemId) as any | undefined;
    const isCriticalItem = (it: any) => {
      if (!it) return false;
      if (it.itemDetails?.assetCategory === 'AED') return true;
      const name = String(it.itemDetails?.name || it.itemDetails?.displayName || it.itemName || '').toLowerCase();
      if (name.includes('epi') || name.includes('epipen') || name.includes('epinephrine')) return true;
      return false;
    };

    const packItem = findPackItem();
    if (packItem && isCriticalItem(packItem) && val) {
      const systemVal = packItem.expirationDate ? toInputDate(getDate(packItem.expirationDate)) : '';
      const entered = val || '';
      // Instead of blocking with a modal, record a mismatch and show inline popup but allow continuation
        if (systemVal && entered !== systemVal) {
        setItemExpirations(prev => ({ ...prev, [itemId]: entered }));
        // Unacknowledged mismatch by default
        setExpirationMismatches(prev => ({ ...prev, [itemId]: { entered, system: systemVal, acknowledged: false } }));
        return;
      }
    }

    // Default behavior: just set the value and clear any mismatch if it now matches
    setItemExpirations(prev => ({ ...prev, [itemId]: val }));
    if (pack) {
      const pi = pack.contents?.find((i: any) => i.itemId === itemId);
      const sys = pi?.expirationDate ? toInputDate(getDate(pi.expirationDate)) : '';
      if (sys && sys === val) {
        setExpirationMismatches(prev => {
          const copy = { ...prev };
          delete copy[itemId];
          return copy;
        });
      }
    }
  };

  const handleMismatchRecheck = () => {
    const itemId = mismatchModalData?.itemId;
    if (itemId) {
      // Check if this is an AED expiration mismatch (contains underscore)
      if (itemId.includes('_')) {
        const [actualItemId, field] = itemId.split('_');
        setAedChecks(prev => ({ ...prev, [actualItemId]: { ...(prev[actualItemId] || {}), [field]: '' } }));
      } else {
        // Regular item expiration mismatch
        setItemExpirations(prev => ({ ...prev, [itemId]: '' }));
        setExpirationMismatches(prev => {
          const copy = { ...prev };
          delete copy[itemId];
          return copy;
        });
      }
    }
    setMismatchModalData(null);
  };

  const handleMismatchProceed = () => {
    const itemId = mismatchModalData?.itemId;
    const entered = mismatchModalData?.entered || '';
    const system = mismatchModalData?.system || '';
    if (itemId) {
      // Check if this is an AED expiration mismatch (contains underscore)
      if (itemId.includes('_')) {
        const [actualItemId, field] = itemId.split('_');
        // For AED mismatches, we don't need to track them in expirationMismatches
        // since they're already stored in aedChecks. Mark acknowledged when proceeding.
        setAedChecks(prev => ({ ...prev, [actualItemId]: { ...(prev[actualItemId] || {}), [field]: entered } }));
        setExpirationMismatches(prev => ({ ...prev, [itemId]: { entered, system, acknowledged: true } }));
      } else {
        // Regular item expiration mismatch
        setExpirationMismatches(prev => ({ ...prev, [itemId]: { entered, system, acknowledged: true } }));
        setItemExpirations(prev => ({ ...prev, [itemId]: entered }));
      }
    }
    setMismatchModalData(null);
  };

  // --- Navigation & Finish ---

    const handleStepComplete = () => {
        const step = currentStep;
        if (!step) return;
        if (!isStepComplete(step)) {
          // Collect problems and show modal so user can correct them
          const problems: string[] = [];
          // Check compartments
          const compartmentsInPocket = pack.compartments?.filter(c => c.parentPocket === step.parentPocket) || [];
          for (const comp of compartmentsInPocket) {
            if (comp.isSealed && sealCheck[comp.id] === undefined) {
              problems.push(`Seal not checked for ${comp.name}`);
            }
            const compItems = step.items.filter(i => i.compartmentId === comp.id);
            for (const it of compItems) {
              const reasons = getItemFailureReasons(it);
              reasons.forEach(r => problems.push(`${it.itemDetails?.name || it.itemName}: ${r}`));
            }
          }
          // Loose items
          const looseItems = step.items.filter(i => !i.compartmentId);
          for (const it of looseItems) {
            const reasons = getItemFailureReasons(it);
            reasons.forEach(r => problems.push(`${it.itemDetails?.name || it.itemName}: ${r}`));
          }

          if (problems.length === 0) problems.push('Step incomplete — please verify items.');
          setStepProblems(problems);
          return;
        }

        setCompletedSteps(prev => new Set(prev).add(step.id));
        // Always return to the pocket-selection screen after completing a pocket.
        const pocket = step.parentPocket;
        const newCompleted = new Set(completedSteps);
        newCompleted.add(step.id);

        const pocketStepIds = steps.filter(s => s.parentPocket === pocket).map(s => s.id);
        const pocketIsComplete = pocketStepIds.length > 0 && pocketStepIds.every(id => newCompleted.has(id));

        if (pocketIsComplete) {
            setCompletedPockets(prev => new Set(prev).add(pocket));
        }

        // Return to pocket selection UI so user can pick next pocket.
        setView('intro');
        return;
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
                    verifiedCount: Object.keys(verifiedItems).length,
                    aedChecks,
                    expirationMismatches
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
                        // top-level expiration is no longer used; ignore any provided newExpirationDate
                        batch.update(inventoryRef, updatePayload);
                    }
                } catch (err) {
                    console.error('Error resolving inventory for replacement', err);
                    // best-effort fallback
                    batch.update(inventoryRef, { totalStockQuantity: increment(-report.replacedQuantity), updatedAt: serverTimestamp() });
                }
            }

            // 7. Update inventory asset assignments for AEDs: set assignedToId/name and update pad/battery expirations
            try {
              const aedContents = (updatedContents || []).filter((c: any) => c.itemDetails?.isAsset && c.itemDetails?.assetCategory === 'AED');
              for (const content of aedContents) {
                try {
                  const inventoryRef = doc(db, 'inventory', content.itemId);
                  const invSnap = await getDoc(inventoryRef);
                  if (!invSnap.exists()) continue;
                  const invData: any = invSnap.data();
                  const assets: any[] = Array.isArray(invData.assets) ? invData.assets.slice() : Array.isArray(invData.assetInstances) ? invData.assetInstances.slice() : [];
                  const serial = content.serialNumber || '';
                  let changed = false;
                  for (let i = 0; i < assets.length; i++) {
                    const a = assets[i] || {};
                    if ((serial && a.serial === serial) || a.assignedToId === pack.id || !serial) {
                      const next = { ...a, assignedToId: pack.id, currentLocation: pack.name } as any;
                      const checks = aedChecks[content.itemId] || {};
                      if (checks.padExpiration) next.padExpiration = new Date(checks.padExpiration);
                      if (checks.batteryExpiration) next.batteryExpiration = new Date(checks.batteryExpiration);
                      assets[i] = next;
                      changed = true;
                    }
                  }
                  if (changed) {
                    const updatePayload: any = { assets, updatedAt: serverTimestamp() };
                    // If the inventory item itself is a single asset (isAsset) and the serial matches, update top-level assignedToId as well
                    if (invData.isAsset) {
                      const shouldAssignTopLevel = (!!invData.assetSerial && invData.assetSerial === serial) || (!serial && (assets.length === 1));
                      if (shouldAssignTopLevel) updatePayload.assignedToId = pack.id;
                    }
                    batch.update(inventoryRef, updatePayload);
                  }
                } catch (err) {
                  console.warn('Failed to update inventory asset assignment for AED', content.itemId, err);
                }
              }
            } catch (err) {
              console.warn('AED inventory assignment pass failed', err);
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
      if (debugOpen) {
        console.debug('isStepComplete start', { stepId: step.id, currentStep: currentStep?.id, sealCheck, verifiedItems, aedChecks, itemExpirations, expirationMismatches });
      }
      // Get all compartments in this pocket
      const compartmentsInPocket = pack.compartments?.filter(c => c.parentPocket === step.parentPocket) || [];
      
      // Check each sealed compartment
      for (const comp of compartmentsInPocket) {
          if (comp.isSealed) {
              if (sealCheck[comp.id] === undefined) return false;
              // If sealed and intact, skip item verification for that compartment
              if (sealCheck[comp.id] === true) continue;
          }
          
          // If compartment seal is broken or not sealed, verify items in compartment
          const compItems = step.items.filter(i => i.compartmentId === comp.id);
          const allVerified = compItems.every(item => {
              const isVerified = !!verifiedItems[item.itemId];
              const hasIssue = !!issueReports[item.itemId];
              const isOxygen = item.itemDetails?.isOxygen;
              const isAED = item.itemDetails?.isAsset && item.itemDetails?.assetCategory === 'AED';

              if (isAED && !hasIssue) {
                  const checks = aedChecks[item.itemId];
                  if (!checks) return false;
                  if (!checks.powerOn) return false;
                  if (!checks.padsSealed) return false;
                  // Require pad and battery expirations (or an acknowledged mismatch)
                  const padKey = `${item.itemId}_padExpiration`;
                  const batKey = `${item.itemId}_batteryExpiration`;
                    if (!checks.padExpiration && !expirationMismatches[padKey]?.acknowledged) return false;
                    if (!checks.batteryExpiration && !expirationMismatches[batKey]?.acknowledged) return false;
                    if (checks.padExpiration) {
                      if (!isExpirationValid(checks.padExpiration) && !expirationMismatches[padKey]?.acknowledged) return false;
                    }
                    if (checks.batteryExpiration) {
                      if (!isExpirationValid(checks.batteryExpiration) && !expirationMismatches[batKey]?.acknowledged) return false;
                    }
                  return true;
              }

              if (isOxygen && !hasIssue) {
                  return isVerified && oxygenReadings[item.itemId] && parseInt(oxygenReadings[item.itemId]) >= 0;
              }

              const requiresExpCheck = !!((item as any).requiresExpirationCheck || item.itemDetails?.requiresExpirationCheck);
                if (requiresExpCheck) {
                  const entered = itemExpirations[item.itemId];
                  const system = item.itemDetails?.expirationDate ? toInputDate(getDate(item.itemDetails.expirationDate)) : '';
                  const mismatchAcknowledged = !!expirationMismatches[item.itemId]?.acknowledged;
                  // Require that the user provides an expiration or acknowledges a mismatch
                  if (!entered && !mismatchAcknowledged) return false;
                  // If entered and system present, it must match, otherwise require explicit acknowledgement
                  const enteredMatches = !!entered && !!system && entered === system;
                  if (enteredMatches || mismatchAcknowledged) return true;
                  return false;
                }

              return isVerified || hasIssue;
          });
          
          if (!allVerified) return false;
      }
      
      // Check loose items in this pocket
      const looseItems = step.items.filter(i => !i.compartmentId);
        const looseOk = looseItems.every(item => {
          const isVerified = !!verifiedItems[item.itemId];
          const hasIssue = !!issueReports[item.itemId];
          const isOxygen = item.itemDetails?.isOxygen;
          const isAED = item.itemDetails?.isAsset && item.itemDetails?.assetCategory === 'AED';

          if (isAED && !hasIssue) {
              const checks = aedChecks[item.itemId];
              if (!checks) return false;
              if (!checks.powerOn) return false;
              if (!checks.padsSealed) return false;
              // Require pad and battery expirations (or an acknowledged mismatch)
              const padKey = `${item.itemId}_padExpiration`;
              const batKey = `${item.itemId}_batteryExpiration`;
                if (!checks.padExpiration && !expirationMismatches[padKey]?.acknowledged) return false;
                if (!checks.batteryExpiration && !expirationMismatches[batKey]?.acknowledged) return false;
                if (checks.padExpiration) {
                  if (!isExpirationValid(checks.padExpiration) && !expirationMismatches[padKey]?.acknowledged) return false;
                }
                if (checks.batteryExpiration) {
                  if (!isExpirationValid(checks.batteryExpiration) && !expirationMismatches[batKey]?.acknowledged) return false;
                }
              // AED passes
              return true;
          }

            if (isOxygen && !hasIssue) {
              return isVerified && oxygenReadings[item.itemId] && parseInt(oxygenReadings[item.itemId]) >= 0;
            }

            // If this item requires expiration confirmation, allow completion when either:
            // - the user explicitly verified the item, OR
            // - an issue was reported for it, OR
            // - the user proceeded despite an expiration mismatch (logged in `expirationMismatches`), OR
            // - the entered expiration matches the system expiration
            const requiresExpCheck = !!((item as any).requiresExpirationCheck || item.itemDetails?.requiresExpirationCheck);
            if (requiresExpCheck) {
              const entered = itemExpirations[item.itemId];
              const system = item.itemDetails?.expirationDate ? toInputDate(getDate(item.itemDetails.expirationDate)) : '';
              const mismatchAcknowledged = !!expirationMismatches[item.itemId]?.acknowledged;
              const enteredMatches = !!entered && !!system && entered === system;
              return isVerified || hasIssue || mismatchAcknowledged || enteredMatches;
            }

            return isVerified || hasIssue;
        });
        if (debugOpen) console.debug('isStepComplete result', { stepId: step.id, looseOk });
        return looseOk;
  };

    // Debug helper: returns array of failure reasons for a given item (empty = passes)
    const getItemFailureReasons = (item: StatpackItem) => {
      const reasons: string[] = [];
      const hasIssue = !!issueReports[item.itemId];
      const isVerified = !!verifiedItems[item.itemId];
      const isOxygen = item.itemDetails?.isOxygen;
      const isAED = item.itemDetails?.isAsset && item.itemDetails?.assetCategory === 'AED';

      if (hasIssue) return reasons;

      if (isAED) {
        const checks = aedChecks[item.itemId];
        if (!checks) {
          reasons.push('AED checks not performed');
          return reasons;
        }
        if (!checks.powerOn) reasons.push('Power not checked/failed');
        if (!checks.padsSealed) reasons.push('Pads not sealed');
        if (checks.padExpiration && !isExpirationValid(checks.padExpiration) && !expirationMismatches[`${item.itemId}_padExpiration`]?.acknowledged) reasons.push(`Pad expired or mismatch (${checks.padExpiration})`);
        if (checks.batteryExpiration && !isExpirationValid(checks.batteryExpiration) && !expirationMismatches[`${item.itemId}_batteryExpiration`]?.acknowledged) reasons.push(`Battery expired or mismatch (${checks.batteryExpiration})`);
        return reasons;
      }

      if (isOxygen) {
        if (!isVerified) reasons.push('Oxygen not verified');
        if (!oxygenReadings[item.itemId]) reasons.push('No oxygen PSI entered');
        return reasons;
      }

      const requiresExpCheck = !!((item as any).requiresExpirationCheck || item.itemDetails?.requiresExpirationCheck);
      if (requiresExpCheck) {
        const entered = itemExpirations[item.itemId];
        const system = item.itemDetails?.expirationDate ? toInputDate(getDate(item.itemDetails.expirationDate)) : '';
        const mismatchFlag = !!expirationMismatches[item.itemId];
        const enteredMatches = !!entered && !!system && entered === system;
        const acknowledged = !!expirationMismatches[item.itemId]?.acknowledged;
        if (!(isVerified || hasIssue || acknowledged || enteredMatches)) {
          reasons.push('Expiration not provided or mismatch not acknowledged');
        }
        return reasons;
      }

      if (!isVerified && !hasIssue) reasons.push('Not verified');
      return reasons;
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
                              <BagVisualizer statpack={pack} selectedPocket={'all'} onSelectPocket={jumpToPocket} completedPockets={completedPockets} />
                          </div>
               </CardBody>
            </Card>
            <div className="space-y-3">
                {/* Resume button: jump to first incomplete step if available */}
                {(() => {
                    const firstIncompleteId = stepOrder.find(id => {
                        const s = steps.find(ss => ss.id === id);
                        return !!s && !completedSteps.has(id);
                    });
                    const firstIndex = firstIncompleteId ? stepOrder.findIndex(id => id === firstIncompleteId) : -1;
                    const hasResume = firstIndex !== -1 && completedSteps.size > 0 && firstIndex >= 0;
                    return hasResume ? (
                        <Button size="md" variant="flat" className="w-full" onPress={() => {
                            setActiveStepIndex(firstIndex);
                            setView('steps');
                        }}>
                            Resume
                        </Button>
                    ) : (
                        <div className="text-sm text-gray-500 text-center">Tap a pocket above to begin checking.</div>
                    );
                })()}
            </div>
         </div>
      </div>
    );
  }

  // --- VIEW: STEPS ---
  if (view === 'steps') {
    // Group items by compartment within the current pocket
    const compartmentsInPocket = pack.compartments?.filter(c => c.parentPocket === currentStep.parentPocket) || [];
    const looseItemsInPocket = currentStep.items.filter(i => !i.compartmentId);
    
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
                      setAutoReviewMode(true);
                      setActiveStepIndex(firstIncomplete);
                      setView('steps');
                    } else {
                      setView('review');
                    }
                }}>
                  Review
                </Button>
                <Button size="sm" variant="light" color={debugOpen ? 'warning' : 'default'} onPress={() => setDebugOpen(d => !d)}>DBG</Button>
            </div>
          </div>
          
          <Progress size="sm" value={progressVal} color="success" aria-label="Progress" className="rounded-none"/>

          <div className="flex-1 overflow-y-auto p-4 max-w-lg mx-auto w-full pb-32">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-bold mb-1">{currentStep.name}</h2>
                <p className="text-gray-500 text-sm flex items-center gap-2">
                  <Package size={14}/>
                  {compartmentsInPocket.length > 0 && looseItemsInPocket.length > 0 
                    ? 'Compartments & Loose Items' 
                    : compartmentsInPocket.length > 0 
                    ? 'Sealed Compartments' 
                    : 'Loose Items'}
                </p>
              </div>
                {currentStep.parentPocket && (
                  <Chip size="sm" variant="flat" color="primary" className="capitalize">
                    {currentStep.parentPocket.replace('_', ' ')}
                  </Chip>
                )}
            </div>

            {/* COMPARTMENTS */}
            {compartmentsInPocket.map(comp => {
              const compItems = currentStep.items.filter(i => i.compartmentId === comp.id);
              const isSealIntact = comp.isSealed && sealCheck[comp.id] === true;
              
              return (
                <div key={comp.id} className="mb-6">
                  <h3 className="text-md font-semibold mb-3 flex items-center gap-2">
                    <Layers size={16} />
                    {comp.name}
                  </h3>
                  
                  {/* SEAL CHECK FOR THIS COMPARTMENT */}
                  {comp.isSealed && (
                    <Card className={`mb-4 border-l-4 ${sealCheck[comp.id] === true ? 'border-l-green-500 bg-green-100 dark:bg-green-900/20' : 'border-l-amber-500'}`}>
                      <CardBody className="flex flex-col gap-4">
                        <div className="flex flex-row items-center justify-between">
                          <div>
                              <div className="font-bold text-foreground flex items-center gap-2">
                                {sealCheck[comp.id] === true ? <Lock className="text-green-600"/> : <Unlock className="text-amber-600"/>}
                                Seal Status
                              </div>
                              <div className="text-xs text-gray-500">Seal #: {comp.sealNumber || 'N/A'}</div>
                          </div>
                          <div className="flex gap-2">
                              <Button size="sm" color={sealCheck[comp.id] === false ? "danger" : "default"} variant={sealCheck[comp.id] === false ? "solid" : "bordered"} onPress={() => handleSealToggle(comp.id, false)}>Broken</Button>
                              <Button size="sm" color={sealCheck[comp.id] === true ? "success" : "default"} variant={sealCheck[comp.id] === true ? "solid" : "bordered"} onPress={() => handleSealToggle(comp.id, true)}>Intact</Button>
                          </div>
                        </div>
                        {sealCheck[comp.id] === true && (
                          <p className="text-xs text-green-700 font-semibold flex items-center gap-1">
                              <CheckCircle2 size={12}/> Contents Verified via Seal
                          </p>
                        )}
                        <Divider />
                        <div>
                          <div className="text-xs font-semibold text-gray-500 mb-1 flex items-center gap-1"><CalendarDays size={12} /> Seal Expiration</div>
                          <Input type="date" size="sm" aria-label="Seal Expiration" value={sealExpirations[comp.id] || ''} onValueChange={(val) => handleSealExpirationChange(comp.id, val)} />
                        </div>
                      </CardBody>
                    </Card>
                  )}

                  {/* ITEMS IN THIS COMPARTMENT */}
                  <div className="relative">
                    <div className="space-y-3">
                      {compItems.map(item => {
                        const hasIssue = !!issueReports[item.itemId];
                        const isVerified = verifiedItems[item.itemId] && !hasIssue;
                        const isOxygen = item.itemDetails?.isOxygen;
                        const isAED = item.itemDetails?.isAsset && item.itemDetails?.assetCategory === 'AED';
                        const tracksExpiration = item.itemDetails?.tracksExpiration;
                        const sealedLocked = isSealIntact;
                        return (
                    <div 
                      key={item.itemId} 
                      onClick={() => { if (!isAED && !sealedLocked) handleVerifyToggle(item.itemId); }}
                      className={`cursor-pointer ${sealedLocked ? 'opacity-70 cursor-not-allowed' : ''}`}
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
                            <div className="text-xs text-gray-500 mt-1">
                              Qty: {item.requiredQuantity} {item.itemDetails?.unit}
                            </div>
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
                                <Input type="date" size="sm" variant="faded" aria-label="Item Expiration" value={itemExpirations[item.itemId] || ''} onValueChange={(val) => handleItemExpirationChange(item.itemId, val)} className="max-w-[160px]" disabled={sealedLocked} />
                                {(() => {
                                  const system = getStoredExpiration(pack, item);
                                  const entered = itemExpirations[item.itemId] || '';
                                  const mismatch = (entered && system && entered !== system) || !!expirationMismatches[item.itemId];
                                  if (!mismatch) return null;
                                  return (
                                    <div className="mt-1 text-xs text-amber-700 flex items-center gap-2">
                                      <div>System: {system || (expirationMismatches[item.itemId]?.system ?? '—')} · Entered: {entered || (expirationMismatches[item.itemId]?.entered ?? '—')}</div>
                                      <Button size="sm" variant="flat" onPress={() => setAckConfirm({ key: item.itemId, entered: entered || (expirationMismatches[item.itemId]?.entered ?? ''), system: system || (expirationMismatches[item.itemId]?.system ?? '') })}>Acknowledge</Button>
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                            {/* Input wrapper with w-fit */}
                            {isOxygen && !hasIssue && (
                              <div className="mt-3 w-fit max-w-[150px]" onClick={(e) => e.stopPropagation()}>
                                <div className="text-[10px] uppercase text-gray-400 font-bold mb-1">Current Level</div>
                                <Input type="number" size="sm" label="PSI" placeholder="0" variant="faded" startContent={<Wind size={14} className="text-gray-400"/>} value={oxygenReadings[item.itemId] || ''} onValueChange={(val) => handleOxygenChange(item.itemId, val)} color={parseInt(oxygenReadings[item.itemId]) < 500 ? "danger" : parseInt(oxygenReadings[item.itemId]) < 1000 ? "warning" : "success"} isRequired disabled={sealedLocked} />
                              </div>
                            )}
                            {/* AED controls: always visible inside card like oxygen */}
                            {isAED && !hasIssue && (
                              <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                                <div className="text-[10px] uppercase text-gray-400 font-bold mb-1">AED Checks</div>
                                <div className="flex items-center gap-2 mb-2">
                                  <Button size="sm" variant={aedChecks[item.itemId]?.powerOn ? 'solid' : 'bordered'} color={aedChecks[item.itemId]?.powerOn ? 'success' : 'default'} onPress={() => handleAedToggle(item.itemId, 'powerOn', !(aedChecks[item.itemId]?.powerOn))} isDisabled={sealedLocked}>Power On OK</Button>
                                  <Button size="sm" variant={aedChecks[item.itemId]?.padsSealed ? 'solid' : 'bordered'} color={aedChecks[item.itemId]?.padsSealed ? 'success' : 'default'} onPress={() => handleAedToggle(item.itemId, 'padsSealed', !(aedChecks[item.itemId]?.padsSealed))} isDisabled={sealedLocked}>Pads Present & Sealed</Button>
                                </div>
                                <div className="flex items-center gap-2 mb-2">
                                  <div className="text-[10px] text-gray-400">Pad Exp</div>
                                  <Input type="date" size="sm" value={aedChecks[item.itemId]?.padExpiration || ''} onValueChange={(v) => handleAedExpirationChange(item.itemId, 'padExpiration', v)} className="max-w-[140px]" disabled={sealedLocked} />
                                  {(() => {
                                    const systemPad = getStoredExpiration(pack, item, 'padExpiration');
                                    const enteredPad = aedChecks[item.itemId]?.padExpiration || '';
                                    const mismatchPad = (enteredPad && systemPad && enteredPad !== systemPad) || !!expirationMismatches[`${item.itemId}_padExpiration`];
                                    if (!mismatchPad) return null;
                                    return (
                                      <div className="flex items-center gap-2">
                                        <div className="text-xs text-amber-700 ml-2">System: {systemPad || (expirationMismatches[`${item.itemId}_padExpiration`]?.system ?? '—')}</div>
                                        <Button size="sm" variant="flat" onPress={() => setAckConfirm({ key: `${item.itemId}_padExpiration`, entered: enteredPad || (expirationMismatches[`${item.itemId}_padExpiration`]?.entered ?? ''), system: systemPad || (expirationMismatches[`${item.itemId}_padExpiration`]?.system ?? '') })}>Acknowledge</Button>
                                      </div>
                                    );
                                  })()}
                                  <div className="text-[10px] text-gray-400 ml-2">Battery Exp</div>
                                  <Input type="date" size="sm" value={aedChecks[item.itemId]?.batteryExpiration || ''} onValueChange={(v) => handleAedExpirationChange(item.itemId, 'batteryExpiration', v)} className="max-w-[140px]" disabled={sealedLocked} />
                                  {(() => {
                                    const systemBat = getStoredExpiration(pack, item, 'batteryExpiration');
                                    const enteredBat = aedChecks[item.itemId]?.batteryExpiration || '';
                                    const mismatchBat = (enteredBat && systemBat && enteredBat !== systemBat) || !!expirationMismatches[`${item.itemId}_batteryExpiration`];
                                    if (!mismatchBat) return null;
                                    return (
                                      <div className="flex items-center gap-2">
                                        <div className="text-xs text-amber-700 ml-2">System: {systemBat || (expirationMismatches[`${item.itemId}_batteryExpiration`]?.system ?? '—')}</div>
                                        <Button size="sm" variant="flat" onPress={() => setAckConfirm({ key: `${item.itemId}_batteryExpiration`, entered: enteredBat || (expirationMismatches[`${item.itemId}_batteryExpiration`]?.entered ?? ''), system: systemBat || (expirationMismatches[`${item.itemId}_batteryExpiration`]?.system ?? '') })}>Acknowledge</Button>
                                      </div>
                                    );
                                  })()}
                                </div>
                                <Input size="sm" variant="flat" placeholder="Notes (optional)" value={aedChecks[item.itemId]?.notes || ''} onValueChange={(v) => setAedChecks(prev => ({ ...prev, [item.itemId]: { ...(prev[item.itemId] || {}), notes: v } }))} disabled={sealedLocked} />
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
                                onPress={() => { if (!sealedLocked) openIssueModal(item); }}
                                isDisabled={sealedLocked}
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
              {isSealIntact && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 dark:bg-slate-900/60 backdrop-blur pointer-events-auto">
                  <div className="text-center p-4 rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/70 shadow">
                    <div className="flex items-center justify-center mb-2 text-green-700">
                      <Lock size={32} />
                    </div>
                    <div className="font-bold">Compartment Sealed</div>
                    <div className="text-sm text-gray-600">Contents are sealed — verification disabled</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
            
            {/* LOOSE ITEMS */}
            {looseItemsInPocket.length > 0 && (
              <div className="mb-6">
                <h3 className="text-md font-semibold mb-3 flex items-center gap-2">
                  <Package size={16} />
                  Loose Items
                </h3>
                
                <div className="space-y-3">
                  {looseItemsInPocket.map(item => {
                    const hasIssue = !!issueReports[item.itemId];
                    const isVerified = verifiedItems[item.itemId] && !hasIssue;
                    const isOxygen = item.itemDetails?.isOxygen;
                    const isAED = item.itemDetails?.isAsset && item.itemDetails?.assetCategory === 'AED';
                    const tracksExpiration = item.itemDetails?.tracksExpiration;
                    return (
                      <div 
                        key={item.itemId} 
                        onClick={() => { if (!isAED) handleVerifyToggle(item.itemId); }}
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
                              <div className="text-xs text-gray-500 mt-1">
                                Qty: {item.requiredQuantity} {item.itemDetails?.unit}
                              </div>
                              {hasIssue && (
                                <div className="mt-2 text-xs text-amber-700 bg-amber-100 dark:bg-amber-900/30 p-1.5 rounded-lg inline-block border border-amber-200 dark:border-amber-800">
                                  <div className="font-bold flex items-center gap-1 uppercase">
                                    <AlertTriangle size={10}/> {issueReports[item.itemId].issueType}
                                  </div>
                                  {issueReports[item.itemId].isReplaced && <div className="mt-0.5 ml-3.5">Replaced (+{issueReports[item.itemId].replacedQuantity})</div>}
                                </div>
                              )}
                              {!hasIssue && tracksExpiration && (
                                <div className="mt-3 w-fit" onClick={(e) => e.stopPropagation()}>
                                  <div className="text-[10px] uppercase text-gray-400 font-bold mb-1 flex items-center gap-1"><ThermometerSnowflake size={10} /> Earliest Expiration</div>
                                  <Input type="date" size="sm" variant="faded" aria-label="Item Expiration" value={itemExpirations[item.itemId] || ''} onValueChange={(val) => handleItemExpirationChange(item.itemId, val)} className="max-w-[160px]" />
                                </div>
                              )}
                              {isOxygen && !hasIssue && (
                                <div className="mt-3 w-fit max-w-[150px]" onClick={(e) => e.stopPropagation()}>
                                  <div className="text-[10px] uppercase text-gray-400 font-bold mb-1">Current Level</div>
                                  <Input type="number" size="sm" label="PSI" placeholder="0" variant="faded" startContent={<Wind size={14} className="text-gray-400"/>} value={oxygenReadings[item.itemId] || ''} onValueChange={(val) => handleOxygenChange(item.itemId, val)} color={parseInt(oxygenReadings[item.itemId]) < 500 ? "danger" : parseInt(oxygenReadings[item.itemId]) < 1000 ? "warning" : "success"} isRequired />
                                </div>
                              )}
                              {isAED && !hasIssue && (
                                <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                                  <div className="text-[10px] uppercase text-gray-400 font-bold mb-1">AED Checks</div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Button size="sm" variant={aedChecks[item.itemId]?.powerOn ? 'solid' : 'bordered'} color={aedChecks[item.itemId]?.powerOn ? 'success' : 'default'} onPress={() => handleAedToggle(item.itemId, 'powerOn', !(aedChecks[item.itemId]?.powerOn))}>Power On OK</Button>
                                    <Button size="sm" variant={aedChecks[item.itemId]?.padsSealed ? 'solid' : 'bordered'} color={aedChecks[item.itemId]?.padsSealed ? 'success' : 'default'} onPress={() => handleAedToggle(item.itemId, 'padsSealed', !(aedChecks[item.itemId]?.padsSealed))}>Pads Present & Sealed</Button>
                                  </div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="text-[10px] text-gray-400">Pad Exp</div>
                                    <Input type="date" size="sm" value={aedChecks[item.itemId]?.padExpiration || ''} onValueChange={(v) => handleAedExpirationChange(item.itemId, 'padExpiration', v)} className="max-w-[140px]" />
                                    {expirationMismatches[`${item.itemId}_padExpiration`] && (
                                      <div className="text-xs text-amber-700 ml-2">System: {expirationMismatches[`${item.itemId}_padExpiration`].system || '—'}</div>
                                    )}
                                    <div className="text-[10px] text-gray-400 ml-2">Battery Exp</div>
                                    <Input type="date" size="sm" value={aedChecks[item.itemId]?.batteryExpiration || ''} onValueChange={(v) => handleAedExpirationChange(item.itemId, 'batteryExpiration', v)} className="max-w-[140px]" />
                                    {expirationMismatches[`${item.itemId}_batteryExpiration`] && (
                                      <div className="text-xs text-amber-700 ml-2">System: {expirationMismatches[`${item.itemId}_batteryExpiration`].system || '—'}</div>
                                    )}
                                  </div>
                                  <Input size="sm" variant="flat" placeholder="Notes (optional)" value={aedChecks[item.itemId]?.notes || ''} onValueChange={(v) => setAedChecks(prev => ({ ...prev, [item.itemId]: { ...(prev[item.itemId] || {}), notes: v } }))} />
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
              </div>
            )}
          </div>

          {/* BOTTOM NAV */}
          <div className="p-4 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 fixed bottom-0 left-0 right-0 z-20 shadow-xl">
            <div className="max-w-lg mx-auto flex gap-3">
              <Button fullWidth variant="bordered" isDisabled={activeStepIndex === 0} onPress={() => setActiveStepIndex(prev => prev - 1)}>
                Back
              </Button>
              <Button fullWidth color="primary" onPress={handleStepComplete} isDisabled={!isStepComplete(currentStep)}>
                {activeStepIndex === steps.length - 1 ? 'Review' : 'Complete Pocket'}
              </Button>
            </div>
          </div>
          <MapModal isOpen={isMapOpen} onOpenChange={onMapChange} pack={pack} onSelectPocket={jumpToPocket} />

            <IssueModal 
              isOpen={isIssueOpen} 
              onOpenChange={onIssueChange} 
              currentIssueItem={currentIssueItem} 
              tempIssueData={tempIssueData} 
              setTempIssueData={setTempIssueData} 
              saveIssueReport={saveIssueReport} 
              aedChecks={aedChecks}
              handleAedToggle={handleAedToggle}
              handleAedExpirationChange={handleAedExpirationChange}
            />
            <Modal isOpen={!!mismatchModalData} onOpenChange={(open) => { if (!open) setMismatchModalData(null); }}>
              <ModalContent>
                <ModalHeader>
                  {mismatchModalData?.itemId?.includes('_') ? 'AED Expiration Mismatch' : 'Expiration Mismatch'}
                </ModalHeader>
                <ModalBody>
                  <div className="space-y-2">
                    <div className="text-sm">System record: <strong>{mismatchModalData?.system || '—'}</strong></div>
                    <div className="text-sm">Entered value: <strong>{mismatchModalData?.entered || '—'}</strong></div>
                    <div className="text-xs text-gray-500">
                      {mismatchModalData?.itemId?.includes('_') 
                        ? 'The entered AED expiration date does not match the system record. Please re-check the AED pads or battery expiration. You may re-enter the value or proceed and flag this checkout for admin review.'
                        : 'The entered expiration does not match the system record. Please re-check the item\'s expiration date. You may re-enter the value or proceed and flag this checkout for admin review.'
                      }
                    </div>
                  </div>
                </ModalBody>
                <ModalFooter>
                  <div className="flex gap-2">
                    <Button variant="flat" onPress={handleMismatchRecheck}>Recheck</Button>
                    <Button color="warning" onPress={handleMismatchProceed}>Proceed and Flag</Button>
                  </div>
                </ModalFooter>
              </ModalContent>
            </Modal>
            <Modal isOpen={!!ackConfirm} onOpenChange={(open) => { if (!open) setAckConfirm(null); }}>
              <ModalContent>
                <ModalHeader>Acknowledge Expiration Mismatch</ModalHeader>
                <ModalBody>
                  <div className="space-y-2 text-sm">
                    <div>System record: <strong>{ackConfirm?.system || '—'}</strong></div>
                    <div>Entered value: <strong>{ackConfirm?.entered || '—'}</strong></div>
                    <div className="text-xs text-gray-500">Acknowledging will allow checkout to proceed and will flag this mismatch for admin review.</div>
                  </div>
                </ModalBody>
                <ModalFooter>
                  <div className="flex gap-2">
                    <Button variant="flat" onPress={() => setAckConfirm(null)}>Cancel</Button>
                    <Button color="warning" onPress={() => {
                      if (!ackConfirm) return;
                      setExpirationMismatches(prev => ({ ...prev, [ackConfirm.key]: { entered: ackConfirm.entered, system: ackConfirm.system, acknowledged: true } }));
                      setAckConfirm(null);
                    }}>Acknowledge</Button>
                  </div>
                </ModalFooter>
              </ModalContent>
            </Modal>
            {/* Debug overlay */}
            {debugOpen && (
              <div className="fixed right-4 bottom-24 z-50 w-80 max-h-[60vh] overflow-auto p-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg text-xs">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-bold">Debug</div>
                  <Button size="sm" variant="light" onPress={() => setDebugOpen(false)}>Close</Button>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">Current Step</div>
                  <div>{currentStep?.id || '—'} — {currentStep?.name || ''}</div>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">sealCheck</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(sealCheck, null, 2)}</pre>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">aedChecks</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(aedChecks, null, 2)}</pre>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">verifiedItems</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(verifiedItems, null, 2)}</pre>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">itemExpirations</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(itemExpirations, null, 2)}</pre>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">expirationMismatches</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(expirationMismatches, null, 2)}</pre>
                </div>
                <div className="mb-2">
                  <div className="font-semibold">computed</div>
                  <pre className="whitespace-pre-wrap">{JSON.stringify({ isStepComplete: currentStep ? isStepComplete(currentStep) : null, completedSteps: Array.from(completedSteps || []), completedPockets: Array.from(completedPockets || []) }, null, 2)}</pre>
                </div>
                {currentStep && (
                  <div className="mb-2">
                    <div className="font-semibold">Item failure reasons (loose items)</div>
                    {currentStep.items.filter(i => !i.compartmentId).map(it => (
                      <div key={it.itemId} className="mb-1">
                        <div className="font-medium">{it.itemDetails?.name} ({it.itemId})</div>
                        <div className="text-xs text-amber-700">{getItemFailureReasons(it).length ? getItemFailureReasons(it).join(' · ') : 'OK'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
      </div>
    );
  }
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
      <>
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
        <Modal isOpen={!!stepProblems} onOpenChange={(open) => { if (!open) setStepProblems(null); }}>
          <ModalContent>
            <ModalHeader>Step Issues</ModalHeader>
            <ModalBody>
              <div className="space-y-2">
                {stepProblems?.map((p, idx) => (
                  <div key={idx} className="text-sm text-amber-700">• {p}</div>
                ))}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" variant="flat" onPress={() => setStepProblems(null)}>Close</Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </>
      );
    }
  return null;
};

// Treat a date string as valid if its date (local) is today or in the future.
const isExpirationValid = (dateLike?: any) => {
  if (!dateLike) return false;
  const d = getDate(dateLike);
  if (!d) return false;
  const today = new Date();
  today.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return d.getTime() >= today.getTime();
};

// Get the system/stored expiration date for an item or AED field (prefers asset instance on pack)
const getStoredExpiration = (packParam: Statpack | null, item: StatpackItem, field?: 'padExpiration' | 'batteryExpiration'): string => {
  if (!packParam) return '';
  const packItem = packParam.contents?.find((i: any) => i.itemId === item.itemId);
  // For AED assets, prefer asset instance data attached to the pack item
  try {
    const assets = packItem?.itemDetails?.assets || [];
    if (Array.isArray(assets) && assets.length > 0) {
      const assetInstance = assets.find((a: any) => (packItem?.serialNumber && a.serial === packItem.serialNumber) || a.assignedToId === packParam.id) || assets[0];
      if (assetInstance) {
        if (field === 'padExpiration') return assetInstance.padExpiration ? toInputDate(getDate(assetInstance.padExpiration)) : '';
        if (field === 'batteryExpiration') return assetInstance.batteryExpiration ? toInputDate(getDate(assetInstance.batteryExpiration)) : '';
      }
    }
  } catch (e) {
    // ignore
  }

  // Fallback: prefer the pack item expirationDate or itemDetails.expirationDate
  const pkExp = packItem?.expirationDate ? toInputDate(getDate(packItem.expirationDate)) : '';
  if (pkExp) return pkExp;
  const detExp = item.itemDetails?.expirationDate ? toInputDate(getDate(item.itemDetails.expirationDate)) : '';
  return detExp || '';
};