'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, CardFooter,
  Button, Chip, Divider, Spinner,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Input, Select, SelectItem, useDisclosure,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Autocomplete, AutocompleteItem, Tooltip, Textarea
} from '@heroui/react';
import { onAuthStateChanged } from 'firebase/auth';
import { 
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, where, orderBy, limit 
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 
import { 
  Plus, BriefcaseMedical, AlertCircle, CheckCircle, 
  Trash2, Save, X, ClipboardCheck, History, UserMinus, UserCheck, Eye
} from 'lucide-react';

// --- Imports for Visualization ---
import type { Statpack, InventoryItem, StatpackItem, StatpackLog, StatpackPocket } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer'; 

const BLANK_PACK: Partial<Statpack> = {
  name: "",
  type: "Primary",
  status: "Restock Needed",
  contents: [],
  isCheckedOut: false
};

export default function StatpacksPage(): JSX.Element {
  const router = useRouter();
  
  // Modals Control
  const { isOpen: isEditOpen, onOpen: onEditOpen, onOpenChange: onEditChange } = useDisclosure();
  const { isOpen: isCheckoutOpen, onOpen: onCheckoutOpen, onOpenChange: onCheckoutChange } = useDisclosure();
  const { isOpen: isHistoryOpen, onOpen: onHistoryOpen, onOpenChange: onHistoryChange } = useDisclosure();
  
  const [user, setUser] = useState<any>(null);
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

  // --- NEW: Visualizer State ---
  const [viewPocket, setViewPocket] = useState<StatpackPocket | 'all'>('all');
  const [targetPocket, setTargetPocket] = useState<StatpackPocket>('main'); 

  // 1. Auth & Data
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
      await fetchData();
    });
    return () => unsubscribe();
  }, [router]);

  const fetchData = async () => {
    try {
      const packsSnap = await getDocs(collection(db, 'statpacks'));
      const packsData = packsSnap.docs.map(d => ({ 
        id: d.id, ...d.data(),
        lastCheckedAt: d.data().lastCheckedAt?.toDate(),
        checkedOutAt: d.data().checkedOutAt?.toDate(),
      })) as Statpack[];
      
      const invSnap = await getDocs(collection(db, 'inventory'));
      const invData = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];

      setStatpacks(packsData);
      setInventory(invData);
    } catch (err) {
      console.error("Error fetching data:", err);
    } finally {
      setLoading(false);
    }
  };

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
    setCurrentPack({ ...pack, contents: pack.contents.map(item => ({...item})) });
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

  // 3. Handlers: Inventory Management
  const addItemToBag = () => {
    if (!selectedInventoryId || !currentPack.contents) return;
    
    if (currentPack.contents.some(i => i.itemId === selectedInventoryId && i.pocket === targetPocket)) {
      alert("Item already in this pocket!");
      return;
    }

    const masterItem = inventory.find(i => i.id === selectedInventoryId);
    if (!masterItem) return;

    const newItem: StatpackItem = {
      itemId: masterItem.id,
      itemDetails: masterItem,
      requiredQuantity: 1,     
      currentQuantity: 0,
      pocket: targetPocket 
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
    if (!currentPack.name) return;
    setSaving(true);
    try {
      const payload: any = { ...currentPack, updatedAt: serverTimestamp() };
      Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);
      
      const logEntry: StatpackLog = {
        statpackId: currentPack.id || 'new',
        statpackName: currentPack.name,
        action: 'maintenance',
        userId: user.uid,
        userName: user.displayName || user.email,
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

      await fetchData();
      onClose();
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitCheckout = async (onClose: () => void) => {
    if (!currentPack.id) return;
    setSaving(true);
    try {
      // UPDATED: Automatically set status to "In Use" when checking out
      const newStatus: Statpack['status'] = 'In Use';

      const updatePayload = {
        contents: currentPack.contents,
        status: newStatus,
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: user.displayName || user.email,
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
        userName: user.displayName || user.email,
        timestamp: serverTimestamp(),
        notes: checkoutNotes || `Bag checked out for use`
      };
      await addDoc(collection(db, 'statpack_logs'), logEntry);

      await fetchData();
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleReturnBag = async (pack: Statpack) => {
    if (!confirm(`Return ${pack.name}?`)) return;
    setLoading(true);
    try {
      // UPDATED: Recalculate status upon return so it doesn't stay "In Use"
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

      // Add log for check-in
      await addDoc(collection(db, 'statpack_logs'), {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkin',
        userId: user.uid,
        userName: user.displayName || user.email,
        timestamp: serverTimestamp(),
        notes: `Bag returned. Status set to: ${newStatus}`
      });

      await fetchData();
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

  // UPDATED: Added 'In Use' to status colors
  const getStatusColor = (s: string) => {
    if(s === 'Ready') return 'success';
    if(s === 'In Use') return 'warning'; // Shows as yellow/orange
    if(s === 'Expired Items') return 'danger';
    return 'warning'; // Fallback
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
              </CardBody>
              <CardFooter className="bg-indigo-50/70 dark:bg-slate-800/60 flex gap-2">
                {pack.isCheckedOut ? (
                   <Button fullWidth color="warning" variant="flat" onPress={() => handleReturnBag(pack)}>
                    Return / Check In
                  </Button>
                ) : (
                  <Button fullWidth color="primary" onPress={() => handleOpenCheckout(pack)} startContent={<ClipboardCheck size={18} />}>
                    Inspect & Check Out
                  </Button>
                )}
                
                {/* TEMPORARY: Developer Shortcut to simulate scanning a QR code */}
                {/* UPDATED: Points to /mobile/[id] instead of /mobile/checkout/[id] */}
                <a 
                  href={`/mobile/${pack.id}`} 
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
                  <Select label="Type" selectedKeys={currentPack.type ? [currentPack.type] : []} onChange={(e) => setCurrentPack(p => ({...p, type: e.target.value as any}))}>
                    <SelectItem key="Primary">Primary</SelectItem>
                    <SelectItem key="Secondary">Secondary</SelectItem>
                  </Select>
                  <Select label="Forced Status" selectedKeys={currentPack.status ? [currentPack.status] : []} onChange={(e) => setCurrentPack(p => ({...p, status: e.target.value as any}))}>
                    <SelectItem key="Ready">Ready</SelectItem>
                    <SelectItem key="Restock Needed">Restock Needed</SelectItem>
                    <SelectItem key="In Use">In Use</SelectItem>
                  </Select>
                </div>
                
                <Divider className="my-2" />
                
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
                          <TableColumn>POCKET</TableColumn>
                          <TableColumn width={100}>REQ QTY</TableColumn>
                          <TableColumn width={50}>DEL</TableColumn>
                        </TableHeader>
                        <TableBody emptyContent="No items in this pocket.">
                          {getVisibleItems().map((item, idx) => (
                              <TableRow key={`${item.itemId}_${idx}`}>
                                <TableCell>{item.itemDetails?.name || inventory.find(i => i.id === item.itemId)?.name || "Item"}</TableCell>
                                <TableCell>
                                  <Chip size="sm" variant="flat" color="primary">{item.pocket || 'main'}</Chip>
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
                          ))}
                        </TableBody>
                    </Table>

                    {/* Add Item Logic */}
                    <div className="flex flex-col gap-2 p-4 bg-white/80 dark:bg-slate-800/80 rounded-lg">
                       <span className="text-xs font-bold text-gray-500 uppercase">Add to Bag</span>
                       <div className="flex gap-2 items-end">
                          <div className="w-1/3">
                            <Select 
                              label="Target Pocket" 
                              labelPlacement="outside"
                              placeholder="Select pocket"
                              size="sm"
                              selectedKeys={[targetPocket]} 
                              onChange={(e) => setTargetPocket(e.target.value as StatpackPocket)}
                            >
                              <SelectItem key="main">Main</SelectItem>
                              <SelectItem key="front_aux">Front Aux</SelectItem>
                              <SelectItem key="side_left">Left Side</SelectItem>
                              <SelectItem key="side_right">Right Side</SelectItem>
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
                          <Button onPress={addItemToBag} isDisabled={!selectedInventoryId} color="primary" size="sm" className="mb-[2px]">Add</Button>
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
                
                {/* --- VISUALIZER SIDEBAR (Inside Checkout Modal) --- */}
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
                      <TableColumn>POCKET</TableColumn>
                      <TableColumn>REQUIRED</TableColumn>
                      <TableColumn width={150}>ACTUAL</TableColumn>
                      <TableColumn>STATUS</TableColumn>
                    </TableHeader>
                    <TableBody emptyContent="No items found in this pocket.">
                      {getVisibleItems().map((item, idx) => {
                         const name = item.itemDetails?.name || inventory.find(i => i.id === item.itemId)?.name || "Unknown";
                         const isLow = item.currentQuantity < item.requiredQuantity;
                         
                         return (
                           <TableRow key={`${item.itemId}_${idx}`}>
                             <TableCell>
                               <div className="flex flex-col">
                                 <span className="font-medium">{name}</span>
                                 <span className="text-xs text-gray-400">{item.itemDetails?.category}</span>
                               </div>
                             </TableCell>
                             <TableCell><Chip size="sm" variant="flat">{item.pocket || 'main'}</Chip></TableCell>
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
                             {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleString() : 'Just now'}
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

    </div>
  );
}
