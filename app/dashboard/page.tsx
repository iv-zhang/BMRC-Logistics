'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, 
  CardBody, 
  CardHeader, 
  Button, 
  Chip,
  Divider,
  Spinner,
  ScrollShadow,
  Textarea
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, limit, getDocs, Timestamp, addDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { 
  AlertTriangle, 
  ArrowUpRight, 
  ChevronDown, 
  ChevronUp, 
  Clock, 
  LayoutDashboard 
} from 'lucide-react';

import type { Statpack, InventoryItem, StatpackLog, StatpackItem } from '@/app/types';

interface ExpiryAlert {
  bagName: string; // Used for Bag Name OR Location String
  itemName: string;
  expiryDate?: Date;
  daysRemaining: number;
  source: 'kit' | 'inventory'; // Added to distinguish source if needed for styling
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
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
    setLoading(true);
    let packsReady = false;
    let inventoryReady = false;

    const finishLoadingIfReady = () => {
      if (packsReady && inventoryReady) {
        setLoading(false);
      }
    };

    // Helper to safely convert Timestamps or return Dates/undefined
    const toDateIfTimestamp = (value: unknown) => {
      if (value instanceof Timestamp) {
        return value.toDate();
      }
      if (value instanceof Date) {
        return value;
      }
      return undefined;
    };

    const unsubscribePacks = onSnapshot(
      collection(db, 'statpacks'),
      (snapshot) => {
        const packsData = snapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            lastCheckedAt: toDateIfTimestamp(data.lastCheckedAt),
            contents: Array.isArray(data.contents)
              ? data.contents.map((item: StatpackItem) => ({
                  ...item,
                  expirationDate: toDateIfTimestamp(item.expirationDate)
                }))
              : []
          };
        }) as Statpack[];

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
        const invData = snapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            // UPDATED: Use the helper function instead of calling .toDate() directly
            createdAt: toDateIfTimestamp(data.createdAt),
            updatedAt: toDateIfTimestamp(data.updatedAt),
            expirationDate: toDateIfTimestamp(data.expirationDate), 
          };
        }) as InventoryItem[];

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
          timestamp: doc.data().timestamp instanceof Timestamp 
            ? doc.data().timestamp.toDate() 
            : new Date() // Fallback if timestamp is missing/invalid
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

    // B. Check Master Inventory Items (Shelves) using batch expirations
    inv.forEach(item => {
      if (!item.batches || item.batches.length === 0) return;
      const dates = (item.batches || []).map((b: any) => b.expirationDate ? new Date(b.expirationDate) : null).filter(Boolean) as Date[];
      if (dates.length === 0) return;
      // pick the nearest expiration
      const expDate = dates.reduce((a, b) => a < b ? a : b);
      const diffTime = expDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays <= 30) {
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
    });

    // Sort by most urgent
    alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
    setExpiryAlerts(alerts);
  };

  useEffect(() => {
    processAlerts(statpacks, inventory);
  }, [statpacks, inventory]);

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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <div className="animate-pulse text-indigo-600 font-semibold">Loading Dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* --- Header --- */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <LayoutDashboard className="text-indigo-600" size={28} />
              BMRC Dashboard
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              Overview of fleet readiness and supply levels
            </p>
          </div>
        </div>
        <Divider />

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
                      h-full bg-white/80 dark:bg-slate-800/80 hover:shadow-lg transition-shadow
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
                              endContent={<ArrowUpRight size={14} />}
                            >
                              Manage Details
                            </Button>
                          </div>
                          
                          {/* Logs Section */}
                          <div className="bg-white/80 dark:bg-slate-800/80 rounded-lg p-2 min-h-[100px]">
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
                        {isExpanded ? (
                          <ChevronUp className="text-gray-400 group-hover:text-gray-600 transition-colors" size={16} />
                        ) : (
                          <ChevronDown className="text-gray-400 group-hover:text-gray-600 transition-colors" size={16} />
                        )}
                      </div>
                    </CardBody>
                  </Card>
                </div>
              );
            })}

            {/* Reports widget card: shows recent unresolved reports and a simulation form */}
            <div className="col-span-1 md:col-span-2 lg:col-span-1">
              <Card className="h-full bg-white/80 dark:bg-slate-800/80">
                <CardHeader className="flex justify-between items-center">
                  <span className="font-semibold">Reports & Alerts</span>
                  <Button size="sm" variant="light" onPress={() => router.push('/reports')}>Open</Button>
                </CardHeader>
                <CardBody>
                  <div id="reports-widget" className="space-y-3">
                    <div className="text-sm text-gray-600">Recent unresolved restock reports</div>
                    <div id="reports-list" className="space-y-2">
                      {/* Lightweight client-only fetch of a few reports */}
                      <ReportsWidgetPreview />
                    </div>

                    <div className="mt-3 border-t pt-3">
                      <div className="text-sm font-medium mb-2">Simulate Report</div>
                      <div className="flex items-center">
                        <Button
                          color="primary"
                          onPress={() => window.open('/mobile/scan-report', '_blank')}
                          startContent={<AlertTriangle />}
                        >
                          Report Low Stock (Mobile)
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardBody>
              </Card>
            </div>

          </div>
        </section>

        {/* --- Alert Sections --- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="h-full shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700">
            <CardHeader className="flex gap-3 bg-red-50/70 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/30 px-6 py-4">
              <div className="p-2 bg-red-100 dark:bg-red-800 rounded-lg text-red-600 dark:text-red-100">
                <AlertTriangle size={18} />
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
                    <div key={item.id} className="flex justify-between items-center p-4 hover:bg-indigo-50/70 dark:hover:bg-slate-700/60">
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
                  <p>All stock levels are healthy.</p>
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="h-full shadow-md bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700">
             <CardHeader className="flex gap-3 bg-orange-50/70 dark:bg-orange-900/20 border-b border-orange-100 dark:border-orange-900/30 px-6 py-4">
              <div className="p-2 bg-orange-100 dark:bg-orange-800 rounded-lg text-orange-600 dark:text-orange-100">
                <Clock size={18} />
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
                    <div key={idx} className="flex justify-between items-center p-4 hover:bg-indigo-50/70 dark:hover:bg-slate-700/60">
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
                  <p>No immediate expirations found.</p>
                </div>
              )}
            </CardBody>
          </Card>

        </div>
      </div>
    </div>
  );
}

// --- Reports widget preview (client-only) ---
function ReportsWidgetPreview() {
  const [reports, setReports] = React.useState<any[]>([]);

  React.useEffect(() => {
    const q = query(collection(db, 'restock_reports'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, snap => {
      const out: any[] = [];
      let count = 0;
      snap.forEach(s => {
        const d = { id: s.id, ...(s.data() as any) };
        if (!d.resolved && count < 5) { out.push(d); count++; }
      });
      setReports(out);
    }, err => {
      console.error('reports preview error', err);
    });
    return () => unsub();
  }, []);

  if (reports.length === 0) return <div className="text-xs text-gray-500">No recent unresolved reports.</div>;

  return (
    <div className="space-y-2">
      {reports.map(r => (
        <div key={r.id} className="p-2 bg-gray-50 rounded border">
          <div className="text-sm font-medium">{r.statpackName || r.statpackId}</div>
          <div className="text-xs text-gray-500">{r.reporter || r.reporterId} • {(() => { try { const d = r.createdAt?.toDate ? r.createdAt.toDate() : new Date(r.createdAt); return d.toLocaleString(); } catch(e) { return String(r.createdAt); } })()}</div>
          <div className="text-xs text-gray-700 mt-1">{(r.items || []).slice(0,2).map((it:any)=>it.name).join(', ')}</div>
        </div>
      ))}
    </div>
  );
}

// SimulateReportForm removed — replaced by a mobile report button above.