'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, CardFooter,
  Button, Chip, Divider, Spinner,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Input, Select, SelectItem, useDisclosure,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Autocomplete, AutocompleteItem, Tooltip, Textarea, Checkbox,
  User as UserAvatar
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { 
  collection, addDoc, updateDoc, doc, serverTimestamp, query, where, orderBy, limit, onSnapshot, getDocs, Timestamp, getDoc
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 
import Image from 'next/image';
import { 
  Plus, BriefcaseMedical, AlertCircle, CheckCircle, 
  Trash2, ClipboardCheck, History, UserMinus, UserCheck, QrCode,
  Package, Lock, Unlock, CalendarDays
} from 'lucide-react';
import { toDataURL } from 'qrcode';
import { jsPDF } from 'jspdf';

// --- Imports for Visualization ---
import type { Statpack, InventoryItem, StatpackItem, StatpackLog, StatpackPocket, User, StatpackCompartment } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer'; 

const BLANK_PACK: Partial<Statpack> = {
  name: "",
  type: "Primary",
  status: "Restock Needed",
  contents: [],
  compartments: [], // Initialize compartments
  isCheckedOut: false
};

// --- Helper: Recursive Cleaner for Firestore ---
const cleanData = (data: unknown): unknown => {
  if (Array.isArray(data)) {
    return data.map(item => cleanData(item));
  }
  if (data !== null && typeof data === 'object') {
    if (data instanceof Date) return data;
    if ('toMillis' in data && typeof (data as { toMillis?: unknown }).toMillis === 'function') return data;

    const newObj: Record<string, unknown> = {};
    Object.entries(data as Record<string, unknown>).forEach(([key, val]) => {
      if (val !== undefined) {
        newObj[key] = cleanData(val);
      }
    });
    return newObj;
  }
  return data;
};

export default function StatpacksPage() {
  const router = useRouter();
  
  function ResolvedUserAvatar({ userId, name, description }: { userId?: string; name?: string; description?: string | undefined }) {
    const [resolved, setResolved] = useState<string | undefined>(name);
    useEffect(() => {
      let mounted = true;
      if (!userId) return;
      (async () => {
        try {
          const uRef = doc(db, 'users', userId);
          const uSnap = await getDoc(uRef);
          if (!mounted) return;
          if (uSnap.exists()) {
            const ud = uSnap.data() as Partial<User> | undefined;
            if (ud?.fullName) setResolved(ud.fullName);
          }
        } catch (e) {
          console.warn('Failed to resolve user name for log display', e);
        }
      })();
      return () => { mounted = false; };
    }, [userId, name]);

    return (
      <UserAvatar
        name={resolved || name || 'Unknown User'}
        description={description}
        avatarProps={{ radius: 'sm' }}
      />
    );
  }
  
  // Modals Control
  const { isOpen: isEditOpen, onOpen: onEditOpen, onOpenChange: onEditChange } = useDisclosure();
  const { isOpen: isCheckoutOpen, onOpen: onCheckoutOpen, onOpenChange: onCheckoutChange } = useDisclosure();
  const { isOpen: isHistoryOpen, onOpen: onHistoryOpen, onOpenChange: onHistoryChange } = useDisclosure();
  const { isOpen: isQrOpen, onOpen: onQrOpen, onOpenChange: onQrChange } = useDisclosure();
  
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Data State
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [logs, setLogs] = useState<StatpackLog[]>([]);

  // Active Item State
  const [currentPack, setCurrentPack] = useState<Partial<Statpack>>(BLANK_PACK);
  const [selectedInventoryId, setSelectedInventoryId] = useState<string>("");
  const [selectedVariantId, setSelectedVariantId] = useState<string>("");
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [selectedSerialId, setSelectedSerialId] = useState<string>("");
  const [checkoutNotes, setCheckoutNotes] = useState("");
  const [qrPack, setQrPack] = useState<Statpack | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [qrLoading, setQrLoading] = useState(false);

  // --- Visualizer State ---
  const [viewPocket, setViewPocket] = useState<StatpackPocket | 'all'>('all');

  // --- Compartment Management State ---
  const [newCompName, setNewCompName] = useState('');
  const [newCompPocket, setNewCompPocket] = useState<StatpackPocket>('main');
  const [newCompSealed, setNewCompSealed] = useState(false);
  const [newCompSealNum, setNewCompSealNum] = useState('');
  const [newCompExpires, setNewCompExpires] = useState('');
  const [targetLocationId, setTargetLocationId] = useState<string>(''); 

  // 1. Auth & Data
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(
      userRef,
      (snapshot) => {
        const data = snapshot.data() as User | undefined;
        setUserRole(data?.role ?? 'member');
      },
      (error) => {
        console.error('Error fetching user role:', error);
        setUserRole('member');
      }
    );
    return () => unsubscribe();
  }, [user]);

  // Toggle app inertness when any modal is open to avoid aria-hidden focus conflicts
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const anyOpen = !!(isEditOpen || isCheckoutOpen || isHistoryOpen || isQrOpen);
      (window as any).setAppInert?.(anyOpen);
    } catch (e) {
      // ignore
    }
    return () => {
      try { (window as any).setAppInert?.(false); } catch(_) {}
    };
  }, [isEditOpen, isCheckoutOpen, isHistoryOpen, isQrOpen]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    let packsReady = false;
    let inventoryReady = false;

    const finishLoadingIfReady = () => {
      if (packsReady && inventoryReady) {
        setLoading(false);
      }
    };

    const unsubscribePacks = onSnapshot(
      collection(db, 'statpacks'),
      (snapshot) => {
        const packsData = snapshot.docs.map(d => ({ 
          id: d.id, 
          ...d.data(),
          lastCheckedAt: d.data().lastCheckedAt?.toDate(),
          checkedOutAt: d.data().checkedOutAt?.toDate(),
          compartments: d.data().compartments || []
        })) as Statpack[];

        setStatpacks(packsData);
        packsReady = true;
        finishLoadingIfReady();
      },
      (error) => {
        console.error("Error fetching statpacks:", error);
        packsReady = true;
        finishLoadingIfReady();
      }
    );

    const unsubscribeInventory = onSnapshot(
      collection(db, 'inventory'),
      (snapshot) => {
        const invData = snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
        setInventory(invData);
        inventoryReady = true;
        finishLoadingIfReady();
      },
      (error) => {
        console.error("Error fetching inventory:", error);
        inventoryReady = true;
        finishLoadingIfReady();
      }
    );

    return () => {
      unsubscribePacks();
      unsubscribeInventory();
    };
  }, [user]);

  const fetchLogs = async (packId: string) => {
    try {
      const q = query(
        collection(db, 'statpack_logs'), 
        where('statpackId', '==', packId),
        orderBy('timestamp', 'desc'),
        limit(25)
      );
      const snap = await getDocs(q);
      const logData = snap.docs.map(d => ({ 
        id: d.id, 
        ...d.data(),
        timestamp: d.data().timestamp instanceof Timestamp ? d.data().timestamp.toDate() : new Date()
      })) as StatpackLog[];
      setLogs(logData);
    } catch (e) {
      console.error("Log fetch error", e);
    }
  };

  // --- HELPER: RENDER LOG DETAILS (From Merged Code) ---
  const renderLogDetails = (log: StatpackLog) => {
    // 1. Show Issue Reports (Replacements, Missing, etc.)
    if (log.issues?.issueReports) {
      const reports = Object.values(log.issues.issueReports);
      
      if (reports.length === 0) {
          // Check if there are just notes or seal checks
          if(log.notes) return <div className="text-xs italic text-gray-500">"{log.notes}"</div>;
          return <span className="text-gray-400 text-xs italic">Routine check - No issues</span>;
      }

      return (
        <div className="flex flex-col gap-2">
          {reports.map((r, idx) => (
            <div key={idx} className="flex flex-col p-2 rounded-lg bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-xs">
               <div className="flex justify-between items-start mb-1">
                  <span className="font-semibold text-gray-800 dark:text-gray-200">{r.itemName}</span>
                  {r.isReplaced ? (
                      <Chip size="sm" color="success" variant="flat" className="h-4 text-[9px] px-1">Replaced (+{r.replacedQuantity})</Chip>
                  ) : (
                      <Chip size="sm" color="danger" variant="flat" className="h-4 text-[9px] px-1">Missing</Chip>
                  )}
               </div>
               
               <div className="flex items-center gap-2 text-gray-500">
                  <span className="uppercase text-[9px] font-bold border border-gray-300 dark:border-gray-600 px-1 rounded">{r.issueType}</span>
                  {r.newExpirationDate && (
                      <span className="flex items-center gap-1 text-[9px]">
                          <CalendarDays size={10}/> New Exp: {r.newExpirationDate}
                      </span>
                  )}
               </div>
               
               {r.notes && <div className="mt-1 text-gray-500 italic">"{r.notes}"</div>}
            </div>
          ))}
          {log.notes && <div className="text-xs italic text-gray-600 mt-1 border-t pt-1">Global Note: "{log.notes}"</div>}
        </div>
      );
    }

    // 2. Legacy / Check-in Usage
    if (log.itemsUsed && Object.keys(log.itemsUsed).length > 0) {
        return (
            <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-gray-500">Items Used:</span>
                {Object.entries(log.itemsUsed).map(([key, count]) => (
                    <div key={key} className="text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 px-2 py-1 rounded">
                        Item #{key.split('-')[1] || key}: <strong>{count}</strong>
                    </div>
                ))}
            </div>
        );
    }

    return <span className="text-gray-400 text-xs italic">{log.notes || "No notable events."}</span>;
  };

  // 2. Handlers: Open Modals
  const handleCreate = () => {
    setCurrentPack(BLANK_PACK);
    setViewPocket('all'); 
    onEditOpen();
  };

  const handleEdit = (pack: Statpack) => {
    setCurrentPack({ 
      ...pack, 
      contents: pack.contents.map(item => ({...item})),
      compartments: pack.compartments ? [...pack.compartments] : []
    });
    setViewPocket('all');
    onEditOpen();
  };

  const handleOpenCheckout = (pack: Statpack) => {
    setCurrentPack({ ...pack, contents: pack.contents.map(item => ({...item})) });
    setCheckoutNotes("");
    setViewPocket('all'); 
    onCheckoutOpen();
  };

  const handleViewHistory = async (pack: Statpack) => {
    setCurrentPack(pack);
    await fetchLogs(pack.id);
    onHistoryOpen();
  };

  const buildCheckoutUrl = (packId: string) => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/mobile/checkout?id=${encodeURIComponent(packId)}`;
  };

  const handleOpenQr = async (pack: Statpack) => {
    const url = buildCheckoutUrl(pack.id);
    setQrPack(pack);
    setQrUrl(url);
    setQrDataUrl('');
    setQrLoading(true);
    onQrOpen();

    if (!url) {
      setQrLoading(false);
      return;
    }

    try {
      const dataUrl = await toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 256 });
      setQrDataUrl(dataUrl);
    } catch (error) {
      console.error('QR code generation failed:', error);
    } finally {
      setQrLoading(false);
    }
  };

  const handleDownloadQrPdf = async () => {
    if (!qrPack) return;
    const url = qrUrl || buildCheckoutUrl(qrPack.id);
    if (!url) return;

    let dataUrl = qrDataUrl;
    if (!dataUrl) {
      try {
        dataUrl = await toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
      } catch (error) {
        console.error('QR code generation failed:', error);
        return;
      }
    }

    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    const qrSize = Math.min(pageWidth - margin * 2, 320);
    const x = (pageWidth - qrSize) / 2;
    let y = 110;

    doc.setFontSize(18);
    doc.text('Statpack Checkout QR', pageWidth / 2, 48, { align: 'center' });
    doc.setFontSize(12);
    doc.text(qrPack.name, pageWidth / 2, 70, { align: 'center' });
    doc.addImage(dataUrl, 'PNG', x, y, qrSize, qrSize);
    y += qrSize + 24;
    doc.setFontSize(10);
    doc.text(url, pageWidth / 2, y, { align: 'center' });

    const safeName = (qrPack.name || qrPack.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    doc.save(`statpack-${safeName}-checkout-qr.pdf`);
  };

  // --- Compartment Logic ---

  const handleAddCompartment = () => {
    if (!newCompName) return;
    const newId = `comp_${Date.now()}`;
    const newComp: StatpackCompartment = {
      id: newId,
      name: newCompName,
      parentPocket: newCompPocket,
      isSealed: newCompSealed,
      sealNumber: newCompSealed ? newCompSealNum : undefined,
      expirationDate: (newCompSealed && newCompExpires) ? new Date(newCompExpires) : undefined
    };

    setCurrentPack(prev => ({
      ...prev,
      compartments: [...(prev.compartments || []), newComp]
    }));

    setNewCompName('');
    setNewCompSealNum('');
    setNewCompExpires('');
    setNewCompSealed(false);
  };

  const handleRemoveCompartment = (compId: string) => {
    setCurrentPack(prev => ({
      ...prev,
      compartments: prev.compartments?.filter(c => c.id !== compId),
      contents: prev.contents?.map(item => 
        item.compartmentId === compId ? { ...item, compartmentId: undefined } : item
      )
    }));
  };

  // 3. Handlers: Inventory Management
  const addItemToBag = () => {
    if (!selectedInventoryId || !targetLocationId || !currentPack.contents) return;
    
    const compartments = currentPack.compartments || [];
    const matchedCompartment = compartments.find(c => c.id === targetLocationId);
    
    let finalPocket: StatpackPocket;
    let finalCompartmentId: string | undefined;

    if (matchedCompartment) {
      finalPocket = matchedCompartment.parentPocket;
      finalCompartmentId = matchedCompartment.id;
    } else {
      finalPocket = targetLocationId as StatpackPocket;
      finalCompartmentId = undefined;
    }

    const masterItem = inventory.find(i => i.id === selectedInventoryId);
    if (!masterItem) return;
    const hasVariants = masterItem.hasVariants && (masterItem.variants || []).length > 0;
    const selectedVariant = hasVariants
      ? masterItem.variants?.find(v => v.id === selectedVariantId) ?? masterItem.variants?.[0]
      : undefined;

    const hasBatches = (masterItem.batches || []).length > 0;
    const selectedBatch = hasBatches
      ? masterItem.batches?.find(b => b.id === selectedBatchId) ?? masterItem.batches?.[0]
      : undefined;

    // CRITICAL: StatpackItem must reference a specific batch (cannot add generic item)
    // If no batch exists, force user to create one or use a placeholder
    let batchId = selectedBatch?.id ?? `placeholder-${Date.now()}`;
    let effectiveBatchExp = selectedBatch?.expirationDate;
    let effectiveLot = selectedBatch?.lotNumber;

    // If this master item is an asset (unit-tracked) and no batch selected,
    // prefer to use the selected asset serial as an identifier so statpack references the specific device.
    if (masterItem.isAsset && !selectedBatch && selectedSerialId) {
      batchId = `asset-${selectedSerialId}`;
      effectiveBatchExp = undefined;
      effectiveLot = undefined;
    }

    const newItem: StatpackItem = {
      itemId: masterItem.id,
      itemDetails: masterItem,
      variantId: selectedVariant?.id,
      variantName: selectedVariant?.name,
      requiredQuantity: 1,
      currentQuantity: 0,
      pocket: finalPocket,
      compartmentId: finalCompartmentId,
      batchId: batchId, // REQUIRED
      serialNumber: selectedSerialId || undefined,
      expirationDate: effectiveBatchExp,
      lotNumber: effectiveLot
    };

    // Note: if batch doesn't exist, this creates a placeholder - for assets prefer using selected serial
    if (!selectedBatch && hasBatches === false && !masterItem.isAsset) {
      console.warn('No batch available for item. Using placeholder batchId. User should create batch first.');
    }

    setCurrentPack(prev => ({ ...prev, contents: [...(prev.contents || []), newItem] }));
    setSelectedInventoryId(""); 
    setSelectedVariantId("");
    setSelectedBatchId("");
  };

  const updateItemInList = (itemToUpdate: StatpackItem, field: string, val: number) => {
    setCurrentPack(prev => ({
        ...prev,
        contents: prev.contents?.map(i => 
            (i === itemToUpdate) ? { ...i, [field]: val } : i
        )
    }));
  };

  const updateItemVariant = (itemToUpdate: StatpackItem, variantId: string) => {
    const itemDetails = itemToUpdate.itemDetails || inventory.find(i => i.id === itemToUpdate.itemId);
    const variants = itemDetails?.variants || [];
    const match = variants.find(v => v.id === variantId);

    setCurrentPack(prev => ({
      ...prev,
      contents: prev.contents?.map(i =>
        (i === itemToUpdate)
          ? { ...i, variantId: match?.id, variantName: match?.name }
          : i
      )
    }));
  };

  const updateItemSerial = (itemToUpdate: StatpackItem, serial: string) => {
    setCurrentPack(prev => ({
      ...prev,
      contents: prev.contents?.map(i => (i === itemToUpdate ? { ...i, serialNumber: serial } : i))
    }));
  };

  const getVariantLabel = (item: StatpackItem) => {
    if (item.variantName) return item.variantName;
    if (item.variantId) {
      const itemDetails = item.itemDetails || inventory.find(i => i.id === item.itemId);
      const match = itemDetails?.variants?.find(v => v.id === item.variantId);
      return match?.name;
    }
    return undefined;
  };

  const removeItemFromBag = (itemToRemove: StatpackItem) => {
    setCurrentPack(prev => ({
      ...prev,
      contents: prev.contents?.filter(i => i !== itemToRemove)
    }));
  };

  // 4. Handlers: Database Actions
  const handleSaveConfig = async (onClose: () => void) => {
    if (!currentPack.name || !user) return;
    setSaving(true);
    try {
      const cleanedPack = cleanData(currentPack) as Record<string, unknown>;
      const payload: Record<string, unknown> = { ...cleanedPack, updatedAt: serverTimestamp() };
      
      Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);
      
      let userName = user.displayName || user.email || 'Unknown User';
      try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const ud = userSnap.data() as Partial<User> | undefined;
          if (ud?.fullName) userName = ud.fullName;
        }
      } catch (e) {
        console.warn('Failed to read user profile for name resolution', e);
      }
      
      const logEntry: StatpackLog = {
        statpackId: currentPack.id || 'new',
        statpackName: currentPack.name,
        action: 'maintenance',
        userId: user.uid,
        userName,
        timestamp: serverTimestamp(),
        notes: 'Configuration updated'
      };

      if (currentPack.id) {
        await updateDoc(doc(db, 'statpacks', currentPack.id), payload);
        await addDoc(collection(db, 'statpack_logs'), { ...logEntry, statpackId: currentPack.id });
      } else {
        delete payload.id; 
        payload.createdAt = serverTimestamp();
        const docRef = await addDoc(collection(db, 'statpacks'), payload);
        await addDoc(collection(db, 'statpack_logs'), { ...logEntry, statpackId: docRef.id });
      }

      onClose();
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitCheckout = async (onClose: () => void) => {
    if (!currentPack.id || !user) return;
    setSaving(true);
    try {
      let userName = user.displayName || user.email || 'Unknown User';
      try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const ud = userSnap.data() as Partial<User> | undefined;
          if (ud?.fullName) userName = ud.fullName;
        }
      } catch (e) {
        console.warn('Failed to read user profile for name resolution', e);
      }
      const newStatus: Statpack['status'] = 'In Use';

      const cleanedContents = cleanData(currentPack.contents);

      const updatePayload = {
        contents: cleanedContents,
        status: newStatus,
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: userName,
        checkedOutAt: serverTimestamp(),
        lastCheckedBy: user.uid,
        lastCheckedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      
      await updateDoc(doc(db, 'statpacks', currentPack.id), updatePayload);
      
      const logEntry: StatpackLog = {
        statpackId: currentPack.id,
        statpackName: currentPack.name || 'Unknown',
        action: 'checkout',
        userId: user.uid,
        userName,
        timestamp: serverTimestamp(),
        notes: checkoutNotes || `Bag checked out for use`
      };
      await addDoc(collection(db, 'statpack_logs'), logEntry);

      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleReturnBag = async (pack: Statpack) => {
    if (!user) return;
    let userName = user.displayName || user.email || 'Unknown User';
    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const ud = userSnap.data() as Partial<User> | undefined;
        if (ud?.fullName) userName = ud.fullName;
      }
    } catch (e) {
      console.warn('Failed to read user profile for name resolution', e);
    }
    const isReturnAllowed = userRole === 'admin' || pack.assignedToUserId === user?.uid;
    if (!isReturnAllowed) {
      alert('Only the assignee or an admin can return this bag.');
      return;
    }
    if (!confirm(`Return ${pack.name}?`)) return;
    setLoading(true);
    try {
      let newStatus: Statpack['status'] = 'Ready';
      if (pack.contents) {
        pack.contents.forEach(item => {
          if (item.currentQuantity < item.requiredQuantity) {
            newStatus = 'Restock Needed';
          }
        });
      }

      await updateDoc(doc(db, 'statpacks', pack.id), {
        status: newStatus,
        isCheckedOut: false,
        assignedToUserId: null,
        assignedToUserName: null,
        updatedAt: serverTimestamp()
      });

      await addDoc(collection(db, 'statpack_logs'), {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkin',
        userId: user.uid,
        userName,
        timestamp: serverTimestamp(),
        notes: `Bag returned. Status set to: ${newStatus}`
      });

    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const getVisibleItems = () => {
    if (!currentPack.contents) return [];
    if (viewPocket === 'all') return currentPack.contents;
    return currentPack.contents.filter(i => i.pocket === viewPocket);
  };

  const getStatusColor = (s: string) => {
    if(s === 'Ready') return 'success';
    if(s === 'In Use') return 'warning'; 
    if(s === 'Expired Items') return 'danger';
    return 'warning'; 
  };

  const canReturnPack = (pack: Statpack) => {
    if (!user) return false;
    return userRole === 'admin' || pack.assignedToUserId === user.uid;
  };

  const getLocationOptions = () => {
    const opts: {key: string, label: string, group: string}[] = [];
    
    if (currentPack.compartments) {
       currentPack.compartments.forEach(c => {
          opts.push({ 
             key: c.id, 
             label: `${c.name} (${c.isSealed ? 'Sealed' : 'Unsealed'})`, 
             group: c.parentPocket.replace('_', ' ').toUpperCase()
          });
       });
    }

    const pockets: StatpackPocket[] = ['main', 'front_aux', 'side_left', 'side_right'];
    pockets.forEach(p => {
       opts.push({ key: p, label: `${p.replace('_', ' ')} (Loose)`, group: 'LOOSE' });
    });
    
    return opts;
  };

  const selectedInventoryItem = inventory.find(i => i.id === selectedInventoryId);
  const availableVariants = selectedInventoryItem?.variants || [];
  const showVariantSelect = Boolean(selectedInventoryItem?.hasVariants && availableVariants.length > 0);
  const availableBatches = selectedInventoryItem?.batches || [];
  const showBatchSelect = Boolean(availableBatches.length > 0);
  const chosenBatch = availableBatches.find(b => b.id === selectedBatchId);
  // Gather possible serials from batch.serialNumbers, batch.assetInstances, or top-level item.assets
  const chosenBatchSerials: string[] = (() => {
    if (chosenBatch) {
      if (Array.isArray(chosenBatch.serialNumbers) && chosenBatch.serialNumbers.length > 0) return chosenBatch.serialNumbers.slice();
      if (Array.isArray(chosenBatch.assetInstances) && chosenBatch.assetInstances.length > 0) return chosenBatch.assetInstances.map(ai => (ai.serial || ai.assetTag || ai.id)).filter((s): s is string => Boolean(s));
    }
    if (selectedInventoryItem && Array.isArray(selectedInventoryItem.assets) && selectedInventoryItem.assets.length > 0) {
      return selectedInventoryItem.assets.map(a => (a.serial || a.assetTag || a.id)).filter((s): s is string => Boolean(s));
    }
    return [];
  })();
  const selectedBatchHasSerials = chosenBatchSerials.length > 0;
  const needSerialSelection = selectedBatchHasSerials && !selectedSerialId;
  const assetLabels: Record<string, string> = {};
  const assetSerials: string[] = (() => {
    const list: string[] = [];
    if (!selectedInventoryItem) return list;

    if (Array.isArray(selectedInventoryItem.assets) && selectedInventoryItem.assets.length > 0) {
      selectedInventoryItem.assets.forEach(a => {
        const idVal = (a.serial || a.assetTag || a.id) as string | undefined;
        if (!idVal) return;
        if (!list.includes(idVal)) list.push(idVal);
        const tag = a.assetTag ? `Tag ${a.assetTag}` : undefined;
        const shortId = a.id ? `ID ${String(a.id).slice(0,6)}` : undefined;
        assetLabels[idVal] = tag ? (shortId ? `${tag} — ${shortId}` : tag) : (shortId || idVal);
      });
    }

    const fromBatches = availableBatches.flatMap(b => (b.assetInstances || []).map(ai => ai).filter(Boolean));
    fromBatches.forEach((ai: any) => {
      const idVal = (ai.serial || ai.assetTag || ai.id) as string | undefined;
      if (!idVal) return;
      if (!list.includes(idVal)) list.push(idVal);
      const tag = ai.assetTag ? `Tag ${ai.assetTag}` : undefined;
      const shortId = ai.id ? `ID ${String(ai.id).slice(0,6)}` : undefined;
      assetLabels[idVal] = tag ? (shortId ? `${tag} — ${shortId}` : tag) : (shortId || idVal);
    });

    return list;
  })();
  // Treat items with `assets` present as asset-tracked even if `isAsset` flag missing
  const isAssetLike = Boolean(selectedInventoryItem && ((selectedInventoryItem.isAsset) || (Array.isArray(selectedInventoryItem.assets) && selectedInventoryItem.assets.length > 0)));
  const showAssetSelect = Boolean(isAssetLike && assetSerials.length > 0);

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <BriefcaseMedical className="text-indigo-600" /> Fleet Manager
            </h1>
            <p className="text-gray-500">Manage G3+ Load-N-Go statpacks</p>
          </div>
          <Button color="primary" onPress={handleCreate} startContent={<Plus />}>
            New Statpack
          </Button>
        </div>
        <Divider />

        {/* Grid of Statpacks */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {statpacks.map(pack => (
            <Card key={pack.id} className="hover:shadow-lg transition-shadow">
               <CardHeader className="flex justify-between items-start pb-0">
                <div className="flex flex-col">
                  <span className="text-lg font-bold truncate">{pack.name}</span>
                  <span className="text-xs text-gray-500 uppercase">{pack.type}</span>
                </div>
                <div className="flex gap-2">
                   <Tooltip content="View History">
                     <Button isIconOnly size="sm" variant="light" onPress={() => handleViewHistory(pack)}>
                       <History size={18} className="text-gray-400" />
                     </Button>
                   </Tooltip>
                   <Tooltip content="QR Code">
                     <Button isIconOnly size="sm" variant="light" onPress={() => handleOpenQr(pack)}>
                        <QrCode size={18} className="text-gray-400" />
                     </Button>
                   </Tooltip>
                   <Tooltip content="Edit Configuration">
                     <Button isIconOnly size="sm" variant="light" onPress={() => handleEdit(pack)}>
                        <BriefcaseMedical size={18} className="text-gray-400" />
                     </Button>
                   </Tooltip>
                </div>
              </CardHeader>
              <CardBody className="py-4 gap-4">
                 <div className="flex justify-between items-center">
                  <Chip size="sm" color={getStatusColor(pack.status)} variant="flat">
                    {pack.status}
                  </Chip>
                  {pack.isCheckedOut ? (
                    <Chip startContent={<UserCheck size={14} />} size="sm" color="primary" variant="dot">
                      {pack.assignedToUserName || 'Checked Out'}
                    </Chip>
                  ) : (
                    <Chip startContent={<UserMinus size={14} />} size="sm" color="default" variant="flat">
                      Available
                    </Chip>
                  )}
                </div>
                {/* Show compartment summary */}
                <div className="flex flex-wrap gap-1 mt-2">
                   {pack.compartments?.slice(0, 3).map(c => (
                     <Chip key={c.id} size="sm" variant="flat" className="text-[10px] h-5 px-1">
                        {c.name}
                     </Chip>
                   ))}
                   {(pack.compartments?.length || 0) > 3 && <span className="text-xs text-gray-400">+{pack.compartments!.length - 3} more</span>}
                </div>
              </CardBody>
              <CardFooter className="bg-indigo-50/70 dark:bg-slate-800/60">
                <Button
                  fullWidth
                  color="primary"
                  onPress={() => window.open(`/mobile?id=${pack.id}`, '_blank')}
                  startContent={<QrCode size={18} />}
                >
                  Simulate QR Scan
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>

      {/* --- 1. EDIT CONFIGURATION MODAL --- */}
      <Modal isOpen={isEditOpen} onOpenChange={onEditChange} size="5xl" scrollBehavior="inside">
        <ModalContent className="max-w-7xl w-[95%]">
          {(onClose) => (
            <>
              <ModalHeader>Edit Configuration: {currentPack.name}</ModalHeader>
              <ModalBody>
                 <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <Input label="Bag Name" value={currentPack.name} onValueChange={(val) => setCurrentPack(p => ({...p, name: val}))} />
                  <Select label="Type" selectedKeys={currentPack.type ? [currentPack.type] : []} onChange={(e) => setCurrentPack(p => ({...p, type: e.target.value as Statpack['type']}))}>
                    <SelectItem key="Primary">Primary</SelectItem>
                    <SelectItem key="Secondary">Secondary</SelectItem>
                  </Select>
                  <Select label="Forced Status" selectedKeys={currentPack.status ? [currentPack.status] : []} onChange={(e) => setCurrentPack(p => ({...p, status: e.target.value as Statpack['status']}))}>
                    <SelectItem key="Ready">Ready</SelectItem>
                    <SelectItem key="Restock Needed">Restock Needed</SelectItem>
                    <SelectItem key="In Use">In Use</SelectItem>
                  </Select>
                </div>
                
                <Divider className="my-2" />

                {/* --- NEW: COMPARTMENT MANAGER SECTION --- */}
                <div className="bg-gray-50 dark:bg-zinc-800/50 p-4 rounded-lg border border-gray-200 dark:border-zinc-700 mb-6">
                  <h3 className="font-bold text-sm uppercase text-gray-500 mb-3 flex items-center gap-2">
                    <Package size={16} /> Configure Compartments
                  </h3>
                  
                  <div className="flex flex-wrap gap-3 items-end mb-4 bg-white dark:bg-zinc-900 p-3 rounded-md shadow-sm">
                    <Input 
                      label="Compartment Name" 
                      placeholder="e.g. Airway Kit" 
                      size="sm" 
                      className="w-48"
                      value={newCompName}
                      onValueChange={setNewCompName}
                    />
                    <Select 
                      label="Parent Pocket" 
                      size="sm" 
                      className="w-40"
                      selectedKeys={[newCompPocket]} 
                      onChange={(e) => setNewCompPocket(e.target.value as StatpackPocket)}
                    >
                      <SelectItem key="main">Main</SelectItem>
                      <SelectItem key="front_aux">Front Aux</SelectItem>
                      <SelectItem key="side_left">Side Left</SelectItem>
                      <SelectItem key="side_right">Side Right</SelectItem>
                    </Select>
                    
                    <div className="flex items-center gap-2 h-12 bg-gray-100 dark:bg-zinc-800 px-3 rounded-md">
                       <Checkbox isSelected={newCompSealed} onValueChange={setNewCompSealed}>Sealed?</Checkbox>
                    </div>

                    {newCompSealed && (
                      <>
                        <Input 
                          label="Seal Code"
                          placeholder="0000" 
                          size="sm" 
                          className="w-24" 
                          value={newCompSealNum}
                          onValueChange={setNewCompSealNum}
                        />
                        <Input 
                          type="date"
                          label="Expiration"
                          size="sm" 
                          className="w-32" 
                          value={newCompExpires}
                          onValueChange={setNewCompExpires}
                        />
                      </>
                    )}

                    <Button size="sm" color="primary" onPress={handleAddCompartment} isDisabled={!newCompName}>
                      Add
                    </Button>
                  </div>

                  {/* List Existing Compartments */}
                  <div className="flex flex-wrap gap-2">
                    {currentPack.compartments?.map(comp => (
                      <Chip 
                        key={comp.id} 
                        onClose={() => handleRemoveCompartment(comp.id)}
                        variant="flat"
                        color={comp.isSealed ? "success" : "default"}
                        startContent={comp.isSealed ? <Lock size={12}/> : <Unlock size={12}/>}
                        className="pl-2"
                      >
                        <span className="font-semibold">{comp.name}</span> 
                        <span className="text-xs opacity-70 ml-1">({comp.parentPocket})</span>
                        {comp.isSealed && <span className="ml-1 text-[10px] bg-white/40 px-1 rounded text-black/70">#{comp.sealNumber}</span>}
                      </Chip>
                    ))}
                    {(!currentPack.compartments || currentPack.compartments.length === 0) && (
                      <span className="text-xs text-gray-400 italic">No compartments defined. Items will be loose.</span>
                    )}
                  </div>
                </div>
                
                {/* --- VISUALIZER INTEGRATION (EDIT MODE) --- */}
                <div className="flex flex-col lg:flex-row gap-6">
                  {/* Left: Visualizer */}
                  <div className="flex-none lg:w-auto lg:min-w-[520px] flex justify-center items-center bg-white/80 dark:bg-slate-800/80 border border-transparent dark:border-slate-700 rounded-xl p-10">
                    <BagVisualizer 
                      statpack={currentPack as Statpack} 
                      selectedPocket={viewPocket} 
                      onSelectPocket={setViewPocket} 
                    />
                  </div>

                  {/* Right: Table */}
                  <div className="flex-grow space-y-4">
                    <div className="flex justify-between items-center">
                       <h3 className="font-semibold">
                         {viewPocket === 'all' ? "All Items" : `Items in ${viewPocket.replace('_', ' ').toUpperCase()}`}
                       </h3>
                    </div>

                    <Table aria-label="Config Table" removeWrapper className="max-h-[400px] overflow-y-auto">
                        <TableHeader>
                          <TableColumn>ITEM</TableColumn>
                          <TableColumn>VARIATION</TableColumn>
                          <TableColumn>ASSET</TableColumn>
                          <TableColumn>LOCATION</TableColumn>
                          <TableColumn width={100}>REQ QTY</TableColumn>
                          <TableColumn width={50}>DEL</TableColumn>
                        </TableHeader>
                        <TableBody emptyContent="No items in this pocket.">
                          {getVisibleItems().map((item, idx) => {
                              const comp = currentPack.compartments?.find(c => c.id === item.compartmentId);
                              // Prefer the authoritative inventory document (freshest data)
                              const itemDetails = inventory.find(i => i.id === item.itemId) || item.itemDetails;
                              const variants = itemDetails?.variants || [];
                              const hasVariants = Boolean(itemDetails?.hasVariants && variants.length > 0);
                              const variantLabel = getVariantLabel(item);
                              // Gather serials for this specific statpack item
                              const itemAssetSerials: string[] = (() => {
                                if (!itemDetails) return [];
                                const out: string[] = [];
                                // include top-level assetSerial or assetTag from the inventory record
                                const topId = (itemDetails.assetSerial || (itemDetails as any).assetTag) as string | undefined;
                                if (topId) out.push(topId);

                                if (Array.isArray(itemDetails.assets) && itemDetails.assets.length > 0) {
                                  itemDetails.assets.forEach((a: any) => {
                                    const idVal = (a.serial || a.assetTag || a.id) as string | undefined;
                                    if (idVal) out.push(idVal);
                                  });
                                }

                                const fromBatches = (itemDetails.batches || []).flatMap((b: any) => {
                                  const sns: string[] = [];
                                  if (Array.isArray(b.serialNumbers)) sns.push(...b.serialNumbers.filter(Boolean));
                                  if (Array.isArray(b.assetInstances)) sns.push(...b.assetInstances.map((ai: any) => (ai.serial || ai.assetTag || ai.id)).filter(Boolean));
                                  return sns;
                                });
                                out.push(...fromBatches);

                                // Deduplicate and return
                                return Array.from(new Set(out.filter(Boolean) as string[]));
                              })();
                              const isItemAssetLike = itemAssetSerials.length > 0 || Boolean(itemDetails?.isAsset);
                              // Build labels for this row so the Select shows Tag/ID instead of empty serials
                              const itemAssetLabels: Record<string, string> = {};
                              if (itemDetails) {
                                if (Array.isArray(itemDetails.assets)) {
                                  itemDetails.assets.forEach((a: any) => {
                                    const idVal = (a.serial || a.assetTag || a.id) as string | undefined;
                                    if (!idVal) return;
                                    const tag = a.assetTag ? `Tag ${a.assetTag}` : undefined;
                                    const shortId = a.id ? `ID ${String(a.id).slice(0,6)}` : undefined;
                                    itemAssetLabels[idVal] = tag ? (shortId ? `${tag} — ${shortId}` : tag) : (shortId || idVal);
                                  });
                                }
                                (itemDetails.batches || []).forEach((b: any) => {
                                  (b.assetInstances || []).forEach((ai: any) => {
                                    const idVal = (ai.serial || ai.assetTag || ai.id) as string | undefined;
                                    if (!idVal) return;
                                    const tag = ai.assetTag ? `Tag ${ai.assetTag}` : undefined;
                                    const shortId = ai.id ? `ID ${String(ai.id).slice(0,6)}` : undefined;
                                    itemAssetLabels[idVal] = tag ? (shortId ? `${tag} — ${shortId}` : tag) : (shortId || idVal);
                                  });
                                });
                              }
                              return (
                                <TableRow key={`${item.itemId}_${idx}`}>
                                  <TableCell>
                                    <div className="flex flex-col">
                                      <span>{itemDetails?.name || "Item"}</span>
                                      {variantLabel && (
                                        <span className="text-[10px] text-gray-400">Variation: {variantLabel}</span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    {hasVariants ? (
                                      <Select
                                        size="sm"
                                        placeholder="Select"
                                        selectedKeys={item.variantId ? [item.variantId] : []}
                                        onChange={(e) => updateItemVariant(item, e.target.value)}
                                      >
                                        {variants.map(variant => (
                                          <SelectItem key={variant.id} textValue={variant.name}>
                                            {variant.name}
                                          </SelectItem>
                                        ))}
                                      </Select>
                                    ) : (
                                      <span className="text-xs text-gray-400">—</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {isItemAssetLike ? (
                                      <Select
                                        size="sm"
                                        placeholder="Select Asset"
                                        selectedKeys={item.serialNumber ? [item.serialNumber] : []}
                                        onChange={(e) => updateItemSerial(item, e.target.value)}
                                      >
                                        {itemAssetSerials.map(sn => (
                                          <SelectItem key={sn} textValue={sn}>{sn}</SelectItem>
                                        ))}
                                      </Select>
                                    ) : (
                                      <span className="text-xs text-gray-400">—</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex flex-col">
                                      {comp ? (
                                         <span className="text-xs font-bold text-primary">{comp.name}</span>
                                      ) : (
                                         <span className="text-xs text-gray-400">Loose</span>
                                      )}
                                      <span className="text-[10px] uppercase opacity-50">{item.pocket}</span>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Input 
                                      type="number" size="sm" min={1}
                                      value={String(item.requiredQuantity)}
                                      onValueChange={(v) => updateItemInList(item, 'requiredQuantity', Number(v))}
                                    />
                                  </TableCell>
                                  <TableCell>
                                    <Button isIconOnly size="sm" color="danger" variant="light" onPress={() => removeItemFromBag(item)}>
                                      <Trash2 size={16} />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                          })}
                        </TableBody>
                    </Table>

                    <div className="flex flex-col gap-2 p-4 bg-white/80 dark:bg-slate-800/80 rounded-lg border border-indigo-100 dark:border-indigo-900">
                       <span className="text-xs font-bold text-gray-500 uppercase">Add to Bag</span>
                       <div className="flex gap-2 items-end">
                          <div className="w-1/2">
                            <Select 
                              label="Target Location" 
                              labelPlacement="outside"
                              placeholder="Select compartment or loose pocket"
                              size="sm"
                              selectedKeys={[targetLocationId]} 
                              onChange={(e) => setTargetLocationId(e.target.value)}
                            >
                              {getLocationOptions().map(opt => (
                                <SelectItem key={opt.key} textValue={opt.label}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </Select>
                          </div>
                          <div className="flex-grow">
                             <Autocomplete 
                                aria-label="Search Inventory"
                                placeholder="Search Inventory..." 
                                size="sm"
                                selectedKey={selectedInventoryId}
                                onSelectionChange={(key) => {
                                  const id = key as string;
                                  setSelectedInventoryId(id);
                                  const item = inventory.find(i => i.id === id);
                                  if (item?.hasVariants && item.variants && item.variants.length > 0) {
                                    setSelectedVariantId(item.variants[0].id);
                                  } else {
                                    setSelectedVariantId("");
                                  }
                                  if (item?.batches && item.batches.length > 0) {
                                    setSelectedBatchId(item.batches[0].id);
                                    const first = item.batches[0];
                                    // Prefer batch.serialNumbers, then batch.assetInstances.serial, then fallback to item.assets
                                    if (Array.isArray(first.serialNumbers) && first.serialNumbers.length > 0) {
                                      setSelectedSerialId(first.serialNumbers[0]);
                                    } else if (Array.isArray(first.assetInstances) && first.assetInstances.length > 0) {
                                      setSelectedSerialId(first.assetInstances[0].serial ?? "");
                                    } else if (Array.isArray(item.assets) && item.assets.length > 0) {
                                      setSelectedSerialId(item.assets[0].serial ?? "");
                                    } else {
                                      setSelectedSerialId("");
                                    }
                                  } else {
                                    setSelectedBatchId("");
                                    if (item && Array.isArray(item.assets) && item.assets.length > 0) setSelectedSerialId(item.assets[0].serial ?? "");
                                    else setSelectedSerialId("");
                                  }
                                }}
                              >
                                {inventory.map((item) => <AutocompleteItem key={item.id}>{item.name}</AutocompleteItem>)}
                            </Autocomplete>
                          </div>
                          {showVariantSelect && (
                            <div className="w-48">
                              <Select 
                                label="Variation" 
                                labelPlacement="outside"
                                placeholder="Select"
                                size="sm"
                                selectedKeys={selectedVariantId ? [selectedVariantId] : []}
                                onChange={(e) => setSelectedVariantId(e.target.value)}
                              >
                                {availableVariants.map(variant => (
                                  <SelectItem key={variant.id} textValue={variant.name}>
                                    {variant.name}
                                  </SelectItem>
                                ))}
                              </Select>
                            </div>
                          )}
                          {showBatchSelect && (
                            <div className="w-48">
                              <Select
                                label="Batch / Exp"
                                labelPlacement="outside"
                                placeholder="Select"
                                size="sm"
                                selectedKeys={selectedBatchId ? [selectedBatchId] : []}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setSelectedBatchId(val);
                                  const chosen = availableBatches.find(b => b.id === val);
                                  if (chosen && Array.isArray(chosen.serialNumbers) && chosen.serialNumbers.length > 0) {
                                    setSelectedSerialId(chosen.serialNumbers[0]);
                                  } else {
                                    setSelectedSerialId("");
                                  }
                                }}
                              >
                                {availableBatches.map(batch => (
                                  <SelectItem key={batch.id} textValue={`${batch.lotNumber || 'Lot'} • ${batch.expirationDate ? new Date(batch.expirationDate).toLocaleDateString() : 'No Exp'}`}>
                                    {batch.lotNumber || 'Lot'} • {batch.expirationDate ? new Date(batch.expirationDate).toLocaleDateString() : 'No Exp'}{Array.isArray(batch.serialNumbers) && batch.serialNumbers.length > 0 ? ` • ${batch.serialNumbers.length} serial(s)` : ''}
                                  </SelectItem>
                                ))}
                              </Select>
                            </div>
                          )}
                          {/* Serial selector for serialized batches (e.g., individual AED assets) */}
                          {showBatchSelect && selectedBatchId && selectedBatchHasSerials && (
                            <div className="w-48">
                              <Select
                                label="Serial"
                                labelPlacement="outside"
                                size="sm"
                                selectedKeys={selectedSerialId ? [selectedSerialId] : []}
                                onChange={(e) => setSelectedSerialId(e.target.value)}
                              >
                                {chosenBatchSerials.map((sn: string) => (
                                  <SelectItem key={sn} textValue={sn}>{sn}</SelectItem>
                                ))}
                              </Select>
                            </div>
                          )}
                          {/* Asset selector for asset-type items (no batches) */}
                          {showAssetSelect && (
                            <div className="w-48">
                              <Select
                                label="Asset"
                                labelPlacement="outside"
                                size="sm"
                                selectedKeys={selectedSerialId ? [selectedSerialId] : []}
                                onChange={(e) => setSelectedSerialId(e.target.value)}
                              >
                                {assetSerials.map(sn => (
                                  <SelectItem key={sn} textValue={sn}>{sn}</SelectItem>
                                ))}
                              </Select>
                            </div>
                          )}
                          <Button
                            onPress={addItemToBag}
                            isDisabled={
                              !selectedInventoryId ||
                              !targetLocationId ||
                              (showVariantSelect && !selectedVariantId) ||
                              (showBatchSelect && !selectedBatchId) ||
                              // If the selected batch contains serials, require selecting a serial
                              needSerialSelection ||
                              // If item is an asset, require selecting a specific asset serial
                              (showAssetSelect && !selectedSerialId)
                            }
                            color="primary"
                            size="sm"
                            className="mb-[2px]"
                          >
                            Add
                          </Button>
                       </div>
                      
                    </div>
                  </div>
                </div>

              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>Cancel</Button>
                <Button color="primary" onPress={() => handleSaveConfig(onClose)} isLoading={saving}>Save Config</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* --- 2. CHECKOUT / INSPECTION MODAL (FTO View) --- */}
      <Modal isOpen={isCheckoutOpen} onOpenChange={onCheckoutChange} size="full" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                Inspect & Checkout: {currentPack.name}
              </ModalHeader>
              <ModalBody className="flex flex-row gap-6 p-6 h-[calc(100vh-200px)]">
                
                {/* --- VISUALIZER SIDEBAR --- */}
                <div className="flex-none w-[480px] bg-content1 border-r border-default-200 pr-6 overflow-y-auto hidden xl:block rounded-l-lg">
                <div className="sticky top-0 pt-4">
                    <BagVisualizer 
                      statpack={currentPack as Statpack} 
                      selectedPocket={viewPocket} 
                      onSelectPocket={setViewPocket} 
                    />
                    <Divider className="my-6" />
                    <div className="px-6">
                    <Card className="bg-primary-50 dark:bg-primary-900/20 border-primary-100 dark:border-primary-800 border shadow-none">
                        <CardBody>
                        <p className="font-bold text-primary-800 dark:text-primary-300 mb-2 text-sm">Inspection Protocol:</p>
                        <ul className="list-disc list-inside space-y-1 text-sm text-primary-700 dark:text-primary-400">
                            <li>Select a pocket on the visualizer.</li>
                            <li>Verify physical count matches <strong>Required</strong>.</li>
                            <li>Check expiration dates on meds/airways.</li>
                        </ul>
                        </CardBody>
                    </Card>
                    </div>
                </div>
                </div>

                {/* Right: Inspection List */}
                <div className="flex-grow overflow-y-auto">
                   <h3 className="text-xl font-bold mb-4">
                     {viewPocket === 'all' ? "Entire Bag Contents" : `Contents of ${viewPocket.replace('_', ' ').toUpperCase()}`}
                   </h3>
                   
                   <Table aria-label="Inspection Table">
                    <TableHeader>
                      <TableColumn>ITEM NAME</TableColumn>
                      <TableColumn>LOCATION</TableColumn>
                      <TableColumn>REQUIRED</TableColumn>
                      <TableColumn width={150}>ACTUAL</TableColumn>
                      <TableColumn>STATUS</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="No items found in this pocket.">
                      {getVisibleItems().map((item, idx) => {
                         const name = item.itemDetails?.name || inventory.find(i => i.id === item.itemId)?.name || "Unknown";
                         const isLow = item.currentQuantity < item.requiredQuantity;
                         const comp = currentPack.compartments?.find(c => c.id === item.compartmentId);
                         const variantLabel = getVariantLabel(item);

                         return (
                           <TableRow key={`${item.itemId}_${idx}`}>
                             <TableCell>
                               <div className="flex flex-col">
                                 <span className="font-medium">{name}</span>
                                 <span className="text-xs text-gray-400">{item.itemDetails?.category}</span>
                                 {variantLabel && (
                                   <span className="text-[10px] text-gray-400">Variation: {variantLabel}</span>
                                 )}
                               </div>
                             </TableCell>
                             <TableCell>
                               <Chip size="sm" variant="flat" color={comp ? (comp.isSealed ? "success" : "primary") : "default"}>
                                 {comp ? comp.name : `${item.pocket} (Loose)`}
                               </Chip>
                             </TableCell>
                             <TableCell className="font-bold text-center text-lg">{item.requiredQuantity}</TableCell>
                             <TableCell>
                               <Input 
                                 type="number" size="lg" min={0}
                                 color={isLow ? "danger" : "success"}
                                 variant="bordered"
                                 value={String(item.currentQuantity)}
                                 onValueChange={(v) => updateItemInList(item, 'currentQuantity', Number(v))}
                               />
                             </TableCell>
                             <TableCell>
                               {isLow ? 
                                 <span className="text-danger font-bold flex items-center gap-1"><AlertCircle size={16}/> MISSING {item.requiredQuantity - item.currentQuantity}</span> 
                                 : <span className="text-success font-bold flex items-center gap-1"><CheckCircle size={16}/> OK</span>
                               }
                             </TableCell>
                           </TableRow>
                         );
                      })}
                    </TableBody>
                  </Table>

                  <div className="mt-8 max-w-2xl">
                    <Textarea 
                      label="Checkout Notes" 
                      placeholder="Report any damage, missing zipper pulls, or expiration dates..."
                      value={checkoutNotes}
                      onValueChange={setCheckoutNotes}
                    />
                  </div>
                </div>
              </ModalBody>
              <ModalFooter className="border-t">
                <Button variant="light" onPress={onClose}>Cancel</Button>
                <Button 
                  color="primary" 
                  size="lg"
                  onPress={() => handleSubmitCheckout(onClose)} 
                  isLoading={saving}
                  startContent={<ClipboardCheck size={20} />}
                >
                  Confirm & Checkout
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* --- 3. HISTORY MODAL (Updated with detailed Table) --- */}
      <Modal 
        isOpen={isHistoryOpen} 
        onOpenChange={onHistoryChange} 
        size="4xl" 
        scrollBehavior="inside"
        backdrop="blur"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 border-b border-gray-200 dark:border-slate-700">
                <div className="text-xl font-bold">{currentPack.name} Audit Log</div>
                <p className="text-sm font-normal text-gray-500">History of checkouts, returns, and inventory replacements.</p>
              </ModalHeader>
              <ModalBody className="p-0">
                <Table aria-label="Log Table" removeWrapper classNames={{ base: "min-h-[400px]", th: "bg-gray-100 dark:bg-slate-800" }}>
                  <TableHeader>
                    <TableColumn>TIMESTAMP</TableColumn>
                    <TableColumn>USER</TableColumn>
                    <TableColumn>ACTION</TableColumn>
                    <TableColumn width={400}>DETAILS / ISSUES</TableColumn>
                  </TableHeader>
                  <TableBody items={logs} emptyContent="No logs found for this statpack.">
                    {(log) => (
                      <TableRow key={log.id} className="border-b border-gray-100 dark:border-slate-800 last:border-0">
                        <TableCell>
                            <div className="flex flex-col">
                              {/* Safely handle potential date conversion if not fully processed by fetchLogs */}
                              <span className="font-bold text-sm">
                                {log.timestamp instanceof Date ? log.timestamp.toLocaleDateString() : 'Invalid Date'}
                              </span>
                              <span className="text-xs text-gray-400">
                                {log.timestamp instanceof Date ? log.timestamp.toLocaleTimeString() : ''}
                              </span>
                            </div>
                        </TableCell>
                        <TableCell>
                            <ResolvedUserAvatar
                              userId={log.userId}
                              name={log.userName}
                              description={log.userId ? `ID: ${log.userId.substring(0,6)}` : 'System'}
                            />
                        </TableCell>
                        <TableCell>
                            <Chip 
                              size="sm" 
                              variant="flat" 
                              color={log.action === 'checkout' ? 'warning' : log.action === 'checkin' ? 'success' : 'default'}
                              className="capitalize"
                            >
                              {log.action}
                            </Chip>
                        </TableCell>
                        <TableCell>
                            {renderLogDetails(log)}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ModalBody>
              <ModalFooter className="border-t border-gray-200 dark:border-slate-700">
                <Button color="primary" onPress={onClose}>Done</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* --- 4. QR CODE MODAL --- */}
      <Modal isOpen={isQrOpen} onOpenChange={onQrChange} size="lg" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Checkout QR Code</ModalHeader>
              <ModalBody>
                <div className="flex flex-col items-center gap-4">
                  <div className="text-center">
                    <p className="font-semibold text-lg">{qrPack?.name || 'Statpack'}</p>
                    <p className="text-xs text-gray-500">Opens the mobile checkout page for this statpack.</p>
                  </div>
                  <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
                    {qrLoading ? (
                      <Spinner size="sm" />
                    ) : qrDataUrl ? (
                      <Image
                        src={qrDataUrl}
                        alt={`QR code for ${qrPack?.name ?? 'statpack'}`}
                        width={192}
                        height={192}
                        className="w-48 h-48"
                        unoptimized
                      />
                    ) : (
                      <p className="text-xs text-gray-500">QR code unavailable.</p>
                    )}
                  </div>
                  {qrUrl && (
                    <p className="text-xs text-gray-500 break-all text-center">{qrUrl}</p>
                  )}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>Close</Button>
                <Button 
                  color="primary" 
                  onPress={handleDownloadQrPdf}
                  isDisabled={qrLoading || !qrDataUrl || !qrPack}
                >
                  Download PDF
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

    </div>
  );
}