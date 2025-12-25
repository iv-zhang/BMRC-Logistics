'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, Tab, Tabs, Chip, Progress, Button, Spinner, Divider, useDisclosure 
} from '@heroui/react';
import { Boxes, Plus } from 'lucide-react';

// Firebase Imports
import { onAuthStateChanged } from 'firebase/auth';
import { 
  collection, 
  addDoc,
  doc,
  updateDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  serverTimestamp, 
  Timestamp 
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 

import InventoryModal from '@/app/components/additemmodal';

// Types
import { InventoryItem, ItemCategory } from '@/app/types';

export default function InventoryPage(): JSX.Element {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);

  // --- EFFECT 1: Handle Authentication ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
      } else {
        // If not logged in, redirect
        router.push('/login');
      }
    });
    return () => unsubscribe();
  }, [router]);

  // --- EFFECT 2: Handle Data Fetching (Only runs when 'user' is ready) ---
  useEffect(() => {
    // STOP: Do not run this code if user is not logged in yet
    if (!user) return;

    const q = query(collection(db, 'inventory'), orderBy('name'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => {
        const data = doc.data();
        const getDate = (ts: any) => (ts instanceof Timestamp ? ts.toDate() : new Date());

        return {
          id: doc.id,
          name: data.name,
          category: data.category,
          description: data.description,
          
          location: data.location || 'HQ',
          room: data.room || undefined,
          shelf: data.shelf || 'General Storage',

          totalStockQuantity: data.totalStockQuantity,
          unit: data.unit,
          reorderThreshold: data.reorderThreshold,
          isDisposable: data.isDisposable,
          
          expirationDate: data.expirationDate ? getDate(data.expirationDate) : undefined,

          createdAt: getDate(data.createdAt),
          updatedAt: getDate(data.updatedAt),
        } as InventoryItem;
      });

      setInventory(items);
      setLoading(false);
    }, (error) => {
      console.error("Inventory listener error:", error);
    });

    return () => unsubscribe();
  }, [user]); // <--- This dependency ensures we wait for 'user'

  // --- CRUD HANDLERS ---

  const handleAddItem = async (newItemData: Partial<InventoryItem>) => {
    try {
      await addDoc(collection(db, 'inventory'), {
        ...newItemData,
        // FIX: Firestore cannot save 'undefined'. 
        // We use '?? null' to ensure if it's undefined, it becomes null.
        expirationDate: newItemData.expirationDate ?? null,
        room: newItemData.room ?? null, 
        
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error adding document: ", error);
      alert("Failed to add item.");
    }
  };

  const handleUpdateItem = async (id: string, updatedData: Partial<InventoryItem>) => {
    try {
      const itemRef = doc(db, 'inventory', id);
      await updateDoc(itemRef, {
        ...updatedData,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error updating document: ", error);
      alert("Failed to update item.");
    }
  };

  const openAddModal = () => {
    setSelectedItem(null);
    onOpen();
  };

  const openEditModal = (item: InventoryItem) => {
    setSelectedItem(item); 
    onOpen();
  };

  // --- RENDER HELPERS ---
  
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

  const getExpirationStatus = (date?: Date) => {
    if (!date) return null;
    const now = new Date();
    const expiry = new Date(date);
    const diffTime = expiry.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { label: 'EXPIRED', color: 'danger' as const, isExpired: true };
    if (diffDays < 30) return { label: `Exp in ${diffDays}d`, color: 'warning' as const, isExpired: false };
    return { label: `Exp: ${expiry.toLocaleDateString()}`, color: 'default' as const, isExpired: false };
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <Spinner />
      </div>
    );
  }

  const lowStockItems = inventory.filter(i => i.totalStockQuantity <= i.reorderThreshold);
  const criticalStockItems = inventory.filter(i => i.totalStockQuantity === 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-800 dark:text-white mb-1 flex items-center gap-2">
              <Boxes className="text-indigo-600" size={28} />
              Master Inventory
            </h1>
            <p className="text-gray-600 dark:text-gray-400">Manage the supply closet</p>
          </div>
          
          <Button 
            onPress={openAddModal}
            color="primary"
            startContent={<Plus size={18} />}
          >
            Add Item
          </Button>
        </div>
        <Divider />

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card className="shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
            <CardBody className="p-6">
              <p className="text-gray-600 dark:text-gray-400 text-sm mb-2">Total SKUs</p>
              <p className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">{inventory.length}</p>
            </CardBody>
          </Card>
          <Card className="shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
            <CardBody className="p-6">
              <p className="text-gray-600 dark:text-gray-400 text-sm mb-2">Reorder Needed</p>
              <p className="text-3xl font-bold text-orange-500 dark:text-orange-400">{lowStockItems.length}</p>
            </CardBody>
          </Card>
          <Card className="shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
            <CardBody className="p-6">
              <p className="text-gray-600 dark:text-gray-400 text-sm mb-2">Critical (Out)</p>
              <p className="text-3xl font-bold text-red-600 dark:text-red-400">{criticalStockItems.length}</p>
            </CardBody>
          </Card>
          <Card className="shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
            <CardBody className="p-6">
              <p className="text-gray-600 dark:text-gray-400 text-sm mb-2">Categories</p>
              <p className="text-3xl font-bold text-purple-600 dark:text-purple-400">{new Set(inventory.map(i => i.category)).size}</p>
            </CardBody>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Card className="shadow-lg bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
          <CardHeader className="flex flex-col gap-2 p-6 border-b border-gray-200/70 dark:border-slate-700">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Supply Closet</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">Browse and update items across storage locations.</p>
          </CardHeader>
          
          <CardBody className="p-6">
            <Tabs aria-label="Inventory Options" variant="underlined" color="primary">
              
              {/* TAB 1: ALL ITEMS */}
              <Tab key="all" title="All Items">
                <div className="space-y-4 mt-2">
                  {inventory.map((item) => {
                    const expStatus = getExpirationStatus(item.expirationDate);
                    const isExpired = expStatus?.isExpired;
                    
                    const cardClasses = isExpired 
                      ? "w-full border border-red-300 dark:border-red-700 bg-red-50/70 dark:bg-red-900/20 rounded-xl transition-shadow cursor-pointer"
                      : "w-full bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl hover:shadow-md transition-shadow cursor-pointer";

                    return (
                        <Card 
                            key={item.id} 
                            isPressable
                            onPress={() => openEditModal(item)}
                            className={cardClasses}
                        >
                        <CardBody className="p-4">
                            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            {/* Left: Item Details */}
                            <div className="flex-1 w-full">
                                <div className="flex items-center gap-3 mb-2">
                                    <h3 className="font-bold text-lg text-gray-800 dark:text-white">{item.name}</h3>
                                    <Chip size="sm" color={getCategoryColor(item.category)} variant="flat">
                                        {item.category}
                                    </Chip>
                                    
                                    {/* EXPIRATION CHIP */}
                                    {expStatus && (
                                      <Chip 
                                        size="sm" 
                                        color={expStatus.color} 
                                        variant="flat" 
                                        className="font-semibold"
                                      >
                                        {expStatus.label}
                                      </Chip>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                                <Chip size="sm" variant="dot" color="default" className="bg-gray-100 dark:bg-slate-800 border-none">
                                    <span className="font-semibold">{item.location}</span>
                                </Chip>
                                {item.location === 'HQ' && item.room && (
                                    <>
                                    <span className="text-gray-300">/</span>
                                    <span className="text-gray-500 dark:text-gray-300 font-medium">{item.room}</span>
                                    </>
                                )}
                                <span className="text-gray-300">/</span>
                                <span className="text-gray-500 dark:text-gray-300">Shelf: {item.shelf}</span>
                                </div>

                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                Unit: {item.unit} - {item.isDisposable ? 'Disposable' : 'Reusable Asset'}
                                </p>
                            </div>

                            {/* Right: Stock Levels */}
                            <div className="text-right flex items-center gap-6 min-w-fit">
                                <div>
                                    <p className={`text-3xl font-bold ${getStockStatusColor(item.totalStockQuantity, item.reorderThreshold)}`}>
                                    {item.totalStockQuantity}
                                    </p>
                                    <p className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider">
                                        Available
                                    </p>
                                </div>
                            </div>
                            </div>
                            
                            <div className="mt-4">
                                <Progress 
                                    size="sm" 
                                    value={item.reorderThreshold > 0 ? (item.totalStockQuantity / (item.reorderThreshold * 2)) * 100 : 100} 
                                    color={item.totalStockQuantity <= item.reorderThreshold ? "warning" : "success"}
                                    aria-label="Stock level"
                                />
                            </div>
                        </CardBody>
                        </Card>
                    );
                  })}
                </div>
              </Tab>

              {/* TAB 2: LOW STOCK */}
              <Tab key="low-stock" title={
                  <div className="flex items-center gap-2">
                    <span>Restock Needed</span>
                    {lowStockItems.length > 0 && <Chip size="sm" color="danger" variant="solid">{lowStockItems.length}</Chip>}
                  </div>
              }>
                <div className="space-y-4 mt-2">
                  {lowStockItems.map((item) => {
                    const expStatus = getExpirationStatus(item.expirationDate);
                    return (
                      <Card 
                          key={item.id} 
                          isPressable
                          onPress={() => openEditModal(item)}
                          className="w-full border border-red-200 dark:border-red-700 border-l-4 border-red-500 bg-white/80 dark:bg-slate-800/80 rounded-xl"
                      >
                        <CardBody className="p-4">
                          <div className="flex justify-between items-start">
                            <div>
                                <h3 className="font-bold text-gray-800 dark:text-white">{item.name}</h3>
                                <div className="flex items-center gap-2 mt-1">
                                  <p className="text-red-500 text-sm font-semibold">
                                    Below Threshold ({item.reorderThreshold})
                                  </p>
                                  {expStatus && (
                                    <Chip size="sm" color={expStatus.color} variant="flat" className="text-xs h-5">
                                      {expStatus.label}
                                    </Chip>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 mt-2">
                                  {item.location} {item.room} - {item.shelf}
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-2xl font-bold text-red-600">{item.totalStockQuantity}</p>
                                <p className="text-xs text-gray-500">Current</p>
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    );
                  })}
                </div>
              </Tab>

            </Tabs>
          </CardBody>
        </Card>

        {/* Modal Component */}
        <InventoryModal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            onAddItem={handleAddItem}
            onUpdateItem={handleUpdateItem}
            initialData={selectedItem}
        />

      </div>
    </div>
  );
}
