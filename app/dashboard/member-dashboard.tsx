'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Divider,
} from '@heroui/react';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Timestamp,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import type { Statpack, StatpackLog, User } from '@/app/types';
import {
  LogIn,
  LogOut,
  Smartphone,
  ScanLine,
  PackageCheck,
  Clock,
  AlertTriangle,
  ClipboardCheck,
} from 'lucide-react';

interface InventorySnapshot {
  id: string;
  name: string;
  totalStockQuantity: number;
  unopenedBoxes?: number;
  itemsPerBox?: number;
  reorderThreshold?: number;
  location: string;
  room?: string;
  tracksExpiration?: boolean;
  expirationDate?: Date;
  batches?: Array<{ expirationDate?: Date }>;
}

interface MemberDashboardProps {
  userData: User;
}

export default function MemberDashboard({ userData }: MemberDashboardProps) {
  const router = useRouter();
  const { role } = useUserRole();
  const [assignedPacks, setAssignedPacks] = useState<Statpack[]>([]);
  const [recentActivity, setRecentActivity] = useState<StatpackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [lowStockItems, setLowStockItems] = useState<any[]>([]);
  const [expiringItems, setExpiringItems] = useState<any[]>([]);
  const [purchaseHistoryMap, setPurchaseHistoryMap] = useState<Record<string, any[]>>({});
  const [creatingRequest, setCreatingRequest] = useState<string | null>(null);
  const lowStockCount = lowStockItems.length;
  const expiringCount = expiringItems.length;
  const attentionList = useMemo(() => {
    const combined = [...lowStockItems, ...expiringItems];
    return combined.slice(0, 5);
  }, [lowStockItems, expiringItems]);

  const toDateSafe = (val: any): Date | undefined => {
    if (!val) return undefined;
    if (val instanceof Date) return val;
    if (val instanceof Timestamp) return val.toDate();
    if (typeof val === 'object' && typeof val.toDate === 'function') return val.toDate();
    return undefined;
  };

  const getEarliestExpiration = (item: any): Date | undefined => {
    const dates: Date[] = [];
    if (item.expirationDate) dates.push(item.expirationDate);
    if (Array.isArray(item.batches)) {
      item.batches.forEach((b: any) => {
        const bd = toDateSafe(b.expirationDate);
        if (bd) dates.push(bd);
      });
    }
    if (dates.length === 0) return undefined;
    return dates.reduce((earliest, current) => current < earliest ? current : earliest, dates[0]);
  };

  useEffect(() => {
    const invRef = collection(db, 'inventory');
    const unsubscribe = onSnapshot(invRef, (snapshot) => {
      const parsed: InventorySnapshot[] = snapshot.docs
        .filter((docSnap) => {
          const data = docSnap.data() as any;
          // CRITICAL: Exclude assets from member dashboard — only show disposables
          // Assets (isAsset=true) are managed via the /assets page and shouldn't appear in member restocking UI
          return !data.isAsset;
        })
        .map((docSnap) => {
        const data = docSnap.data() as any;
        // Calculate sealed inventory from unopened boxes in back room
        const sealedBoxCount = Number(data.unopenedBoxes ?? 0);
        const itemsPerBox = Number(data.itemsPerBox ?? 1);
        const sealedInventory = sealedBoxCount * itemsPerBox;
        
        return {
          id: docSnap.id,
          name: data.name || 'Unknown Item',
          totalStockQuantity: sealedInventory, // Calculate from sealed boxes
          unopenedBoxes: sealedBoxCount,
          itemsPerBox: itemsPerBox,
          reorderThreshold: typeof data.reorderThreshold === 'number' ? data.reorderThreshold : undefined,
          location: data.location,
          room: data.room,
          tracksExpiration: data.tracksExpiration,
          expirationDate: toDateSafe(data.expirationDate),
          batches: Array.isArray(data.batches)
            ? data.batches.map((b: any) => ({ ...b, expirationDate: toDateSafe(b.expirationDate) }))
            : undefined,
        } as InventorySnapshot;
      });

      // Low stock = sealed boxes in back room inventory running low
      const low = parsed.filter((item) =>
        typeof item.reorderThreshold === 'number' && item.totalStockQuantity <= (item.reorderThreshold ?? 0)
      );

      const soonCutoff = new Date();
      soonCutoff.setDate(soonCutoff.getDate() + 45);
      const expiring = parsed
        .map((item) => ({ ...item, expirationDate: getEarliestExpiration(item) }))
        .filter((item) => item.tracksExpiration && item.expirationDate && item.expirationDate <= soonCutoff);

      setLowStockItems(low);
      setExpiringItems(expiring);
    });

    return () => unsubscribe();
  }, []);

  // Fetch recent purchase history for low-stock items (up to 10 ids per request)
  useEffect(() => {
    const fetchPurchaseHistory = async () => {
      try {
        const ids = lowStockItems.slice(0, 10).map(i => i.id);
        if (ids.length === 0) {
          setPurchaseHistoryMap({});
          return;
        }
        // Firestore 'in' supports up to 10 values
        const { query: qf, where: wf, orderBy: ob, getDocs } = await import('firebase/firestore');
        const qRef = qf(collection(db, 'purchase_history'), wf('itemId', 'in', ids), ob('orderedAt', 'desc'));
        const snaps = await getDocs(qRef);
        const map: Record<string, any[]> = {};
        snaps.forEach(s => {
          const d = s.data();
          const itemId = d.itemId;
          if (!map[itemId]) map[itemId] = [];
          map[itemId].push({ id: s.id, ...d });
        });
        setPurchaseHistoryMap(map);
      } catch (e) {
        setPurchaseHistoryMap({});
      }
    };
    fetchPurchaseHistory();
  }, [lowStockItems]);

  useEffect(() => {
    // Listen for statpacks assigned to this user
    const packsQuery = query(
      collection(db, 'statpacks'),
      where('assignedTo', '==', userData.id)
    );

    const unsubPacks = onSnapshot(packsQuery, (snapshot) => {
      const packs = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          lastCheckedAt: data.lastCheckedAt instanceof Timestamp 
            ? data.lastCheckedAt.toDate() 
            : undefined,
          contents: Array.isArray(data.contents)
            ? data.contents.map((item: { expirationDate?: Timestamp | Date; [key: string]: unknown }) => ({
                ...item,
                expirationDate: item.expirationDate instanceof Timestamp
                  ? item.expirationDate.toDate()
                  : undefined,
              }))
            : [],
        } as Statpack;
      });
      setAssignedPacks(packs);
    });

    // Listen for recent activity logs by this user
    const logsQuery = query(
      collection(db, 'statpack_logs'),
      where('userId', '==', userData.id),
      orderBy('timestamp', 'desc'),
      limit(5)
    );

    const unsubLogs = onSnapshot(logsQuery, (snapshot) => {
      const logs = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp
            ? data.timestamp.toDate()
            : new Date(),
        } as StatpackLog;
      });
      setRecentActivity(logs);
      setLoading(false);
    });

    return () => {
      unsubPacks();
      unsubLogs();
    };
  }, [userData.id]);

  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const getCheapestOption = (itemId: string) => {
    const list = purchaseHistoryMap[itemId] || [];
    if (!list || list.length === 0) return null;
    // choose by pricePerUnit if available
    return list.reduce((best: any, cur: any) => {
      if (!best) return cur;
      const bp = typeof best.pricePerUnit === 'number' ? best.pricePerUnit : Infinity;
      const cp = typeof cur.pricePerUnit === 'number' ? cur.pricePerUnit : Infinity;
      return cp < bp ? cur : best;
    }, null);
  };

  const createPurchaseRequest = async (item: InventorySnapshot, qty: number, supplier?: any) => {
    if (!item || qty <= 0) return;
    setCreatingRequest(item.id);
    try {
      await addDoc(collection(db, 'purchase_requests'), {
        itemId: item.id,
        itemName: item.name,
        quantity: qty,
        supplierName: supplier?.supplierName || supplier?.name || null,
        suggestedPrice: supplier?.pricePerUnit ?? null,
        status: 'requested',
        requestedBy: userData.id,
        requestedAt: serverTimestamp(),
      });
      alert('Purchase request created');
    } catch (e) {
      console.error('createPurchaseRequest failed', e);
      alert('Failed to create purchase request');
    } finally {
      setCreatingRequest(null);
    }
  };

  return (
    <>
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-3 md:p-6">
      <div className="max-w-4xl mx-auto space-y-4 md:space-y-8">
        {/* Header - Mobile Optimized */}
        <div className="mb-4 md:mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Image
              src="/images/NewLogoWhiteLong_NoHeartbeat.PNG"
              alt="BMRC Logo"
              width={120}
              height={30}
              className="h-8 md:h-12 w-auto"
            />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white">
            Dashboard
          </h1>
          <p className="text-sm md:text-base text-gray-600 dark:text-gray-400 mt-1">
            Welcome, {userData.fullName}! Your inventory & packs at a glance.
          </p>
        </div>
        <Divider />

        {/* Alert CTA - Compact Mobile View */}
        <Card className="bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 text-white shadow-lg">
          <CardBody className="flex flex-col gap-4 py-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold mb-2">Keep Us Safe</h2>
              <p className="text-sm md:text-base opacity-90">Found expired items or untracked boxes? Report them now.</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {lowStockCount > 0 && (
                  <Chip size="sm" color="warning" variant="flat" className="text-white border border-white/30 bg-white/20">
                    Stock alerts
                  </Chip>
                )}
                {expiringCount > 0 && (
                  <Chip size="sm" color="danger" variant="flat" className="text-white border border-white/30 bg-white/20">
                    {expiringCount} expiring
                  </Chip>
                )}
                {lowStockCount === 0 && expiringCount === 0 && (
                  <Chip size="sm" color="success" variant="flat" className="text-white border border-white/30 bg-white/20">
                    All clear
                  </Chip>
                )}
              </div>
            </div>
            <Button
              size="lg"
              className="bg-white text-orange-600 font-bold w-full"
              onPress={() => router.push('/member/report')}
            >
              Report an Issue
            </Button>
          </CardBody>
        </Card>

        {/* Quick Actions - Mobile Optimized */}
        <section>
          <h2 className="text-lg md:text-xl font-semibold text-gray-800 dark:text-gray-200 mb-3 md:mb-4">
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-2 gap-2 md:gap-4">
            <Card
              isPressable
              onPress={() => router.push('/statpacks/checkout')}
              className="bg-gradient-to-br from-blue-500 to-blue-600 text-white hover:scale-105 transition-transform"
            >
              <CardBody className="flex flex-col items-center justify-center py-4 md:py-8 gap-2 md:gap-3">
                <LogOut size={36} className="md:w-12 md:h-12" />
                <h3 className="text-sm md:text-xl font-bold">Check Out</h3>
                <p className="text-xs md:text-sm text-center opacity-90 hidden md:block">
                  Take supplies
                </p>
              </CardBody>
            </Card>

            <Card
              isPressable
              onPress={() => router.push('/statpacks/checkin')}
              className="bg-gradient-to-br from-green-500 to-green-600 text-white hover:scale-105 transition-transform"
            >
              <CardBody className="flex flex-col items-center justify-center py-4 md:py-8 gap-2 md:gap-3">
                <LogIn size={36} className="md:w-12 md:h-12" />
                <h3 className="text-sm md:text-xl font-bold">Check In</h3>
                <p className="text-xs md:text-sm text-center opacity-90 hidden md:block">
                  Return supplies
                </p>
              </CardBody>
            </Card>

            {role === 'admin' || role === 'quartermaster' || role === 'inventory_helper' ? (
              <>
                <Card
                  isPressable
                  onPress={() => router.push('/inventory')}
                  className="bg-gradient-to-br from-purple-500 to-purple-600 text-white hover:scale-105 transition-transform"
                >
                  <CardBody className="flex flex-col items-center justify-center py-4 md:py-8 gap-2 md:gap-3">
                    <PackageCheck size={36} className="md:w-12 md:h-12" />
                    <h3 className="text-sm md:text-xl font-bold">Quick Count</h3>
                    <p className="text-xs md:text-sm text-center opacity-90 hidden md:block">
                      Count inventory
                    </p>
                  </CardBody>
                </Card>

                <Card
                  isPressable
                  onPress={() => router.push('/reports')}
                  className="bg-gradient-to-br from-orange-500 to-orange-600 text-white hover:scale-105 transition-transform"
                >
                  <CardBody className="flex flex-col items-center justify-center py-4 md:py-8 gap-2 md:gap-3">
                    <ScanLine size={36} className="md:w-12 md:h-12" />
                    <h3 className="text-sm md:text-xl font-bold">Scan Report</h3>
                    <p className="text-xs md:text-sm text-center opacity-90 hidden md:block">
                      Report items
                    </p>
                  </CardBody>
                </Card>
              </>
            ) : null}

            {/* Audit button — visible to anyone with audit permission */}
            {(userData.canAudit || role === 'admin' || role === 'quartermaster' || role === 'inventory_helper') && (
              <Card
                isPressable
                onPress={() => router.push('/audit')}
                className="bg-gradient-to-br from-teal-500 to-cyan-600 text-white hover:scale-105 transition-transform"
              >
                <CardBody className="flex flex-col items-center justify-center py-4 md:py-8 gap-2 md:gap-3">
                  <ClipboardCheck size={36} className="md:w-12 md:h-12" />
                  <h3 className="text-sm md:text-xl font-bold">Audit</h3>
                  <p className="text-xs md:text-sm text-center opacity-90 hidden md:block">
                    Count boxes & verify
                  </p>
                </CardBody>
              </Card>
            )}
          </div>
        </section>

        {/* Smart Ordering - Admin Only */}
        {(role === 'admin' || role === 'quartermaster') && (
          <section>
            <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200 mb-4">Smart Ordering</h2>
            <Card>
              <CardBody className="space-y-3">
                <p className="text-sm text-gray-600">Suggested orders to meet par levels. Shows recent suppliers and the cheapest recent option.</p>
                {(lowStockItems || []).slice(0, 8).map(item => {
                  const par = typeof item.reorderThreshold === 'number' ? item.reorderThreshold : 0;
                  const current = Number(item.totalStockQuantity ?? 0);
                  const suggested = Math.max(par - current, 0);
                  const cheapest = getCheapestOption(item.id);
                  return (
                    <div key={item.id} className="flex items-center justify-between p-3 border rounded-md">
                      <div>
                        <div className="font-medium">{item.name}</div>
                        <div className="text-xs text-gray-500">Current: {current} • Par: {par} • Suggested: {suggested}</div>
                        {cheapest ? (
                          <div className="text-xs text-gray-600">Cheapest: {cheapest.supplierName || cheapest.name} @ {typeof cheapest.pricePerUnit === 'number' ? `$${cheapest.pricePerUnit.toFixed(2)}` : '—'}</div>
                        ) : (
                          <div className="text-xs text-gray-400">No recent purchase history</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="flat" onPress={() => createPurchaseRequest(item, suggested, cheapest)} isDisabled={suggested <= 0 || creatingRequest !== null}>
                          {creatingRequest === item.id ? 'Creating...' : `Request ${suggested}`}
                        </Button>
                        <Button size="sm" variant="light" onPress={() => {
                          console.log('Purchase history for', item.id, purchaseHistoryMap[item.id] || []);
                          alert('Opening purchase history in console (developer)');
                        }}>
                          Options
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {lowStockItems.length === 0 && (
                  <div className="text-sm text-gray-500">No items currently below par.</div>
                )}
              </CardBody>
            </Card>
          </section>
        )}

        {/* Two Column Layout - Mobile Responsive */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
          {/* Assigned Statpacks */}
          <Card>
            <CardHeader className="flex flex-col items-start gap-2 pb-3 md:pb-4">
              <h3 className="text-base md:text-lg font-semibold text-gray-800 dark:text-gray-200">
                My Assigned Packs
              </h3>
              <Chip size="sm" variant="flat">
                {assignedPacks.length} pack{assignedPacks.length !== 1 ? 's' : ''}
              </Chip>
            </CardHeader>
            <Divider />
            <CardBody className="gap-2 md:gap-3">
              {loading ? (
                <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm">
                  Loading...
                </p>
              ) : assignedPacks.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm">
                  No packs currently assigned. Packs appear here once you check them out.
                </p>
              ) : (
                assignedPacks.map((pack) => (
                  <Card
                    key={pack.id}
                    className="bg-gray-50 dark:bg-slate-800 cursor-pointer hover:shadow-md transition-shadow"
                    isPressable
                    onPress={() => router.push(`/statpacks/?id=${pack.id}`)}
                  >
                    <CardBody className="py-2 md:py-3 px-3 md:px-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-sm md:text-base text-gray-900 dark:text-white truncate">
                            {pack.name}
                          </h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {pack.type}
                          </p>
                        </div>
                        <Chip
                          color={
                            pack.status === 'Ready'
                              ? 'success'
                              : pack.status === 'In Use'
                              ? 'warning'
                              : 'danger'
                          }
                          size="sm"
                          variant="flat"
                        >
                          {pack.status}
                        </Chip>
                      </div>
                    </CardBody>
                  </Card>
                ))
              )}
            </CardBody>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader className="flex flex-col items-start gap-2 pb-3 md:pb-4">
              <h3 className="text-base md:text-lg font-semibold text-gray-800 dark:text-gray-200">
                Your Activity
              </h3>
              <Chip size="sm" variant="flat">
                Last 5
              </Chip>
            </CardHeader>
            <Divider />
            <CardBody className="gap-2 md:gap-3">
              {loading ? (
                <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm">
                  Loading...
                </p>
              ) : recentActivity.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm">
                  No activity yet. Start by checking out a pack!
                </p>
              ) : (
                recentActivity.map((log) => (
                  <Card
                    key={log.id}
                    className="bg-gray-50 dark:bg-slate-800"
                    shadow="sm"
                  >
                    <CardBody className="py-2 md:py-3 px-3 md:px-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Chip
                              size="sm"
                              color={
                                log.action === 'checkout'
                                  ? 'primary'
                                  : log.action === 'checkin'
                                  ? 'success'
                                  : 'default'
                              }
                              variant="flat"
                            >
                              {log.action === 'checkout' ? 'Checked Out' : log.action === 'checkin' ? 'Checked In' : log.action}
                            </Chip>
                          </div>
                          <p className="text-xs md:text-sm font-medium text-gray-900 dark:text-white truncate">
                            {log.statpackName || 'Unknown Pack'}
                          </p>
                          {log.notes && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                              {log.notes}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
                          <Clock size={12} />
                          {log.timestamp instanceof Date ? formatTimestamp(log.timestamp) : 'Just now'}
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                ))
              )}
            </CardBody>
          </Card>
        </div>

        {/* Mobile Dashboard Link */}
        <Card className="bg-gradient-to-r from-indigo-500 to-blue-500 text-white">
          <CardBody className="py-4 md:py-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 md:gap-4">
              <div className="flex items-center gap-3">
                <Smartphone size={32} className="hidden md:block" />
                <div>
                  <h3 className="text-lg md:text-xl font-bold mb-1">Manage Your Packs</h3>
                  <p className="text-xs md:text-sm opacity-90">
                    Check items in and out from your mobile device
                  </p>
                </div>
              </div>
              <Button
                color="default"
                variant="solid"
                size="sm"
                onPress={() => router.push('/statpacks')}
                className="w-full md:w-auto"
              >
                Open Statpacks
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
    </>
  );
}
