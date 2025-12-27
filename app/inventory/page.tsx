'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, Chip, Progress, Button, Spinner, useDisclosure, Input, 
  Select, SelectItem
} from '@heroui/react';
import { Boxes, Plus, Search, Wind, PackageOpen, Filter, X } from 'lucide-react';

// Firebase Imports
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
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
import { InventoryItem, ItemCategory, LocationType, User } from '@/app/types';

// Constants for Filters
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const LOCATIONS: LocationType[] = ['HQ', 'CPR Closet', 'Shed'];

export default function InventoryPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const isAdmin = userRole === 'admin';

  // --- SEARCH & FILTER STATE ---
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterLocation, setFilterLocation] = useState<string>('all');

  // --- AUTH & ROLE LOGIC ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) setUser(currentUser);
      else router.push('/login');
    });
    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userRef, (snapshot) => {
        const data = snapshot.data() as User | undefined;
        setUserRole(data?.role ?? 'member');
    });
    return () => unsubscribe();
  }, [user]);

  // --- DATA FETCHING ---
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => {
        const data = doc.data();
        const getDate = (ts: unknown) => (ts instanceof Timestamp ? ts.toDate() : undefined);
        
        return {
          id: doc.id,
          ...data,
          // Sanitization
          location: data.location || 'HQ',
          totalStockQuantity: data.totalStockQuantity ?? 0,
          unopenedQuantity: data.unopenedQuantity ?? 0,
          openedQuantity: data.openedQuantity ?? 0,
          quantityPerUnit: data.quantityPerUnit ?? 1,
          oxygenPsi: data.oxygenPsi ?? 0,
          maxOxygenPsi: data.maxOxygenPsi ?? 2000,
          
          expirationDate: getDate(data.expirationDate),
          openedAt: getDate(data.openedAt),
          createdAt: getDate(data.createdAt) || new Date(),
          updatedAt: getDate(data.updatedAt) || new Date(),
        } as InventoryItem;
      });

      setInventory(items);
      setLoading(false);
    }, (error) => console.error("Inventory listener error:", error));

    return () => unsubscribe();
  }, [user]);

  // --- CRUD HANDLERS ---
  const handleAddItem = async (newItemData: Partial<InventoryItem>) => {
    try {
      const cleanData = JSON.parse(JSON.stringify(newItemData)); 
      await addDoc(collection(db, 'inventory'), {
        ...cleanData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error adding item: ", error);
      alert("Failed to add item.");
    }
  };

  const handleUpdateItem = async (id: string, updatedData: Partial<InventoryItem>) => {
    try {
      const itemRef = doc(db, 'inventory', id);
      const cleanData = JSON.parse(JSON.stringify(updatedData));
      await updateDoc(itemRef, {
        ...cleanData,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Error updating item: ", error);
      alert("Failed to update item.");
    }
  };

  const openAddModal = () => { setSelectedItem(null); onOpen(); };
  const openEditModal = (item: InventoryItem) => { setSelectedItem(item); onOpen(); };

  // --- HELPERS ---
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

  const getEffectiveExpiration = (item: InventoryItem) => {
    if (!item.tracksExpiration) return null;

    let targetDate = item.expirationDate ? new Date(item.expirationDate) : null;
    let labelPrefix = "Exp";

    if (item.hasSecondaryExpiration && item.openedAt && item.secondaryExpirationDays) {
       const openDate = new Date(item.openedAt);
       const secondaryExpiry = new Date(openDate);
       secondaryExpiry.setDate(openDate.getDate() + item.secondaryExpirationDays);

       if (!targetDate || secondaryExpiry < targetDate) {
           targetDate = secondaryExpiry;
           labelPrefix = "Exp (Open)";
       }
    }

    if (!targetDate) return null;

    const now = new Date();
    const diffTime = targetDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { label: 'EXPIRED', color: 'danger' as const, isExpired: true };
    if (diffDays < 30) return { label: `${labelPrefix} in ${diffDays}d`, color: 'warning' as const, isExpired: false };
    return { label: `${labelPrefix}: ${targetDate.toLocaleDateString()}`, color: 'default' as const, isExpired: false };
  };

  // --- ADVANCED FILTERING LOGIC ---
  const filteredInventory = inventory.filter(item => {
     // 1. Text Search (Checks Name, Location, Shelf, Room, Description)
     const query = searchQuery.toLowerCase().trim();
     const matchesSearch = !query || 
        item.name.toLowerCase().includes(query) ||
        item.location.toLowerCase().includes(query) ||
        (item.shelf && item.shelf.toLowerCase().includes(query)) ||
        (item.room && item.room.toLowerCase().includes(query)) ||
        (item.description && item.description.toLowerCase().includes(query));

     // 2. Category Filter
     const matchesCategory = filterCategory === 'all' || item.category === filterCategory;

     // 3. Location Filter
     const matchesLocation = filterLocation === 'all' || item.location === filterLocation;

     return matchesSearch && matchesCategory && matchesLocation;
  });

  const lowStockItems = filteredInventory.filter(i => i.totalStockQuantity <= i.reorderThreshold);

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto">
        
        {/* Header Title */}
        <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Boxes className="text-indigo-600" size={28} />
              Master Inventory
            </h1>
            <p className="text-gray-600 dark:text-gray-400">Manage the supply closet</p>
        </div>

        {/* Search & Actions Bar */}
        <div className="flex flex-col md:flex-row gap-3 mb-4 items-stretch md:items-center">
            <div className="flex-1 relative">
                <Input
                    placeholder="Search by name, location, shelf..."
                    value={searchQuery}
                    onValueChange={setSearchQuery}
                    startContent={<Search size={18} className="text-gray-400" />}
                    endContent={
                        searchQuery && (
                            <button onClick={() => setSearchQuery('')} className="text-gray-400 hover:text-gray-600">
                                <X size={16} />
                            </button>
                        )
                    }
                    classNames={{
                        inputWrapper: "bg-white dark:bg-slate-800 shadow-sm hover:shadow-md transition-shadow h-12"
                    }}
                />
            </div>
            
            <Button 
                isIconOnly={false} 
                variant={showFilters ? "solid" : "bordered"} 
                color={showFilters ? "primary" : "default"}
                onPress={() => setShowFilters(!showFilters)}
                className="h-12 px-4 bg-white dark:bg-slate-800 border-default-200"
                startContent={<Filter size={18} />}
            >
                Filters
            </Button>

            <Button 
                onPress={openAddModal} 
                color="primary" 
                className="h-12 px-6 font-semibold shadow-md bg-indigo-600"
                startContent={<Plus size={20} />}
            >
                Add Item
            </Button>
        </div>

        {/* Expandable Filter Panel */}
        {showFilters && (
            <div className="mb-6 p-4 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700 grid grid-cols-1 md:grid-cols-3 gap-4 animate-appearance-in">
                <Select 
                    label="Category" 
                    size="sm"
                    selectedKeys={[filterCategory]} 
                    onChange={(e) => setFilterCategory(e.target.value)}
                >
                    <SelectItem key="all">All Categories</SelectItem>
                    {CATEGORIES.map(c => <SelectItem key={c}>{c}</SelectItem>)}
                </Select>

                <Select 
                    label="Location" 
                    size="sm"
                    selectedKeys={[filterLocation]} 
                    onChange={(e) => setFilterLocation(e.target.value)}
                >
                    <SelectItem key="all">All Locations</SelectItem>
                    {LOCATIONS.map(l => <SelectItem key={l}>{l}</SelectItem>)}
                </Select>
                
                <div className="flex items-end">
                    <Button size="sm" color="danger" variant="flat" onPress={() => {setFilterCategory('all'); setFilterLocation('all'); setSearchQuery('');}}>
                        Clear All
                    </Button>
                </div>
            </div>
        )}

        {/* Content */}
        <div className="grid grid-cols-1 gap-4">
            {filteredInventory.length === 0 && (
                <div className="text-center py-10 text-gray-500">
                    <p>No items found matching your search.</p>
                </div>
            )}
            
            {filteredInventory.map((item) => {
                const expStatus = getEffectiveExpiration(item);
                const isExpired = expStatus?.isExpired;
                const cardClasses = isExpired 
                    ? "border-red-300 bg-red-50/70 dark:bg-red-900/20"
                    : "bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 hover:shadow-md";

                return (
                    <Card key={item.id} isPressable onPress={() => openEditModal(item)} className={`border rounded-xl transition-all ${cardClasses}`}>
                        <CardBody className="p-4">
                            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                                {/* Left Side: Info */}
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                                        <h3 className="font-bold text-lg text-gray-800 dark:text-white">{item.name}</h3>
                                        <Chip size="sm" color={getCategoryColor(item.category)} variant="flat">{item.category}</Chip>
                                        {expStatus && (
                                            <Chip size="sm" color={expStatus.color} variant="flat" className="font-semibold">{expStatus.label}</Chip>
                                        )}
                                        {item.isOxygen && (
                                            <Chip size="sm" color="primary" variant="dot" startContent={<Wind size={12} />}>Oxygen</Chip>
                                        )}
                                    </div>
                                    <div className="text-xs text-gray-500 mb-1">
                                        {item.location} {item.room ? `/ ${item.room}` : ''} - {item.shelf}
                                    </div>
                                    
                                    {/* Detailed Stock Info for Box Tracking */}
                                    {item.tracksOpenStock && (
                                        <div className="flex items-center gap-2 mt-2 text-sm text-gray-700 dark:text-gray-300">
                                            <PackageOpen size={16} className="text-purple-500" />
                                            <span>
                                                <span className="font-bold">{item.unopenedQuantity}</span> Sealed
                                            </span>
                                            <span className="text-gray-300">|</span>
                                            <span>
                                                <span className="font-bold">{item.openedQuantity}</span> / {item.quantityPerUnit} in Open Box
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* Right Side: Stock & Gauges */}
                                <div className="flex flex-col items-end min-w-[120px]">
                                    {item.isOxygen ? (
                                        <div className="w-32 text-right">
                                            <p className="text-sm font-bold text-blue-600 mb-1">{item.oxygenPsi} PSI</p>
                                            <Progress 
                                                size="sm" 
                                                value={(item.oxygenPsi / item.maxOxygenPsi) * 100} 
                                                color={item.oxygenPsi < 500 ? "danger" : "primary"}
                                                aria-label="Oxygen Level"
                                            />
                                            <p className="text-[10px] text-gray-400 mt-1">Capacity: {item.maxOxygenPsi}</p>
                                        </div>
                                    ) : (
                                        <>
                                            <p className={`text-3xl font-bold ${getStockStatusColor(item.totalStockQuantity, item.reorderThreshold)}`}>
                                                {item.totalStockQuantity}
                                            </p>
                                            <p className="text-xs text-gray-500 uppercase">Total Units</p>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Standard Stock Progress Bar (if not Oxygen) */}
                            {!item.isOxygen && (
                                <div className="mt-3">
                                    <Progress 
                                        size="sm" 
                                        value={item.reorderThreshold > 0 ? (item.totalStockQuantity / (item.reorderThreshold * 2)) * 100 : 100} 
                                        color={item.totalStockQuantity <= item.reorderThreshold ? "warning" : "success"}
                                        aria-label="Stock level"
                                        className="h-1"
                                    />
                                </div>
                            )}
                        </CardBody>
                    </Card>
                );
            })}
        </div>

        <InventoryModal 
            key={`${selectedItem?.id ?? 'new'}-${isOpen ? 'open' : 'closed'}`}
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            onAddItem={handleAddItem}
            onUpdateItem={handleUpdateItem}
            initialData={selectedItem}
            canToggleExpiration={isAdmin}
        />
      </div>
    </div>
  );
}