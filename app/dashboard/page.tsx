'use client';
import React, { useEffect, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Spinner } from '@heroui/react';
import {
  collection, onSnapshot, query, where, orderBy, limit,
  getDocs, Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import type { Statpack, InventoryItem, StatpackLog, StatpackItem } from '@/app/types';
import MemberDashboard from './member-dashboard';
import {
  AlertTriangle, ChevronDown, Search, X, ArrowUpRight, Clock, AlertCircle,
  Bell, ArrowRightLeft, Plus, ScanLine, FileText, ChevronRight,
} from 'lucide-react';

// ─── helpers ──────────────────────────────────────────────────────────────────

function daysUntil(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ─── pack status ──────────────────────────────────────────────────────────────

type PackTier = 'ready' | 'inuse' | 'attention';

function getPackTier(pack: Statpack): PackTier {
  if (pack.status === 'In Use') return 'inuse';
  const today = new Date();
  const hasExpired = pack.contents?.some(
    c => c.expirationDate && new Date(c.expirationDate as Date) < today,
  );
  if (!hasExpired && pack.status === 'Ready') return 'ready';
  return 'attention';
}

interface PackChip { label: string; color: 'success' | 'danger' | 'warning' | 'primary' }

function getPackChips(pack: Statpack): PackChip[] {
  const today = new Date();
  const expiredContents = pack.contents?.filter(
    c => c.expirationDate && new Date(c.expirationDate as Date) < today,
  ) ?? [];
  const chips: PackChip[] = [];
  if (pack.status === 'In Use') chips.push({ label: 'In Use', color: 'primary' });
  else if (pack.status === 'Ready' && expiredContents.length === 0) chips.push({ label: 'Ready', color: 'success' });
  if (expiredContents.length > 0) chips.push({ label: 'Expired items', color: 'danger' });
  if (pack.status === 'Restock Needed') chips.push({ label: 'Restock needed', color: 'danger' });
  if (pack.status === 'CRITICAL - EXPIRED ITEMS') chips.push({ label: 'Critical', color: 'danger' });
  return chips;
}

const CHIP_CLS: Record<PackChip['color'], string> = {
  success: 'bg-success-50 dark:bg-success-900/20 text-success',
  danger:  'bg-danger-50 dark:bg-danger-900/20 text-danger',
  warning: 'bg-warning-50 dark:bg-warning-900/20 text-warning',
  primary: 'bg-primary-50 dark:bg-primary-900/20 text-primary',
};

const TIER_DOT: Record<PackTier, string> = {
  ready:     'bg-success',
  inuse:     'bg-primary',
  attention: 'bg-danger',
};

const TIER_BORDER: Record<PackTier, string> = {
  ready:     'border-success',
  inuse:     'border-primary',
  attention: 'border-danger',
};

const TIER_SOFT_BG: Record<PackTier, string> = {
  ready:     'bg-success-50/50 dark:bg-success-900/10',
  inuse:     'bg-primary-50/50 dark:bg-primary-900/10',
  attention: 'bg-danger-50/50 dark:bg-danger-900/10',
};

// ─── types ────────────────────────────────────────────────────────────────────

interface ExpiryAlert {
  name: string;
  src: 'Bag' | 'Shelf';
  loc: string;
  expDate: Date;
  daysLeft: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  const router = useRouter();
  const { loading: authLoading, user, userData, role } = useUserRole();
  const [dataLoading, setDataLoading] = useState(true);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [packLogs, setPackLogs] = useState<Record<string, StatpackLog[]>>({});
  const [loadingLogs, setLoadingLogs] = useState<Record<string, boolean>>({});
  const [recentLogs, setRecentLogs] = useState<StatpackLog[]>([]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user) return;
    setDataLoading(true);
    let packsOk = false, invOk = false;
    const done = () => { if (packsOk && invOk) setDataLoading(false); };

    const toDate = (v: unknown): Date | undefined => {
      if (v instanceof Timestamp) return v.toDate();
      if (v instanceof Date) return v;
      return undefined;
    };

    const unsubPacks = onSnapshot(collection(db, 'statpacks'), snap => {
      setStatpacks(snap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id, ...d,
          lastCheckedAt: toDate(d.lastCheckedAt),
          contents: Array.isArray(d.contents)
            ? d.contents.map((item: StatpackItem) => ({
                ...item, expirationDate: toDate(item.expirationDate),
              }))
            : [],
        };
      }) as Statpack[]);
      packsOk = true; done();
    }, () => { packsOk = true; done(); });

    const unsubInv = onSnapshot(collection(db, 'inventory'), snap => {
      setInventory(snap.docs.map(doc => {
        const d = doc.data();
        return { id: doc.id, ...d, expirationDate: toDate(d.expirationDate) };
      }) as InventoryItem[]);
      invOk = true; done();
    }, () => { invOk = true; done(); });

    return () => { unsubPacks(); unsubInv(); };
  }, [user]);

  // Recent global activity — powers the mobile dashboard feed
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'statpack_logs'),
          orderBy('timestamp', 'desc'),
          limit(6),
        ));
        if (cancelled) return;
        setRecentLogs(snap.docs.map(doc => {
          const d = doc.data();
          const ts = d.timestamp instanceof Timestamp ? d.timestamp.toDate()
            : d.clientTimestamp instanceof Timestamp ? d.clientTimestamp.toDate()
            : null;
          return { id: doc.id, ...d, timestamp: ts } as StatpackLog;
        }));
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const lowStockItems = useMemo(
    () => inventory.filter(it => (it.totalStockQuantity ?? 0) <= it.reorderThreshold),
    [inventory],
  );

  const expiryAlerts: ExpiryAlert[] = useMemo(() => {
    const out: ExpiryAlert[] = [];
    statpacks.forEach(pack => {
      pack.contents?.forEach(item => {
        if (!item.expirationDate) return;
        const d = daysUntil(item.expirationDate as Date);
        if (d <= 60) out.push({
          name: item.itemDetails?.name || 'Unknown Item',
          src: 'Bag',
          loc: pack.name,
          expDate: item.expirationDate as Date,
          daysLeft: d,
        });
      });
    });
    inventory.forEach(item => {
      if (!item.batches?.length) return;
      const dates = (item.batches as { expirationDate?: string }[])
        .map(b => b.expirationDate ? new Date(b.expirationDate) : null)
        .filter((d): d is Date => d !== null);
      if (!dates.length) return;
      const earliest = dates.reduce((a, b) => (a < b ? a : b));
      const d = daysUntil(earliest);
      if (d <= 60) {
        let loc = item.location || 'HQ';
        if (item.room) loc += ` · ${item.room}`;
        if (item.shelf) loc += ` · ${item.shelf}`;
        out.push({ name: item.name, src: 'Shelf', loc, expDate: earliest, daysLeft: d });
      }
    });
    return out.sort((a, b) => a.daysLeft - b.daysLeft);
  }, [statpacks, inventory]);

  const handleExpandPack = async (packId: string) => {
    if (packLogs[packId] !== undefined) return;
    setLoadingLogs(prev => ({ ...prev, [packId]: true }));
    try {
      const snap = await getDocs(query(
        collection(db, 'statpack_logs'),
        where('statpackId', '==', packId),
        orderBy('timestamp', 'desc'),
        limit(5),
      ));
      setPackLogs(prev => ({
        ...prev,
        [packId]: snap.docs.map(doc => {
          const d = doc.data();
          const ts = d.timestamp instanceof Timestamp ? d.timestamp.toDate()
            : d.clientTimestamp instanceof Timestamp ? d.clientTimestamp.toDate()
            : null;
          return { id: doc.id, ...d, timestamp: ts } as StatpackLog;
        }),
      }));
    } catch { /* silent */ } finally {
      setLoadingLogs(prev => ({ ...prev, [packId]: false }));
    }
  };

  if (authLoading || dataLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (role && role !== 'admin' && role !== 'quartermaster' && userData) {
    return <MemberDashboard userData={userData} />;
  }

  const userName = userData?.fullName || user?.email?.split('@')[0] || 'there';

  return (
    <>
      {/* Desktop app-shell dashboard — md and up */}
      <div className="hidden md:block">
        <AdminDashboard
          statpacks={statpacks}
          lowStockItems={lowStockItems}
          expiryAlerts={expiryAlerts}
          packLogs={packLogs}
          loadingLogs={loadingLogs}
          onExpandPack={handleExpandPack}
        />
      </div>
      {/* Mobile dashboard (1A — hero readiness) — below md */}
      <div className="md:hidden">
        <MobileDashboard
          userName={userName}
          statpacks={statpacks}
          lowStockItems={lowStockItems}
          expiryAlerts={expiryAlerts}
          recentLogs={recentLogs}
        />
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD — full-page sidebar layout
// ═══════════════════════════════════════════════════════════════════════════════

interface AdminDashboardProps {
  statpacks: Statpack[];
  lowStockItems: InventoryItem[];
  expiryAlerts: ExpiryAlert[];
  packLogs: Record<string, StatpackLog[]>;
  loadingLogs: Record<string, boolean>;
  onExpandPack: (packId: string) => void;
}

function AdminDashboard({
  statpacks, lowStockItems, expiryAlerts,
  packLogs, loadingLogs, onExpandPack,
}: AdminDashboardProps) {
  const router = useRouter();
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const [modalSection, setModalSection] = useState<'low' | 'exp' | null>(null);
  const [search, setSearch] = useState('');

  const today = useMemo(() => new Date(), []);

  const handlePackClick = (packId: string) => {
    if (expandedPackId === packId) { setExpandedPackId(null); return; }
    setExpandedPackId(packId);
    onExpandPack(packId);
  };

  const sortedPacks = useMemo(() => [...statpacks].sort((a, b) => {
    const ORDER: Record<PackTier, number> = { attention: 0, inuse: 1, ready: 2 };
    return ORDER[getPackTier(a)] - ORDER[getPackTier(b)];
  }), [statpacks]);

  const readyCount = useMemo(() => statpacks.filter(p => getPackTier(p) === 'ready').length, [statpacks]);
  const allReady   = readyCount === statpacks.length;

  const selectedPack    = expandedPackId ? statpacks.find(p => p.id === expandedPackId) ?? null : null;
  const selectedTier    = selectedPack ? getPackTier(selectedPack) : null;
  const selectedExpired = useMemo(() => selectedPack?.contents?.filter(
    c => c.expirationDate && new Date(c.expirationDate as Date) < today,
  ) ?? [], [selectedPack, today]);
  const selectedLogs    = packLogs[expandedPackId ?? ''] ?? [];
  const isLoadingLogs   = loadingLogs[expandedPackId ?? ''] ?? false;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex flex-col">

      {/* Sticky top header */}
      <header className="sticky top-0 z-20 bg-content1/60 backdrop-blur-md border-b border-divider h-[54px] flex items-center gap-3.5 px-6">
        <h1 className="text-lg font-bold tracking-tight text-foreground flex-none">Dashboard</h1>

        {/* Search */}
        <div className="ml-auto flex-1 max-w-[380px] flex items-center gap-2 h-[38px] bg-content2 border border-divider rounded-[11px] px-3">
          <Search size={16} className="text-foreground-400 flex-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search packs, items, locations…"
            className="flex-1 border-none outline-none bg-transparent text-[13.5px] text-foreground placeholder:text-foreground-400 min-w-0"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-foreground-400 hover:text-foreground transition-colors">
              <X size={14} />
            </button>
          )}
          <span className="font-mono text-[10.5px] font-semibold text-foreground-400 bg-content1 border border-divider rounded-[6px] px-1.5 py-0.5 whitespace-nowrap flex-none">
            ⌘K
          </span>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 px-6 py-[22px] pb-16 w-full flex flex-col gap-[22px]">

          {/* ── Statpacks ──────────────────────────────────────── */}
          <section>
            <div
              className="bg-content1 border border-divider rounded-[18px] overflow-hidden"
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}
            >
              {/* Section header — matches alert card header style */}
              <div className="flex items-center gap-[11px] px-4 py-[13px] border-b border-divider bg-content2">
                <h2 className="text-base font-bold tracking-tight text-foreground">Statpacks</h2>
                <span className={`font-mono text-[11.5px] font-semibold px-2.5 py-[3px] rounded-full whitespace-nowrap ${
                  allReady
                    ? 'bg-success-50 dark:bg-success-900/20 text-success'
                    : 'bg-warning-50 dark:bg-warning-900/20 text-warning'
                }`}>
                  {readyCount}/{statpacks.length} ready
                </span>
                <button
                  onClick={() => router.push('/statpacks')}
                  className="ml-auto w-[30px] h-[30px] rounded-[9px] border border-divider bg-content1 text-foreground-400 flex items-center justify-center hover:bg-content2 hover:text-foreground transition-colors duration-150 flex-none"
                >
                  <ArrowUpRight size={15} />
                </button>
              </div>

              <div className="p-4 pb-[18px]">
              {/* Horizontal scroll row */}
              <div className="flex gap-3 overflow-x-auto px-0.5 pb-2" style={{ scrollbarWidth: 'thin' }}>
                {sortedPacks.length === 0 ? (
                  <p className="py-8 text-[12.5px] text-foreground-400 w-full text-center">No statpacks found.</p>
                ) : sortedPacks.map(pack => {
                  const tier       = getPackTier(pack);
                  const chips      = getPackChips(pack);
                  const isSelected = expandedPackId === pack.id;

                  return (
                    <div
                      key={pack.id}
                      onClick={() => handlePackClick(pack.id)}
                      className={`flex-none w-[244px] rounded-[14px] p-3 cursor-pointer transition-all duration-[220ms] ease-out ${
                        isSelected
                          ? `${TIER_SOFT_BG[tier]} border-2 ${TIER_BORDER[tier]}`
                          : 'bg-content1 border-2 border-divider hover:border-primary/40'
                      }`}
                      style={{ boxShadow: isSelected ? '0 6px 22px rgba(0,0,0,.12)' : '0 1px 2px rgba(0,0,0,.04)', transition: 'background-color 220ms ease-out, border-color 220ms ease-out, box-shadow 220ms ease-out' }}
                    >
                      <div className="flex items-start gap-2.5">
                        <span className={`w-[9px] h-[9px] rounded-full ${TIER_DOT[tier]} flex-none mt-1`} />
                        <div className="flex-1 min-w-0 flex flex-col gap-1">
                          <span className="font-semibold text-[13.5px] tracking-tight text-foreground whitespace-nowrap overflow-hidden text-ellipsis">
                            {pack.name}
                          </span>
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground-400 whitespace-nowrap overflow-hidden">
                            <Clock size={12} className="flex-none" />
                            {pack.lastCheckedAt
                              ? `Last check · ${fmtDate(pack.lastCheckedAt)}`
                              : 'No check recorded'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-[11px]">
                        <div className="flex flex-wrap gap-1.5 min-w-0">
                          {chips.slice(0, 2).map((chip, i) => (
                            <span
                              key={i}
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${CHIP_CLS[chip.color]}`}
                            >
                              {chip.label}
                            </span>
                          ))}
                        </div>
                        <ChevronDown
                          size={15}
                          className={`text-foreground-400 flex-none transition-transform duration-200 ${isSelected ? 'rotate-180' : ''}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Inline detail panel */}
              <AnimatePresence>
              {selectedPack && selectedTier && (
                <motion.div
                  key={selectedPack.id}
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 14 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                <div className={`border border-divider rounded-[12px] p-[13px] ${TIER_SOFT_BG[selectedTier]}`}>
                  <div className="text-[9.5px] font-semibold uppercase tracking-widest text-foreground-400 mb-1.5">
                    Viewing details
                  </div>

                  {/* Pack identity row */}
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className={`w-[9px] h-[9px] rounded-full flex-none ${TIER_DOT[selectedTier]}`} />
                    <span className="font-bold text-[15px] tracking-tight text-foreground">{selectedPack.name}</span>
                    {getPackChips(selectedPack).map((chip, i) => (
                      <span key={i} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${CHIP_CLS[chip.color]}`}>
                        {chip.label}
                      </span>
                    ))}
                    {selectedPack.lastCheckedAt && (
                      <span className="ml-auto text-[11.5px] font-semibold text-foreground-400">
                        Last check · {fmtDate(selectedPack.lastCheckedAt)}
                      </span>
                    )}
                  </div>

                  {/* Expired contents */}
                  {selectedExpired.length > 0 && (
                    <div className="border border-danger/30 bg-danger-50 dark:bg-danger-900/20 rounded-[11px] p-3 mb-3">
                      <div className="flex items-center gap-1.5 mb-2">
                        <AlertCircle size={13} className="text-danger flex-none" />
                        <span className="text-[10.5px] font-semibold uppercase tracking-widest text-danger">
                          Expired items
                        </span>
                      </div>
                      <div
                        className="grid gap-1.5"
                        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
                      >
                        {selectedExpired.map((item, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-danger flex-none" />
                            <span className="flex-1 text-[12.5px] font-semibold text-foreground min-w-0 truncate">
                              {item.itemDetails?.name ?? 'Unknown Item'}
                            </span>
                            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-[6px] bg-danger-100 dark:bg-danger-900/40 text-danger whitespace-nowrap flex-none">
                              {item.expirationDate
                                ? `Expired ${fmtMonthYear(item.expirationDate as Date)}`
                                : 'Expired'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent activity */}
                  <div className="text-[10.5px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                    Recent Activity
                  </div>
                  {isLoadingLogs ? (
                    <div className="flex justify-center py-4">
                      <Spinner size="sm" color="current" />
                    </div>
                  ) : selectedLogs.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {selectedLogs.map(log => {
                        const logCls =
                          log.action === 'checkout' ? 'bg-warning-50 dark:bg-warning-900/20 text-warning' :
                          log.action === 'checkin'  ? 'bg-success-50 dark:bg-success-900/20 text-success' :
                                                      'bg-primary-50 dark:bg-primary-900/20 text-primary';
                        const logLabel =
                          log.action === 'checkout' ? 'Checkout' :
                          log.action === 'checkin'  ? 'Check-in' : 'Maintenance';
                        const ts = log.timestamp instanceof Date ? log.timestamp : null;
                        const timeLabel = ts ? (() => {
                          const d = Math.round((today.getTime() - ts.getTime()) / 86400000);
                          return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d}d ago`;
                        })() : '—';
                        return (
                          <div key={log.id} className="flex items-start gap-2">
                            <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded-[5px] flex-none ${logCls}`}>
                              {logLabel}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[12px] font-semibold text-foreground-500">{log.notes || '—'}</div>
                              <div className="text-[10.5px] text-foreground-400 font-medium mt-0.5">
                                {log.userName} · {timeLabel}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[11.5px] text-foreground-400 py-0.5">No recent activity.</p>
                  )}
                </div>
                </motion.div>
              )}
              </AnimatePresence>
              </div>
            </div>
          </section>

          {/* ── Alert cards ────────────────────────────────────── */}
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>

            {/* Supply Closet Low */}
            <div
              className="bg-content1 border border-divider rounded-[16px] overflow-hidden"
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}
            >
              <div className="flex items-center gap-[11px] px-4 py-[13px] border-b border-divider bg-content2">
                <div className="w-[34px] h-[34px] rounded-[10px] bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center flex-none">
                  <AlertTriangle size={17} />
                </div>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setModalSection('low')}>
                  <div className="text-[14.5px] font-bold tracking-tight text-foreground">Supply Closet Low</div>
                </div>
                <span className="font-mono text-sm font-semibold px-3 py-1 rounded-full bg-danger-50 dark:bg-danger-900/20 text-danger whitespace-nowrap flex-none tabular-nums">
                  {lowStockItems.length}
                </span>
                <button
                  onClick={() => setModalSection('low')}
                  title="Expand"
                  className="w-[30px] h-[30px] rounded-[9px] border border-divider bg-content1 text-foreground-400 flex items-center justify-center hover:bg-content2 hover:text-foreground transition-colors duration-150 flex-none"
                >
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
                {lowStockItems.length > 0 ? lowStockItems.map(item => {
                  const out = (item.totalStockQuantity ?? 0) <= 0;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-3 px-[17px] py-3 border-b border-divider last:border-0 hover:bg-content2 transition-colors duration-150">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-foreground truncate">{item.name}</div>
                        <div className="text-[11px] text-foreground-400 font-medium">{item.category}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className="flex items-baseline gap-1 justify-end">
                          <span className={`font-mono text-[15px] font-semibold tabular-nums ${out ? 'text-danger' : 'text-warning'}`}>
                            {item.totalStockQuantity ?? 0}
                          </span>
                          <span className="text-[11.5px] text-foreground-400">/ {item.reorderThreshold}</span>
                        </div>
                        <div className={`text-[10.5px] font-semibold ${out ? 'text-danger' : 'text-warning'}`}>
                          {out ? 'Out of stock' : 'Reorder needed'}
                        </div>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="px-6 py-6 text-center text-[12.5px] text-foreground-400">
                    All stock levels healthy.
                  </div>
                )}
              </div>
            </div>

            {/* Expiring Items */}
            <div
              className="bg-content1 border border-divider rounded-[16px] overflow-hidden"
              style={{ boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}
            >
              <div className="flex items-center gap-[11px] px-4 py-[13px] border-b border-divider bg-content2">
                <div className="w-[34px] h-[34px] rounded-[10px] bg-warning-50 dark:bg-warning-900/20 text-warning flex items-center justify-center flex-none">
                  <Clock size={17} />
                </div>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setModalSection('exp')}>
                  <div className="text-[14.5px] font-bold tracking-tight text-foreground">Expiring Items</div>
                </div>
                <span className="font-mono text-sm font-semibold px-3 py-1 rounded-full bg-warning-50 dark:bg-warning-900/20 text-warning whitespace-nowrap flex-none tabular-nums">
                  {expiryAlerts.length}
                </span>
                <button
                  onClick={() => setModalSection('exp')}
                  title="Expand"
                  className="w-[30px] h-[30px] rounded-[9px] border border-divider bg-content1 text-foreground-400 flex items-center justify-center hover:bg-content2 hover:text-foreground transition-colors duration-150 flex-none"
                >
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
                {expiryAlerts.length > 0 ? expiryAlerts.map((alert, i) => {
                  const expired = alert.daysLeft < 0;
                  const srcCls  = alert.src === 'Bag'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary'
                    : 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300';
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 px-[17px] py-3 border-b border-divider last:border-0 hover:bg-content2 transition-colors duration-150">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-foreground truncate">{alert.name}</span>
                          <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded-[5px] whitespace-nowrap flex-none ${srcCls}`}>
                            {alert.src}
                          </span>
                        </div>
                        <div className="text-[11px] text-foreground-400 font-medium truncate">{alert.loc}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className={`text-[12px] font-semibold whitespace-nowrap ${expired ? 'text-danger' : 'text-warning'}`}>
                          {expired ? `Expired ${Math.abs(alert.daysLeft)}d ago` : `In ${alert.daysLeft}d`}
                        </div>
                        <div className="text-[10.5px] text-foreground-400 font-medium">
                          {fmtMonthYear(alert.expDate)}
                        </div>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="px-6 py-6 text-center text-[12.5px] text-foreground-400">
                    No immediate expirations.
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>

      {/* ── Expand-to-fullscreen modal ───────────────────────── */}
      {modalSection && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setModalSection(null)}
        >
          <div
            className="bg-content1 border border-divider rounded-[18px] flex flex-col overflow-hidden"
            style={{ width: '80vw', height: '80vh', maxWidth: 1000, boxShadow: '0 24px 70px rgba(0,0,0,.3)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center gap-3 px-[22px] py-[18px] bg-content2 border-b border-divider flex-none">
              <div className={`w-[38px] h-[38px] rounded-[11px] flex items-center justify-center flex-none ${
                modalSection === 'low'
                  ? 'bg-danger-50 dark:bg-danger-900/20 text-danger'
                  : 'bg-warning-50 dark:bg-warning-900/20 text-warning'
              }`}>
                {modalSection === 'low' ? <AlertTriangle size={19} /> : <Clock size={19} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-lg font-bold tracking-tight text-foreground">
                  {modalSection === 'low' ? 'Supply Closet Low' : 'Expiring Items'}
                </div>
                <div className="text-[12px] text-foreground-400 font-medium">
                  {(modalSection === 'low' ? lowStockItems.length : expiryAlerts.length)} items
                </div>
              </div>
              <button
                onClick={() => setModalSection(null)}
                title="Close"
                className="w-[34px] h-[34px] rounded-[10px] border border-divider bg-content1 text-foreground-400 flex items-center justify-center hover:bg-content2 hover:text-foreground transition-colors duration-150 flex-none"
              >
                <X size={17} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto">
              {modalSection === 'low' ? (
                lowStockItems.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-[13px] text-foreground-400">
                    All stock levels healthy.
                  </div>
                ) : lowStockItems.map(item => {
                  const out = (item.totalStockQuantity ?? 0) <= 0;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-3 px-[22px] py-3.5 border-b border-divider last:border-0 hover:bg-content2 transition-colors duration-150">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-semibold text-foreground">{item.name}</div>
                        <div className="text-[11.5px] text-foreground-400 font-medium">{item.category}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className="flex items-baseline gap-1 justify-end">
                          <span className={`font-mono text-[16px] font-semibold tabular-nums ${out ? 'text-danger' : 'text-warning'}`}>
                            {item.totalStockQuantity ?? 0}
                          </span>
                          <span className="text-[12px] text-foreground-400">/ {item.reorderThreshold}</span>
                        </div>
                        <div className={`text-[11px] font-semibold ${out ? 'text-danger' : 'text-warning'}`}>
                          {out ? 'Out of stock' : 'Reorder needed'}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                expiryAlerts.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-[13px] text-foreground-400">
                    No immediate expirations.
                  </div>
                ) : expiryAlerts.map((alert, i) => {
                  const expired = alert.daysLeft < 0;
                  const srcCls  = alert.src === 'Bag'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary'
                    : 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300';
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 px-[22px] py-3.5 border-b border-divider last:border-0 hover:bg-content2 transition-colors duration-150">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13.5px] font-semibold text-foreground">{alert.name}</span>
                          <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded-[5px] whitespace-nowrap flex-none ${srcCls}`}>
                            {alert.src}
                          </span>
                        </div>
                        <div className="text-[11.5px] text-foreground-400 font-medium">{alert.loc}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className={`text-[12.5px] font-semibold whitespace-nowrap ${expired ? 'text-danger' : 'text-warning'}`}>
                          {expired ? `Expired ${Math.abs(alert.daysLeft)}d ago` : `In ${alert.daysLeft}d`}
                        </div>
                        <div className="text-[11px] text-foreground-400 font-medium">
                          {fmtMonthYear(alert.expDate)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE DASHBOARD — 1A "Hero readiness"
// ═══════════════════════════════════════════════════════════════════════════════

interface MobileDashboardProps {
  userName: string;
  statpacks: Statpack[];
  lowStockItems: InventoryItem[];
  expiryAlerts: ExpiryAlert[];
  recentLogs: StatpackLog[];
}

const LOG_META: Record<StatpackLog['action'], { label: string; cls: string }> = {
  checkin:     { label: 'Check-in', cls: 'bg-success-50 dark:bg-success-900/20 text-success' },
  checkout:    { label: 'Checkout', cls: 'bg-warning-50 dark:bg-warning-900/20 text-warning' },
  restock:     { label: 'Restock',  cls: 'bg-primary-50 dark:bg-primary-900/20 text-primary' },
  maintenance: { label: 'Maint.',   cls: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' },
  audit:       { label: 'Audit',    cls: 'bg-primary-50 dark:bg-primary-900/20 text-primary' },
  created:     { label: 'Created',  cls: 'bg-content3 text-foreground-500' },
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function relTime(d: Date | unknown): string {
  if (!(d instanceof Date)) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function MobileDashboard({
  userName, statpacks, lowStockItems, expiryAlerts, recentLogs,
}: MobileDashboardProps) {
  const router = useRouter();
  const [modalSection, setModalSection] = useState<'low' | 'exp' | null>(null);

  const total       = statpacks.length;
  const readyCount  = useMemo(() => statpacks.filter(p => getPackTier(p) === 'ready').length, [statpacks]);
  const inuseCount  = useMemo(() => statpacks.filter(p => getPackTier(p) === 'inuse').length, [statpacks]);
  const attnCount   = useMemo(() => statpacks.filter(p => getPackTier(p) === 'attention').length, [statpacks]);
  const frac        = total ? readyCount / total : 0;

  const outOfStock   = useMemo(() => lowStockItems.filter(i => (i.totalStockQuantity ?? 0) <= 0).length, [lowStockItems]);
  const expiringSoon = useMemo(() => expiryAlerts.filter(a => a.daysLeft >= 0 && a.daysLeft <= 7).length, [expiryAlerts]);
  const expiredCount = useMemo(() => expiryAlerts.filter(a => a.daysLeft < 0).length, [expiryAlerts]);

  const firstName = userName.split(' ')[0];

  const quickActions = [
    { label: 'Check-out', Icon: ArrowRightLeft, tint: 'primary', to: '/statpacks/checkout' },
    { label: 'Restock',   Icon: Plus,           tint: 'primary', to: '/restock' },
    { label: 'Scan',      Icon: ScanLine,       tint: 'primary', to: '/audit' },
    { label: 'Reports',   Icon: FileText,       tint: 'warning', to: '/issue-reports' },
  ] as const;

  const tintCls: Record<'primary' | 'warning', string> = {
    primary: 'bg-primary-50 dark:bg-primary-900/20 text-primary',
    warning: 'bg-warning-50 dark:bg-warning-900/20 text-warning',
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-30 bg-transparent backdrop-blur-md flex items-center gap-3 px-5 pt-4 pb-3.5">
        <div className="w-[42px] h-[42px] rounded-[13px] bg-primary text-white font-semibold text-base flex items-center justify-center flex-none">
          {firstName[0]?.toUpperCase() ?? 'U'}
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[11.5px] text-foreground-400 font-semibold">{greeting()}</div>
          <div className="text-base font-bold tracking-tight text-foreground truncate">{firstName}</div>
        </div>
        <button
          onClick={() => router.push('/issue-reports')}
          className="w-10 h-10 rounded-[12px] border border-divider bg-content1 text-foreground-500 flex items-center justify-center flex-none relative active:scale-95 transition-transform"
          aria-label="Reports"
        >
          <Bell size={19} />
          {expiredCount + outOfStock > 0 && (
            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-danger border-2 border-content1" />
          )}
        </button>
      </header>

      {/* Scroll body */}
      <div className="flex-1 px-4 pt-0.5 pb-32 flex flex-col gap-3.5">

        {/* Hero readiness */}
        <div className="bg-content1 border border-divider rounded-[22px] p-4" style={{ boxShadow: '0 1px 3px rgba(16,24,40,.05)' }}>
          <div className="flex items-center mb-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold tracking-tight text-foreground">Statpack readiness</div>
              <div className="text-[11.5px] text-foreground-400 font-medium">{total} packs tracked · today</div>
            </div>
            <button
              onClick={() => router.push('/statpacks')}
              className="flex items-center gap-0.5 text-xs font-semibold text-primary active:opacity-70"
            >
              Details <ChevronRight size={15} />
            </button>
          </div>
          <div className="flex items-center gap-5">
            <div
              className="w-[104px] h-[104px] rounded-full flex items-center justify-center flex-none"
              style={{ background: `conic-gradient(hsl(var(--heroui-primary)) 0turn ${frac}turn, hsl(var(--heroui-content3)) ${frac}turn 1turn)` }}
            >
              <div className="w-[78px] h-[78px] rounded-full bg-content1 flex flex-col items-center justify-center">
                <span className="text-[23px] font-bold tracking-tight text-foreground tabular-nums leading-none">{readyCount}/{total}</span>
                <span className="text-[9px] font-bold uppercase tracking-widest text-foreground-400 mt-1">ready</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-2.5">
              <ReadinessRow dot="bg-success" label="Ready" value={readyCount} />
              <div className="h-px bg-divider" />
              <ReadinessRow dot="bg-primary" label="In use" value={inuseCount} />
              <div className="h-px bg-divider" />
              <ReadinessRow dot="bg-danger" label="Needs attention" value={attnCount} />
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-4 gap-2.5">
          {quickActions.map(({ label, Icon, tint, to }) => (
            <button
              key={label}
              onClick={() => router.push(to)}
              className="bg-content1 border border-divider rounded-[16px] py-3 px-1 flex flex-col items-center gap-2 active:scale-95 transition-transform"
            >
              <span className={`w-11 h-11 rounded-[13px] flex items-center justify-center ${tintCls[tint]}`}>
                <Icon size={21} />
              </span>
              <span className="text-[10.5px] font-semibold text-foreground-500">{label}</span>
            </button>
          ))}
        </div>

        {/* Alert tiles */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setModalSection('low')}
            className="text-left bg-content1 border border-divider rounded-[18px] p-4 flex flex-col gap-2.5 active:scale-[.98] transition-transform"
          >
            <div className="flex items-center">
              <span className="w-9 h-9 rounded-[11px] bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center flex-none">
                <AlertTriangle size={18} />
              </span>
              <ChevronRight size={18} className="ml-auto text-foreground-300" />
            </div>
            <div>
              <div className="text-[28px] font-bold tracking-tight text-foreground tabular-nums leading-none">{lowStockItems.length}</div>
              <div className="text-[12.5px] font-semibold text-foreground-500 mt-1">Low supply</div>
              <div className="text-[11px] font-semibold text-danger mt-0.5">{outOfStock} out of stock</div>
            </div>
          </button>
          <button
            onClick={() => setModalSection('exp')}
            className="text-left bg-content1 border border-divider rounded-[18px] p-4 flex flex-col gap-2.5 active:scale-[.98] transition-transform"
          >
            <div className="flex items-center">
              <span className="w-9 h-9 rounded-[11px] bg-warning-50 dark:bg-warning-900/20 text-warning flex items-center justify-center flex-none">
                <Clock size={18} />
              </span>
              <ChevronRight size={18} className="ml-auto text-foreground-300" />
            </div>
            <div>
              <div className="text-[28px] font-bold tracking-tight text-foreground tabular-nums leading-none">{expiryAlerts.length}</div>
              <div className="text-[12.5px] font-semibold text-foreground-500 mt-1">Expiring</div>
              <div className="text-[11px] font-semibold text-warning mt-0.5">{expiringSoon} within 7 days</div>
            </div>
          </button>
        </div>

        {/* Recent activity */}
        <div className="bg-content1 border border-divider rounded-[18px] px-4 pt-4 pb-1.5" style={{ boxShadow: '0 1px 3px rgba(16,24,40,.04)' }}>
          <div className="flex items-center mb-3">
            <span className="text-sm font-bold tracking-tight text-foreground flex-1">Recent activity</span>
            <button onClick={() => router.push('/stats?tab=statpacks')} className="text-xs font-semibold text-primary active:opacity-70">See all</button>
          </div>
          {recentLogs.length > 0 ? recentLogs.map((log, i) => {
            const meta = LOG_META[log.action] ?? LOG_META.created;
            return (
              <div
                key={log.id ?? i}
                className={`flex items-start gap-2.5 py-3 ${i < recentLogs.length - 1 ? 'border-b border-divider' : ''}`}
              >
                <span className={`text-[9.5px] font-semibold px-2 py-0.5 rounded-md flex-none whitespace-nowrap ${meta.cls}`}>
                  {meta.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-semibold text-foreground-500 leading-snug">
                    {log.notes || log.statpackName || '—'}
                  </div>
                  <div className="text-[10.5px] text-foreground-400 font-medium mt-0.5">
                    {log.userName} · {relTime(log.timestamp)}
                  </div>
                </div>
              </div>
            );
          }) : (
            <p className="text-[12px] text-foreground-400 py-4 text-center">No recent activity.</p>
          )}
        </div>
      </div>

      {/* FAB — scan */}
      <button
        onClick={() => router.push('/audit')}
        aria-label="Scan"
        className="fixed right-5 bottom-[92px] w-14 h-14 rounded-[18px] bg-primary text-white flex items-center justify-center z-30 active:scale-95 transition-transform"
        style={{ boxShadow: '0 10px 24px rgba(0,111,238,.45)' }}
      >
        <ScanLine size={24} />
      </button>

      {/* Alert list sheet */}
      {modalSection && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={() => setModalSection(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative bg-content1 rounded-t-[22px] flex flex-col overflow-hidden max-h-[85vh]"
            style={{ boxShadow: '0 -12px 40px rgba(0,0,0,.25)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-divider flex-none">
              <div className={`w-[38px] h-[38px] rounded-[11px] flex items-center justify-center flex-none ${
                modalSection === 'low'
                  ? 'bg-danger-50 dark:bg-danger-900/20 text-danger'
                  : 'bg-warning-50 dark:bg-warning-900/20 text-warning'
              }`}>
                {modalSection === 'low' ? <AlertTriangle size={19} /> : <Clock size={19} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-base font-bold tracking-tight text-foreground">
                  {modalSection === 'low' ? 'Low supply' : 'Expiring items'}
                </div>
                <div className="text-[11.5px] text-foreground-400 font-medium">
                  {(modalSection === 'low' ? lowStockItems.length : expiryAlerts.length)} items
                </div>
              </div>
              <button
                onClick={() => setModalSection(null)}
                aria-label="Close"
                className="w-9 h-9 rounded-[11px] bg-content2 text-foreground-400 flex items-center justify-center flex-none active:scale-95 transition-transform"
              >
                <X size={17} />
              </button>
            </div>
            <div className="overflow-y-auto">
              {modalSection === 'low' ? (
                lowStockItems.length === 0 ? (
                  <div className="px-6 py-10 text-center text-[13px] text-foreground-400">All stock levels healthy.</div>
                ) : lowStockItems.map(item => {
                  const out = (item.totalStockQuantity ?? 0) <= 0;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-divider last:border-0">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-semibold text-foreground truncate">{item.name}</div>
                        <div className="text-[11.5px] text-foreground-400 font-medium">{item.category}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className="flex items-baseline gap-1 justify-end">
                          <span className={`font-mono text-[15px] font-semibold tabular-nums ${out ? 'text-danger' : 'text-warning'}`}>
                            {item.totalStockQuantity ?? 0}
                          </span>
                          <span className="text-[11.5px] text-foreground-400">/ {item.reorderThreshold}</span>
                        </div>
                        <div className={`text-[10.5px] font-semibold ${out ? 'text-danger' : 'text-warning'}`}>
                          {out ? 'Out of stock' : 'Reorder needed'}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                expiryAlerts.length === 0 ? (
                  <div className="px-6 py-10 text-center text-[13px] text-foreground-400">No immediate expirations.</div>
                ) : expiryAlerts.map((alert, i) => {
                  const expired = alert.daysLeft < 0;
                  const srcCls  = alert.src === 'Bag'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary'
                    : 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300';
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-divider last:border-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13.5px] font-semibold text-foreground truncate">{alert.name}</span>
                          <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded-[5px] whitespace-nowrap flex-none ${srcCls}`}>
                            {alert.src}
                          </span>
                        </div>
                        <div className="text-[11.5px] text-foreground-400 font-medium truncate">{alert.loc}</div>
                      </div>
                      <div className="text-right flex-none">
                        <div className={`text-[12.5px] font-semibold whitespace-nowrap ${expired ? 'text-danger' : 'text-warning'}`}>
                          {expired ? `Expired ${Math.abs(alert.daysLeft)}d ago` : `In ${alert.daysLeft}d`}
                        </div>
                        <div className="text-[11px] text-foreground-400 font-medium">{fmtMonthYear(alert.expDate)}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadinessRow({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-[9px] h-[9px] rounded-full flex-none ${dot}`} />
      <span className="text-[13px] font-semibold text-foreground-500 flex-1 min-w-0 truncate">{label}</span>
      <span className="text-[15px] font-bold text-foreground tabular-nums">{value}</span>
    </div>
  );
}
