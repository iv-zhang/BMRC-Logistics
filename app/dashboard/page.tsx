'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, 
  CardBody, 
  CardHeader, 
  Button, 
  Chip,
  Spinner,
  ScrollShadow
} from '@heroui/react';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { auth, db } from '@/firebase';

import type { Statpack, InventoryItem, StatpackLog } from '@/types';

interface ExpiryAlert {
  bagName: string; // Used for Bag Name OR Location String
  itemName: string;
  expiryDate: Date;
  daysRemaining: number;
  source: 'kit' | 'inventory'; // Added to distinguish source if needed for styling
}

export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // --- Domain State ---
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  
  // --- Derived Alert State ---
  const [lowStockItems, setLowStockItems] = useState<InventoryItem[]>([]);
  const [expiryAlerts, setExpiryAlerts] = useState<ExpiryAlert[]>([]);

  // --- Expansion & Logs State ---
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const [packLogs, setPackLogs] = useState<Record<string, StatpackLog[]>>({});
  const [loadingLogs, setLoadingLogs] = useState<Record<string, boolean>>({});

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
      // 1. Fetch Statpacks
      const packsSnapshot = await getDocs(collection(db, 'statpacks'));
      const packsData = packsSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        lastCheckedAt: doc.data().lastCheckedAt?.toDate(),
        contents: doc.data().contents?.map((c: any) => ({
           ...c,
           expirationDate: c.expirationDate?.toDate()
        })) || []
      })) as Statpack[];

      setStatpacks(packsData);

      // 2. Fetch Inventory
      const invSnapshot = await getDocs(collection(db, 'inventory'));
      const invData = invSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate(),
        updatedAt: doc.data().updatedAt?.toDate(),
        // IMPORTANT: Convert Firestore Timestamp to JS Date for expiration
        expirationDate: doc.data().expirationDate?.toDate(), 
      })) as InventoryItem[];

      setInventory(invData);
      setLoading(false);

      // 3. Process Alerts for BOTH
      processAlerts(packsData, invData);

    } catch (error) {
      console.error("Error fetching dashboard data:", error);
      setLoading(false);
    }
  };

  const handleToggleExpand = async (packId: string) => {
    if (expandedPackId === packId) {
      setExpandedPackId(null);
      return;
    }

    setExpandedPackId(packId);

    if (!packLogs[packId]) {
      setLoadingLogs(prev => ({ ...prev, [packId]: true }));
      try {
        const logsQuery = query(
          collection(db, 'statpack_logs'),
          where('statpackId', '==', packId),
          orderBy('timestamp', 'desc'),
          limit(5)
        );
        
        const logsSnapshot = await getDocs(logsQuery);
        const logsData = logsSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          timestamp: doc.data().timestamp?.toDate ? doc.data().timestamp.toDate() : new Date()
        })) as StatpackLog[];

        setPackLogs(prev => ({ ...prev, [packId]: logsData }));
      } catch (err) {
        console.error("Error fetching logs:", err);
      } finally {
        setLoadingLogs(prev => ({ ...prev, [packId]: false }));
      }
    }
  };

  const processAlerts = (packs: Statpack[], inv: InventoryItem[]) => {
    const lowStock = inv.filter(item => item.totalStockQuantity <= item.reorderThreshold);
    setLowStockItems(lowStock);

    const alerts: ExpiryAlert[] = [];
    const today = new Date();

    // A. Check Items Inside Statpacks
    packs.forEach(pack => {
      pack.contents.forEach(item => {
        if (item.expirationDate) {
          const expDate = item.expirationDate;
          const diffTime = expDate.getTime() - today.getTime();
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays <= 30) {
            alerts.push({
              bagName: pack.name,
              itemName: item.itemDetails?.name || 'Unknown Item', 
              expiryDate: expDate,
              daysRemaining: diffDays,
              source: 'kit'
            });
          }
        }
      });
    });

    // B. Check Master Inventory Items (Shelves)
    inv.forEach(item => {
      if (item.expirationDate) {
        const expDate = item.expirationDate;
        const diffTime = expDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays <= 30) {
          // Construct a location string to display in place of "Bag Name"
          let locationStr = item.location;
          if (item.room) locationStr += ` (${item.room})`;
          if (item.shelf) locationStr += ` - ${item.shelf}`;

          alerts.push({
            bagName: locationStr, 
            itemName: item.name,
            expiryDate: expDate,
            daysRemaining: diffDays,
            source: 'inventory'
          });
        }
      }
    });

    // Sort by most urgent
    alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
    setExpiryAlerts(alerts);
  };

  const getStatusColor = (status: Statpack['status']) => {
    switch (status) {
      case 'Ready': return 'success';
      case 'Restock Needed': return 'warning'; 
      case 'Expired Items': return 'danger';
      case 'In Use': return 'warning';         
      default: return 'default';
    }
  };

  const getStatusBorderClass = (status: Statpack['status']) => {
    switch (status) {
      case 'Ready': return 'border-2 border-green-500';
      case 'Restock Needed': return 'border-2 border-orange-500';
      case 'Expired Items': return 'border-2 border-red-500';
      case 'In Use': return 'border-2 border-yellow-400';
      default: return 'border-2 border-gray-200';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="animate-pulse text-indigo-600 font-semibold">Loading Dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* --- Header --- */}
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">BMRC Dashboard</h1>
            <p className="text-gray-500 dark:text-gray-400">
              Overview of Fleet Readiness & Supply Levels
            </p>
          </div>
        </div>

        {/* --- Statpack Grid --- */}
        <section>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">
              Active Statpacks
            </h2>
            <Chip variant="flat" size="sm">
              Total: {statpacks.length}
            </Chip>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
            {statpacks.map((pack) => {
              const isExpanded = expandedPackId === pack.id;
              const logs = packLogs[pack.id] || [];
              const isLoadingLogs = loadingLogs[pack.id];

              return (
                // WRAPPER DIV: Handles the Click and Grid Layout
                <div 
                  key={pack.id}
                  onClick={() => handleToggleExpand(pack.id)}
                  className={`
                    cursor-pointer relative group
                    transition-all duration-300
                    ${isExpanded ? 'row-span-2' : ''}
                  `}
                >
                  {/* CARD: Handles only the Visuals (Borders, Background, Shadow) */}
                  <Card 
                    className={`
                      h-full hover:shadow-lg transition-shadow
                      ${getStatusBorderClass(pack.status)}
                    `}
                  >
                    <CardHeader className="flex justify-between pb-0">
                      <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                        {pack.type}
                      </span>
                      <Chip 
                        color={getStatusColor(pack.status)} 
                        variant="flat" 
                        size="sm"
                        className="font-medium"
                      >
                        {pack.status}
                      </Chip>
                    </CardHeader>
                    
                    <CardBody className="pt-2">
                      <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
                        {pack.name}
                      </h3>
                      <div className="text-sm text-gray-500 mb-2">
                        {pack.lastCheckedAt 
                          ? `Last Check: ${pack.lastCheckedAt.toLocaleDateString()}` 
                          : 'Status: Pending Initial Check'}
                      </div>

                      {/* EXPANDED CONTENT */}
                      {isExpanded && (
                        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 animate-appearance-in">
                          <div className="flex justify-between items-end mb-2">
                            <h4 className="text-xs font-semibold text-gray-400 uppercase">Recent Activity</h4>
                            <Button 
                              size="sm" 
                              variant="light" 
                              color="primary"
                              className="h-6 text-xs"
                              onPress={() => router.push(`/statpacks?id=${pack.id}`)}
                              onClick={(e) => e.stopPropagation()} 
                            >
                              Manage Full Details →
                            </Button>
                          </div>
                          
                          {/* Logs Section */}
                          <div className="bg-gray-50 dark:bg-slate-800 rounded-lg p-2 min-h-[100px]">
                            {isLoadingLogs ? (
                              <div className="flex justify-center py-4">
                                <Spinner size="sm" />
                              </div>
                            ) : logs.length > 0 ? (
                              <ScrollShadow className="max-h-[150px]">
                                <ul className="space-y-3">
                                  {logs.map((log) => (
                                    <li key={log.id} className="border-b border-gray-200 dark:border-gray-700 pb-2 last:border-0">
                                      <div className="flex justify-between items-start">
                                        <span className="font-bold capitalize text-xs text-gray-700 dark:text-gray-200">
                                          {log.action}
                                        </span>
                                        <span className="text-[10px] text-gray-400 whitespace-nowrap ml-2">
                                            {log.timestamp?.toLocaleString() || 'Just now'}
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 break-words">
                                        {log.notes}
                                      </p>
                                      <p className="text-[10px] text-gray-400 mt-1">
                                        by {log.userName}
                                      </p>
                                    </li>
                                  ))}
                                </ul>
                              </ScrollShadow>
                            ) : (
                              <p className="text-xs text-center text-gray-400 py-4">
                                No recent logs found.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {/* TOGGLE ARROW (Always visible, changes direction) */}
                      <div className="mt-2 flex justify-center">
                          <span className="text-gray-300 text-xs group-hover:text-gray-500 transition-colors">
                            {isExpanded ? '▲' : '▼'}
                          </span>
                      </div>
                    </CardBody>
                  </Card>
                </div>
              );
            })}
          </div>
        </section>

        {/* --- Alert Sections --- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="h-full shadow-md dark:bg-slate-800">
            <CardHeader className="flex gap-3 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/30 px-6 py-4">
              <div className="p-2 bg-red-100 dark:bg-red-800 rounded-lg text-red-600 dark:text-red-100">
                ⚠️
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Supply Closet Low</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Master inventory items below reorder threshold
                </p>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {lowStockItems.length > 0 ? (
                <div className="divide-y divide-gray-100 dark:divide-slate-700">
                  {lowStockItems.map((item) => (
                    <div key={item.id} className="flex justify-between items-center p-4 hover:bg-gray-50">
                      <div>
                        <p className="font-semibold text-gray-800 dark:text-gray-200">{item.name}</p>
                        <p className="text-xs text-gray-500">Category: {item.category}</p>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-2 justify-end">
                           <span className="text-red-600 font-bold">{item.totalStockQuantity}</span>
                           <span className="text-gray-400 text-sm">/ {item.reorderThreshold}</span>
                        </div>
                        <p className="text-xs text-red-500 font-medium">Reorder Needed</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500">
                  <p>All stock levels are healthy. ✅</p>
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="h-full shadow-md dark:bg-slate-800">
             <CardHeader className="flex gap-3 bg-orange-50 dark:bg-orange-900/20 border-b border-orange-100 dark:border-orange-900/30 px-6 py-4">
              <div className="p-2 bg-orange-100 dark:bg-orange-800 rounded-lg text-orange-600 dark:text-orange-100">
                🕒
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Expiring Items</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Items inside kits and closet expiring soon
                </p>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {expiryAlerts.length > 0 ? (
                <div className="divide-y divide-gray-100 dark:divide-slate-700">
                  {expiryAlerts.map((alert, idx) => (
                    <div key={idx} className="flex justify-between items-center p-4 hover:bg-gray-50">
                      <div>
                        <div className="flex items-center gap-2">
                           <p className="font-semibold text-gray-800 dark:text-gray-200">{alert.itemName}</p>
                           {/* Badge for Source: Kit or Closet */}
                           <span className={`text-[10px] px-1.5 py-0.5 rounded ${alert.source === 'kit' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {alert.source === 'kit' ? 'Bag' : 'Shelf'}
                           </span>
                        </div>
                        <p className="text-xs text-gray-500">
                           Location: <b>{alert.bagName}</b>
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${alert.daysRemaining < 0 ? 'text-red-600' : 'text-orange-600'}`}>
                          {alert.daysRemaining < 0 
                            ? `Expired ${Math.abs(alert.daysRemaining)} days ago` 
                            : `Expires in ${alert.daysRemaining} days`}
                        </p>
                        <p className="text-xs text-gray-400">
                          {alert.expiryDate.toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500">
                  <p>No immediate expirations found. ✅</p>
                </div>
              )}
            </CardBody>
          </Card>

        </div>
      </div>
    </div>
  );
}