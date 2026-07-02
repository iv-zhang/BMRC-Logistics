'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Spinner } from '@heroui/react';
import {
  Search,
  ClipboardCheck,
  Package,
  Box,
  Backpack,
  AlertTriangle,
  CheckCircle2,
  Check,
  Shield,
  ScanLine,
  RefreshCw,
  ScrollText,
  PackagePlus,
  X,
} from 'lucide-react';
import { collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, Statpack } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  canUserAudit,
  generateAuditSnapshot,
  analyzeRestockNeeds,
  auditLog,
  type AuditSnapshot,
  type RestockDecision,
} from '@/app/lib/audit-helpers';
import {
  currentAuditCycleLabel,
  isStatpackAuditCurrent,
  statpackAuditDueInDays,
} from '@/app/lib/item-status';
import { getInventoryAreaOptions, THRESHOLDS } from '@/app/config/org-config';
import {
  DisposableAuditCard,
  AssetAuditCard,
} from '@/app/components/audit-item-card';
import AuditActionDrawer, { type DrawerAction } from '@/app/components/audit-action-drawer';
import BarcodeScanner from '@/app/components/barcode-scanner';
import AuditPermissionModal from '@/app/components/audit-permission-modal';
import AuditDebugPanel from '@/app/components/audit-debug-panel';

// ─── Zones for quick filtering (from org-config — single source of truth) ────
const AREA_OPTIONS = getInventoryAreaOptions();

type AuditTab = 'disposables' | 'assets' | 'statpacks' | 'restock';

function toDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val;
  if (val instanceof Timestamp) return val.toDate();
  if (typeof val === 'object' && typeof (val as { toDate?: () => Date }).toDate === 'function')
    return (val as { toDate: () => Date }).toDate();
  return undefined;
}

export default function AuditPage() {
  const router = useRouter();
  const { loading: authLoading, user, userData, role } = useUserRole();

  // Core state
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filter state
  const [selectedZone, setSelectedZone] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<AuditTab>('disposables');
  const [dueOnly, setDueOnly] = useState(false);

  // Action drawer — the heart of the "act on what's in front of you" flow
  const [drawerItem, setDrawerItem] = useState<InventoryItem | null>(null);
  const [drawerAction, setDrawerAction] = useState<DrawerAction>('count');

  // Result toast
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Barcode scanner
  const [scannerOpen, setScannerOpen] = useState(false);

  // Permission modal
  const [permModalOpen, setPermModalOpen] = useState(false);

  // Restock analysis
  const [restockDecisions, setRestockDecisions] = useState<RestockDecision[]>([]);

  // ─── Auth & permission check ──────────────────────────────────────────────
  const hasAuditAccess = useMemo(() => canUserAudit(userData), [userData]);
  const isAdmin = role === 'admin' || role === 'quartermaster';

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
  }, [authLoading, user, router]);

  // ─── Load inventory (real-time) ───────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<InventoryItem, 'id'>),
      })) as InventoryItem[];
      setInventory(items);
      setLoading(false);
    });
    return () => unsub();
  }, [user]);

  // ─── Load statpacks (real-time) for the biweekly audit tab ───────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      setStatpacks(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Statpack, 'id'>) })) as Statpack[]
      );
    });
    return () => unsub();
  }, [user]);

  // ─── Generate snapshot when inventory or zone changes ─────────────────────
  useEffect(() => {
    if (inventory.length === 0) return;
    refreshSnapshot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, selectedZone]);

  const refreshSnapshot = useCallback(async () => {
    setRefreshing(true);
    try {
      const zone = selectedZone === 'all' ? undefined : selectedZone;
      const snap = await generateAuditSnapshot(zone);
      setSnapshot(snap);
      setRestockDecisions(analyzeRestockNeeds(snap.disposables));
      auditLog.info('Snapshot refreshed', {
        zone,
        disposables: snap.totalDisposableTypes,
        assets: snap.totalAssetTypes,
      });
    } catch (e) {
      auditLog.error('Failed to generate snapshot', e);
    }
    setRefreshing(false);
  }, [selectedZone]);

  // ─── Filtered items — search covers name, category, and location ──────────
  const filteredDisposables = useMemo(() => {
    if (!snapshot) return [];
    let items = snapshot.disposables;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          (i.name || '').toLowerCase().includes(q) ||
          (i.category || '').toLowerCase().includes(q) ||
          (i.location || '').toLowerCase().includes(q) ||
          (i.room || '').toLowerCase().includes(q)
      );
    }
    if (dueOnly) {
      items = items.filter((i) => !i.auditVerified);
    }
    return items;
  }, [snapshot, searchQuery, dueOnly]);

  const filteredAssets = useMemo(() => {
    if (!snapshot) return [];
    let items = snapshot.assets;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          (i.name || '').toLowerCase().includes(q) ||
          (i.category || '').toLowerCase().includes(q) ||
          (i.assetSerial || '').toLowerCase().includes(q) ||
          (i.currentLocation || '').toLowerCase().includes(q)
      );
    }
    if (dueOnly) {
      items = items.filter((i) => !i.auditVerified);
    }
    return items;
  }, [snapshot, searchQuery, dueOnly]);

  // ─── Statpacks with biweekly audit status ─────────────────────────────────
  const statpackRows = useMemo(() => {
    let packs = statpacks.map((p) => {
      const lastAuditAt = toDate(p.lastAuditAt);
      return {
        pack: p,
        lastAuditAt,
        auditCurrent: isStatpackAuditCurrent(lastAuditAt),
        dueInDays: statpackAuditDueInDays(lastAuditAt),
      };
    });
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      packs = packs.filter(
        ({ pack }) =>
          pack.name.toLowerCase().includes(q) ||
          (pack.type || '').toLowerCase().includes(q)
      );
    }
    if (dueOnly) {
      packs = packs.filter((p) => !p.auditCurrent);
    }
    // Due packs first, then oldest audit first
    return packs.sort((a, b) => {
      if (a.auditCurrent !== b.auditCurrent) return a.auditCurrent ? 1 : -1;
      return (a.lastAuditAt?.getTime() ?? 0) - (b.lastAuditAt?.getTime() ?? 0);
    });
  }, [statpacks, searchQuery, dueOnly]);

  const statpacksDue = useMemo(
    () => statpacks.filter((p) => !isStatpackAuditCurrent(toDate(p.lastAuditAt))).length,
    [statpacks]
  );

  // ─── Action drawer plumbing ───────────────────────────────────────────────
  const openDrawer = useCallback(
    (itemId: string, action: DrawerAction) => {
      const inv = inventory.find((i) => i.id === itemId);
      if (!inv) return;
      setDrawerItem(inv);
      setDrawerAction(action);
    },
    [inventory]
  );

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleDrawerResult = useCallback(
    (msg: string, ok: boolean) => {
      showToast(msg, ok);
      if (ok) refreshSnapshot();
    },
    [showToast, refreshSnapshot]
  );

  // ─── Loading / auth states ────────────────────────────────────────────────
  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!hasAuditAccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large max-w-md w-full text-center py-10 px-6">
          <Shield size={40} className="mx-auto text-foreground-300 mb-4" />
          <h2 className="text-base font-semibold text-foreground mb-2">Audit Access Required</h2>
          <p className="text-sm text-foreground-500">
            You don&apos;t have permission to perform inventory audits. Ask an admin to
            grant you audit access.
          </p>
        </div>
      </div>
    );
  }

  // ─── Main audit workbench ─────────────────────────────────────────────────
  const verifiedDisposables = snapshot
    ? snapshot.disposables.filter((d) => d.auditVerified).length
    : 0;
  const verifiedAssets = snapshot
    ? snapshot.assets.filter((a) => a.auditVerified).length
    : 0;
  const totalItems =
    (snapshot?.totalDisposableTypes ?? 0) + (snapshot?.totalAssetTypes ?? 0);
  const totalVerified = verifiedDisposables + verifiedAssets;
  const cyclePct = totalItems > 0 ? (totalVerified / totalItems) * 100 : 0;
  const packsAudited = statpacks.length - statpacksDue;
  const packCyclePct = statpacks.length > 0 ? (packsAudited / statpacks.length) * 100 : 0;

  const tabs: { key: AuditTab; icon: React.ReactNode; label: string; count: number }[] = [
    { key: 'disposables', icon: <Box size={14} />, label: 'Disposables', count: filteredDisposables.length },
    { key: 'assets', icon: <Package size={14} />, label: 'Assets', count: filteredAssets.length },
    { key: 'statpacks', icon: <Backpack size={14} />, label: 'Statpacks', count: statpacksDue },
    { key: 'restock', icon: <AlertTriangle size={14} />, label: 'Restock', count: restockDecisions.length },
  ];

  const actorZone = selectedZone === 'all' ? 'All' : selectedZone;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Supply Audit</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{totalItems}</span>
                <span className="text-xs text-foreground-400">items</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{totalVerified}</span>
                <span className="text-xs text-success/80 font-medium">audited this month</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{snapshot?.lowStockCount ?? 0}</span>
                <span className="text-xs text-warning/80 font-medium">low / out</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{snapshot?.expiredCount ?? 0}</span>
                <span className="text-xs text-danger/80 font-medium">expired</span>
              </div>
              {statpacksDue > 0 && (
                <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-warning">{statpacksDue}</span>
                  <span className="text-xs text-warning/80 font-medium">packs due</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="flat"
              startContent={<ScrollText size={14} />}
              onPress={() => router.push('/audit/events')}
            >
              Ledger
            </Button>
            <Button
              size="sm"
              variant="flat"
              startContent={<RefreshCw size={14} />}
              onPress={refreshSnapshot}
              isLoading={refreshing}
            >
              Refresh
            </Button>
            {isAdmin && (
              <Button
                size="sm"
                variant="flat"
                startContent={<Shield size={14} />}
                onPress={() => setPermModalOpen(true)}
              >
                Permissions
              </Button>
            )}
            <Button
              color="primary"
              size="sm"
              startContent={<ScanLine size={15} />}
              onPress={() => setScannerOpen(true)}
            >
              Scan item
            </Button>
          </div>
        </div>

        {/* ── Cycle progress ─────────────────────────────────────────────── */}
        <div className="bg-content1 border border-divider rounded-large p-4 mb-4 space-y-3">
          <div>
            <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                {currentAuditCycleLabel()} audit cycle
              </span>
              <span className="text-xs text-foreground-500">
                <span className="font-mono font-semibold tabular-nums text-foreground">{totalVerified}</span>
                {' '}of{' '}
                <span className="font-mono font-semibold tabular-nums text-foreground">{totalItems}</span>
                {' '}items verified — resets on the 1st
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${cyclePct >= 100 ? 'bg-success' : 'bg-primary'}`}
                style={{ width: `${cyclePct}%` }}
              />
            </div>
          </div>
          {statpacks.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                  Statpack cycle — every {THRESHOLDS.statpackAuditIntervalDays} days
                </span>
                <span className="text-xs text-foreground-500">
                  <span className="font-mono font-semibold tabular-nums text-foreground">{packsAudited}</span>
                  {' '}of{' '}
                  <span className="font-mono font-semibold tabular-nums text-foreground">{statpacks.length}</span>
                  {' '}packs current
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${packCyclePct >= 100 ? 'bg-success' : 'bg-primary'}`}
                  style={{ width: `${packCyclePct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Filter bar ─────────────────────────────────────────────────── */}
        <div className="bg-content1 border border-divider rounded-large p-3 mb-4 flex items-center gap-3 flex-wrap">
          {/* Tab toggle */}
          <div className="flex bg-content2 rounded-large p-1 gap-1 flex-wrap">
            {tabs.map(({ key, icon, label, count }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                  activeTab === key
                    ? 'bg-primary text-white'
                    : 'text-foreground-500 hover:bg-content3'
                }`}
              >
                {icon} {label}
                <span className={`tabular-nums text-xs ${activeTab === key ? 'text-white/80' : 'text-foreground-400'}`}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {activeTab !== 'statpacks' && (
            <select
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value || 'all')}
              className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
            >
              <option value="all">All locations</option>
              {AREA_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}

          <div className="flex-1 min-w-[220px] flex items-center gap-2 bg-content2 border border-divider rounded-medium px-3 py-0.5">
            <Search size={15} className="text-foreground-400 flex-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search items, categories, locations…"
              className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-foreground-400 hover:text-foreground-600 transition-colors">
                <X size={15} />
              </button>
            )}
          </div>

          <button
            onClick={() => setDueOnly(!dueOnly)}
            className={`px-3 py-1.5 rounded-medium text-xs font-semibold border transition-colors duration-150 ${
              dueOnly
                ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                : 'border-divider hover:bg-content2 text-foreground-500'
            }`}
          >
            Due only
          </button>
        </div>

        {/* ── Lists ──────────────────────────────────────────────────────── */}
        {activeTab === 'disposables' && (
          <div className="space-y-3">
            {filteredDisposables.length === 0 ? (
              <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                <Box size={32} className="mx-auto text-foreground-300 mb-2" />
                <p className="text-sm font-semibold text-foreground-500">No disposable items match</p>
                <p className="text-xs text-foreground-400 mt-1">Try clearing the search or location filter.</p>
              </div>
            ) : (
              filteredDisposables.map((item) => (
                <DisposableAuditCard
                  key={item.id}
                  item={item}
                  onAction={(d, action) => openDrawer(d.id, action)}
                />
              ))
            )}
          </div>
        )}

        {activeTab === 'assets' && (
          <div className="space-y-3">
            {filteredAssets.length === 0 ? (
              <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                <Package size={32} className="mx-auto text-foreground-300 mb-2" />
                <p className="text-sm font-semibold text-foreground-500">No assets match</p>
                <p className="text-xs text-foreground-400 mt-1">Try clearing the search or location filter.</p>
              </div>
            ) : (
              filteredAssets.map((item) => (
                <AssetAuditCard
                  key={item.id}
                  item={item}
                  onAction={(a, action) => openDrawer(a.id, action)}
                />
              ))
            )}
          </div>
        )}

        {activeTab === 'statpacks' && (
          <div className="space-y-3">
            {statpackRows.length === 0 ? (
              <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                <Backpack size={32} className="mx-auto text-foreground-300 mb-2" />
                <p className="text-sm font-semibold text-foreground-500">No statpacks match</p>
                <p className="text-xs text-foreground-400 mt-1">Try clearing the search.</p>
              </div>
            ) : (
              statpackRows.map(({ pack, lastAuditAt, auditCurrent, dueInDays }) => (
                <div
                  key={pack.id}
                  className="flex gap-4 items-center flex-wrap bg-content1 border border-divider rounded-large px-4 py-4 hover:border-primary/30 hover:shadow-sm transition-all duration-150"
                >
                  <div className="w-[50px] h-[50px] rounded-[13px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                    <Backpack size={22} />
                  </div>

                  <div className="flex-1 min-w-0 basis-40">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-foreground">{pack.name}</span>
                      <span className="text-xs text-foreground-400">{pack.type}</span>
                    </div>
                    <div className="flex gap-1.5 flex-wrap items-center">
                      <Chip
                        size="sm"
                        variant="flat"
                        color={pack.isCheckedOut ? 'primary' : pack.status === 'Ready' ? 'success' : 'warning'}
                      >
                        {pack.isCheckedOut ? 'Checked Out' : pack.status}
                      </Chip>
                      {auditCurrent ? (
                        <Chip size="sm" variant="flat" color="success">Audit current</Chip>
                      ) : (
                        <Chip size="sm" variant="flat" color="warning">Audit due</Chip>
                      )}
                      <span className="text-xs text-foreground-400">
                        {lastAuditAt
                          ? `Audited ${lastAuditAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${
                              auditCurrent && dueInDays !== undefined ? ` · due in ${dueInDays}d` : ''
                            }`
                          : 'Never audited'}
                      </span>
                    </div>
                  </div>

                  <div className="flex-none">
                    <Button
                      size="sm"
                      color="primary"
                      variant="flat"
                      startContent={<ClipboardCheck size={14} />}
                      onPress={() => router.push(`/statpacks/check-off?id=${pack.id}&mode=audit`)}
                    >
                      Audit pack
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'restock' && (
          <div className="space-y-3">
            {restockDecisions.length === 0 ? (
              <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                <CheckCircle2 size={32} className="mx-auto text-success mb-2" />
                <p className="text-sm font-semibold text-foreground-500">All stock levels are adequate</p>
              </div>
            ) : (
              restockDecisions.map((d) => (
                <div
                  key={d.itemId}
                  className={`flex items-center gap-4 flex-wrap border rounded-large px-4 py-4 ${
                    d.urgency === 'critical'
                      ? 'bg-danger-50/60 dark:bg-danger-950/20 border-danger/30'
                      : 'bg-warning-50/60 dark:bg-warning-950/20 border-warning/30'
                  }`}
                >
                  <div className="flex-1 min-w-0 basis-40">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-foreground">{d.itemName}</span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        d.urgency === 'critical'
                          ? 'bg-danger-50 dark:bg-danger-900/20 text-danger'
                          : 'bg-warning-50 dark:bg-warning-900/20 text-warning'
                      }`}>
                        {d.urgency === 'critical' ? 'Critical' : 'Low'}
                      </span>
                    </div>
                    <div className="text-xs text-foreground-500 mt-1">{d.recommendation}</div>
                  </div>
                  <div className="text-right flex-none">
                    <div className={`font-mono text-xl font-semibold tabular-nums leading-none ${
                      d.urgency === 'critical' ? 'text-danger' : 'text-warning'
                    }`}>
                      {d.totalUnits}
                    </div>
                    <div className="text-[9px] uppercase tracking-wider text-foreground-400 mt-1 font-semibold">
                      / {d.reorderThreshold} par
                    </div>
                  </div>
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    className="flex-none"
                    startContent={<PackagePlus size={14} />}
                    onPress={() => openDrawer(d.itemId, 'shipment')}
                  >
                    Add shipment
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Action drawer */}
      {drawerItem && user && (
        <AuditActionDrawer
          item={drawerItem}
          initialAction={drawerAction}
          actor={{
            uid: user.uid,
            name: userData?.fullName || user.displayName || user.email || 'Unknown',
            email: user.email,
          }}
          zoneLabel={actorZone}
          onClose={() => setDrawerItem(null)}
          onResult={handleDrawerResult}
        />
      )}

      {/* Result toast */}
      {toast && (
        <div className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${
          toast.ok ? 'bg-success' : 'bg-danger'
        }`}>
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok ? <Check size={12} strokeWidth={3.5} /> : <span className="text-xs leading-none">✕</span>}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Permission modal */}
      {isAdmin && userData && (
        <AuditPermissionModal
          isOpen={permModalOpen}
          onClose={() => setPermModalOpen(false)}
          adminUser={{ id: user!.uid, name: userData.fullName }}
        />
      )}

      {/* Barcode Scanner — scan a code to jump straight to the item */}
      <BarcodeScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(val) => {
          setScannerOpen(false);
          const match = inventory.find(
            (i) => i.barcode === val || i.qr === val || i.assignedBarcode === val || i.assetSerial === val
          );
          if (match) {
            setDrawerItem(match);
            setDrawerAction('count');
          } else {
            setSearchQuery(val);
          }
        }}
      />

      {/* Debug panel (admin only — toggle with ⌘+Shift+D) */}
      {isAdmin && (
        <AuditDebugPanel
          inventory={inventory}
          snapshot={snapshot}
          userRole={role ?? 'unknown'}
          canAudit={hasAuditAccess}
        />
      )}
    </div>
  );
}
