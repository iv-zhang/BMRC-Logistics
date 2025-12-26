'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, CardFooter,
  Button, Chip, Divider, Spinner,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Input, Select, SelectItem, useDisclosure,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Autocomplete, AutocompleteItem, Tooltip, Textarea, Checkbox
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { 
  collection, addDoc, updateDoc, doc, serverTimestamp, query, where, orderBy, limit, onSnapshot, getDocs, Timestamp
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 
import Image from 'next/image';
import { 
  Plus, BriefcaseMedical, AlertCircle, CheckCircle, 
  Trash2, ClipboardCheck, History, UserMinus, UserCheck, QrCode,
  Package, Lock, Unlock
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
// Firestore throws an error if fields are 'undefined'. 
// This strips undefined keys deeply but preserves Dates.
const cleanData = (data: any): any => {
  if (Array.isArray(data)) {
    return data.map(item => cleanData(item));
  } else if (data !== null && typeof data === 'object') {
    // Preserve Date objects
    if (data instanceof Date) return data;
    // Preserve Firestore Timestamps if they exist in state
    if (data.toMillis && typeof data.toMillis === 'function') return data;

    const newObj: any = {};
    Object.keys(data).forEach(key => {
      const val = data[key];
      // Only copy if value is NOT undefined
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
  const [checkoutNotes, setCheckoutNotes] = useState("");
  const [qrPack, setQrPack] = useState<Statpack | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [qrLoading, setQrLoading] = useState(false);

  // --- Visualizer State ---
  const [viewPocket, setViewPocket] = useState<StatpackPocket | 'all'>('all');

  // --- NEW: Compartment Management State ---
  const [newCompName, setNewCompName] = useState('');
  const [newCompPocket, setNewCompPocket] = useState<StatpackPocket>('main');
  const [newCompSealed, setNewCompSealed] = useState(false);
  const [newCompSealNum, setNewCompSealNum] = useState('');
  const [newCompExpires, setNewCompExpires] = useState('');
  
  // Replaces the old "targetPocket" state
  // This will hold either a Compartment ID OR a raw pocket string if we allow loose items
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
          // Ensure compartments exists
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
        limit(20)
      );
      const snap = await getDocs(q);
      const logData = snap.docs.map(d => ({ id: d.id, ...d.data() })) as StatpackLog[];
      setLogs(logData);
    } catch (e) {
      console.error("Log fetch error", e);
    }
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

  // --- NEW: Compartment Logic ---

  const handleAddCompartment = () => {
    if (!newCompName) return;
    
    // Simple ID gen (in real app use uuid or similar)
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

    // Reset Form
    setNewCompName('');
    setNewCompSealNum('');
    setNewCompExpires('');
    setNewCompSealed(false);
  };

  const handleRemoveCompartment = (compId: string) => {
    setCurrentPack(prev => ({
      ...prev,
      compartments: prev.compartments?.filter(c => c.id !== compId),
      // Set items in this compartment to 'undefined' compartment (loose in parent pocket? or remove?)
      // Here we just un-assign the compartment but keep the pocket info
      contents: prev.contents?.map(item => 
        item.compartmentId === compId ? { ...item, compartmentId: undefined } : item
      )
    }));
  };

  // 3. Handlers: Inventory Management
  const addItemToBag = () => {
    if (!selectedInventoryId || !targetLocationId || !currentPack.contents) return;
    
    // Identify if targetLocationId is a Compartment ID or a Raw Pocket string
    const compartments = currentPack.compartments || [];
    const matchedCompartment = compartments.find(c => c.id === targetLocationId);
    
    let finalPocket: StatpackPocket;
    let finalCompartmentId: string | undefined;

    if (matchedCompartment) {
      finalPocket = matchedCompartment.parentPocket;
      finalCompartmentId = matchedCompartment.id;
    } else {
      // It's a raw pocket
      finalPocket = targetLocationId as StatpackPocket;
      finalCompartmentId = undefined;
    }

    const masterItem = inventory.find(i => i.id === selectedInventoryId);
    if (!masterItem) return;

    const newItem: StatpackItem = {
      itemId: masterItem.id,
      itemDetails: masterItem,
      requiredQuantity: 1,     
      currentQuantity: 0,
      pocket: finalPocket,
      compartmentId: finalCompartmentId
    };

    setCurrentPack(prev => ({ ...prev, contents: [...(prev.contents || []), newItem] }));
    setSelectedInventoryId(""); 
  };

  const updateItemInList = (itemToUpdate: StatpackItem, field: string, val: number) => {
    setCurrentPack(prev => ({
        ...prev,
        contents: prev.contents?.map(i => 
            (i === itemToUpdate) ? { ...i, [field]: val } : i
        )
    }));
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
      // Use helper to remove undefined values from contents and compartments
      const cleanedPack = cleanData(currentPack);

      const payload: Record<string, unknown> = { ...cleanedPack, updatedAt: serverTimestamp() };
      
      // Simple shallow cleanup for top-level keys just in case, though cleanData handles deep
      Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);
      
      const userName = user.displayName || user.email || 'Unknown User';
      
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
      const userName = user.displayName || user.email || 'Unknown User';
      const newStatus: Statpack['status'] = 'In Use';

      // Ensure contents are cleaned of undefined values (e.g. compartmentId)
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
    const userName = user.displayName || user.email || 'Unknown User';
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

  const formatLogTimestamp = (value: StatpackLog['timestamp']) => {
    if (value instanceof Timestamp) {
      return value.toDate().toLocaleString();
    }
    if (value instanceof Date) {
      return value.toLocaleString();
    }
    return 'Just now';
  };

  const canReturnPack = (pack: Statpack) => {
    if (!user) return false;
    return userRole === 'admin' || pack.assignedToUserId === user.uid;
  };

  // Helper to generate selection options for adding items
  const getLocationOptions = () => {
    const opts: {key: string, label: string, group: string}[] = [];
    
    // 1. Defined Compartments
    if (currentPack.compartments) {
       currentPack.compartments.forEach(c => {
          opts.push({ 
             key: c.id, 
             label: `${c.name} (${c.isSealed ? 'Sealed' : 'Unsealed'})`, 
             group: c.parentPocket.replace('_', ' ').toUpperCase()
          });
       });
    }

    // 2. Loose Pockets (Fallbacks)
    const pockets: StatpackPocket[] = ['main', 'front_aux', 'side_left', 'side_right'];
    pockets.forEach(p => {
       opts.push({ key: p, label: `${p.replace('_', ' ')} (Loose)`, group: 'LOOSE' });
    });
    
    return opts;
  };

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
              <CardFooter className="bg-indigo-50/70 dark:bg-slate-800/60 flex gap-2">
                {pack.isCheckedOut ? (
                  <Tooltip 
                    content="Only the assignee or an admin can return this bag." 
                    isDisabled={canReturnPack(pack)}
                  >
                    <span className="w-full">
                      <Button 
                        fullWidth 
                        color="warning" 
                        variant="flat" 
                        onPress={() => handleReturnBag(pack)}
                        isDisabled={!canReturnPack(pack)}
                      >
                        Return / Check In
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button fullWidth color="primary" onPress={() => handleOpenCheckout(pack)} startContent={<ClipboardCheck size={18} />}>
                    Inspect & Check Out
                  </Button>
                )}
                
                <a 
                  href={`/mobile?id=${pack.id}`} 
                  target="_blank"
                  className="text-[10px] text-blue-500 hover:text-blue-700 underline uppercase tracking-widest mt-1 text-center w-full"
                >
                  [DEV] Simulate QR Scan
                </a>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>

      {/* --- 1. EDIT CONFIGURATION MODAL --- */}
      <Modal isOpen={isEditOpen} onOpenChange={onEditChange} size="5xl" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Edit Configuration: {currentPack.name}</ModalHeader>
              <ModalBody>
                 {/* Top Controls: Name, Type, Status */}
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
                  
                  {/* Compartment Creator Form */}
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
                          <TableColumn>LOCATION</TableColumn>
                          <TableColumn width={100}>REQ QTY</TableColumn>
                          <TableColumn width={50}>DEL</TableColumn>
                        </TableHeader>
                        <TableBody emptyContent="No items in this pocket.">
                          {getVisibleItems().map((item, idx) => {
                              const comp = currentPack.compartments?.find(c => c.id === item.compartmentId);
                              return (
                                <TableRow key={`${item.itemId}_${idx}`}>
                                  <TableCell>{item.itemDetails?.name || inventory.find(i => i.id === item.itemId)?.name || "Item"}</TableCell>
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

                    {/* UPDATED: Add Item Logic using Compartments */}
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
                                onSelectionChange={(key) => setSelectedInventoryId(key as string)}
                              >
                                {inventory.map((item) => <AutocompleteItem key={item.id}>{item.name}</AutocompleteItem>)}
                            </Autocomplete>
                          </div>
                          <Button onPress={addItemToBag} isDisabled={!selectedInventoryId || !targetLocationId} color="primary" size="sm" className="mb-[2px]">Add</Button>
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

                         return (
                           <TableRow key={`${item.itemId}_${idx}`}>
                             <TableCell>
                               <div className="flex flex-col">
                                 <span className="font-medium">{name}</span>
                                 <span className="text-xs text-gray-400">{item.itemDetails?.category}</span>
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

      {/* --- 3. HISTORY MODAL --- */}
      <Modal isOpen={isHistoryOpen} onOpenChange={onHistoryChange} size="2xl" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Audit Trail</ModalHeader>
              <ModalBody>
                {logs.length === 0 ? <p className="text-gray-500">No history available.</p> : (
                  <ul className="space-y-4">
                    {logs.map(log => (
                      <li key={log.id} className="border-b pb-2">
                        <div className="flex justify-between">
                          <span className="font-bold capitalize">{log.action}</span>
                          <span className="text-xs text-gray-400">
                             {formatLogTimestamp(log.timestamp)}
                          </span>
                        </div>
                        <p className="text-sm">{log.notes}</p>
                        <p className="text-xs text-gray-500">by {log.userName}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </ModalBody>
              <ModalFooter><Button onPress={onClose}>Close</Button></ModalFooter>
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