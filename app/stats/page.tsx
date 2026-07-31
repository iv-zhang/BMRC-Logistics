'use client';

/**
 * Unified Statistics page — combines Statpack usage stats and Restock stats
 * behind one route with a segmented view toggle. Replaces the separate
 * /statpacks/stats and /restock-stats pages (both now redirect here).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Button, Card, CardBody, Spinner } from '@heroui/react';
import { RefreshCw, TrendingUp, BarChart3, ClipboardList, Boxes, X, User, Package } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { formatDuration } from '@/app/lib/logs';
import {
  computeStatpackStats,
  computeUsageOverTime,
  computeItemUsageDetail,
  bucketDatesByRange,
  filterLogsByRange,
  isWithinRange,
  toStatpackLogWithId,
  toStatpackSummary,
  type StatpackLogWithId,
  type StatpackSummaryDoc,
  type StatpackStatsResult,
  type DateRange,
  type ItemUsageDetail,
} from '@/app/lib/statpack-stats';

type Tab = 'statpacks' | 'restock';

// ── Time range presets ───────────────────────────────────────────────────────
type RangePreset = 'all' | 'ytd' | 'year' | '90d' | '30d' | '7d' | 'custom';

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'ytd', label: 'YTD' },
  { key: 'year', label: 'Past year' },
  { key: '90d', label: '90 days' },
  { key: '30d', label: '30 days' },
  { key: '7d', label: '7 days' },
  { key: 'custom', label: 'Custom' },
];

function presetToRange(preset: RangePreset, customStart: string, customEnd: string, now: Date = new Date()): DateRange {
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'ytd':
      return { start: new Date(now.getFullYear(), 0, 1), end: now };
    case 'year':
      return { start: daysAgo(365), end: now };
    case '90d':
      return { start: daysAgo(90), end: now };
    case '30d':
      return { start: daysAgo(30), end: now };
    case '7d':
      return { start: daysAgo(7), end: now };
    case 'custom': {
      const start = customStart ? new Date(`${customStart}T00:00:00`) : null;
      const end = customEnd ? new Date(`${customEnd}T23:59:59.999`) : null;
      return { start, end };
    }
  }
}

function rangeLabel(preset: RangePreset, customStart: string, customEnd: string): string {
  switch (preset) {
    case 'all':
      return 'All time';
    case 'ytd':
      return 'Year to date';
    case 'year':
      return 'Past year';
    case '90d':
      return 'Past 90 days';
    case '30d':
      return 'Past 30 days';
    case '7d':
      return 'Past 7 days';
    case 'custom':
      if (customStart && customEnd) return `${customStart} – ${customEnd}`;
      if (customStart) return `Since ${customStart}`;
      if (customEnd) return `Through ${customEnd}`;
      return 'Custom range';
  }
}

// ── Restock types + helpers (ported from the old /restock-stats page) ────────
type RestockReport = {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { itemId?: string; name?: string; observedQuantity?: number; requiredQuantity?: number }[];
  createdAt?: Timestamp | Date;
  resolved?: boolean;
  resolvedAt?: Timestamp | Date;
};
type RestockAction = {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { name?: string; quantity?: number }[];
  createdAt?: Timestamp | Date;
};

function toDate(v?: Timestamp | Date): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof (v as Timestamp).toDate === 'function') return (v as Timestamp).toDate();
  return null;
}

const EMPTY_STATPACK_STATS: StatpackStatsResult = {
  summary: {
    totalCheckouts: 0,
    totalCheckins: 0,
    avgTurnaroundMs: null,
    totalItemsUsed: 0,
    restockEvents: 0,
    reportedIssues: 0,
    expiredFindings: 0,
  },
  perPack: [],
  mostUsedItems: [],
  usageOverTime: [],
  hasData: false,
};

function formatLastActivity(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StatsPage() {
  const router = useRouter();
  const { role, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [tab, setTab] = useState<Tab>('statpacks');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Time range control
  const [rangePreset, setRangePreset] = useState<RangePreset>('90d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const range = useMemo(
    () => presetToRange(rangePreset, customStart, customEnd),
    [rangePreset, customStart, customEnd]
  );
  const activeRangeLabel = rangeLabel(rangePreset, customStart, customEnd);

  // Statpack data
  const [logs, setLogs] = useState<StatpackLogWithId[]>([]);
  const [packs, setPacks] = useState<StatpackSummaryDoc[]>([]);
  // Restock data
  const [reports, setReports] = useState<RestockReport[]>([]);
  const [actions, setActions] = useState<RestockAction[]>([]);

  // Item usage drill-down
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  // Initial tab from ?tab= (deep links from the old routes / dashboard).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'restock' || t === 'statpacks') setTab(t);
  }, []);

  const selectTab = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, '', `/stats?tab=${next}`);
  };

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [logsSnap, packsSnap, rSnap, aSnap] = await Promise.all([
          getDocs(collection(db, 'statpack_logs')),
          getDocs(collection(db, 'statpacks')),
          getDocs(collection(db, 'restock_reports')),
          getDocs(collection(db, 'restock_actions')),
        ]);
        if (cancelled) return;
        setLogs(logsSnap.docs.map((d) => toStatpackLogWithId(d.id, d.data())));
        setPacks(packsSnap.docs.map((d) => toStatpackSummary(d.id, d.data())));
        setReports(rSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RestockReport, 'id'>) })));
        setActions(aSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RestockAction, 'id'>) })));
      } catch (e) {
        console.error('Failed to load stats', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, refreshKey]);

  const rangedLogs = useMemo(() => filterLogsByRange(logs, range), [logs, range]);

  const statpackStats = useMemo(() => {
    if (!rangedLogs.length) return EMPTY_STATPACK_STATS;
    const stats = computeStatpackStats(rangedLogs, packs);
    return { ...stats, usageOverTime: computeUsageOverTime(rangedLogs, range) };
  }, [rangedLogs, packs, range]);

  const itemUsageDetail: ItemUsageDetail | null = useMemo(() => {
    if (!selectedItem) return null;
    return computeItemUsageDetail(rangedLogs, packs, selectedItem);
  }, [selectedItem, rangedLogs, packs]);

  const reportsInRange = useMemo(
    () => (!range.start && !range.end ? reports : reports.filter((r) => isWithinRange(toDate(r.createdAt), range))),
    [reports, range]
  );
  const actionsInRange = useMemo(
    () => (!range.start && !range.end ? actions : actions.filter((a) => isWithinRange(toDate(a.createdAt), range))),
    [actions, range]
  );

  const restockStats = useMemo(() => {
    const totalReports = reportsInRange.length;
    const openReports = reportsInRange.filter((r) => !r.resolved).length;
    const totalActions = actionsInRange.length;

    const resolveTimes: number[] = [];
    reportsInRange.forEach((r) => {
      const c = toDate(r.createdAt);
      const res = toDate(r.resolvedAt);
      if (c && res) resolveTimes.push((res.getTime() - c.getTime()) / (1000 * 60 * 60));
    });
    const avgResolveHours = resolveTimes.length ? resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length : null;

    const perBox: Record<string, { name: string; count: number }> = {};
    reportsInRange.forEach((r) => {
      const id = r.restockBoxId || 'unknown';
      if (!perBox[id]) perBox[id] = { name: r.restockBoxName || id, count: 0 };
      perBox[id].count++;
    });
    const topBoxes = Object.entries(perBox)
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const perItem: Record<string, { name: string; reported: number }> = {};
    reportsInRange.forEach((r) => {
      (r.items || []).forEach((it) => {
        const key = it.itemId || it.name || 'unknown';
        if (!perItem[key]) perItem[key] = { name: it.name || key, reported: 0 };
        perItem[key].reported += 1;
      });
    });
    const topItems = Object.entries(perItem)
      .map(([id, v]) => ({ id, name: v.name, reported: v.reported }))
      .sort((a, b) => b.reported - a.reported)
      .slice(0, 10);

    const trend = bucketDatesByRange(
      reportsInRange.map((r) => toDate(r.createdAt)),
      range
    );
    const maxTrend = Math.max(1, ...trend.map((t) => t.count));

    return { totalReports, openReports, totalActions, avgResolveHours, topBoxes, topItems, trend, maxTrend };
  }, [reportsInRange, actionsInRange, range]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <Card>
          <CardBody>
            <p className="text-danger">Access denied. Only admins and quartermasters can view statistics.</p>
            <Button color="primary" onPress={() => router.push('/dashboard')} className="mt-4">
              Go to Dashboard
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  const subtitle =
    tab === 'statpacks'
      ? `Usage-rate tracking & paper trail across every pack · ${statpackStats.perPack.length} pack${statpackStats.perPack.length === 1 ? '' : 's'} with activity · ${activeRangeLabel}`
      : `Operational metrics for restocking decisions · ${activeRangeLabel}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Page header */}
        <div className="flex items-end justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Statistics</h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span>{subtitle}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* View toggle */}
            <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
              {([
                { key: 'statpacks' as const, icon: <ClipboardList size={14} />, label: 'Statpacks' },
                { key: 'restock' as const, icon: <Boxes size={14} />, label: 'Restock' },
              ]).map(({ key, icon, label }) => (
                <button
                  key={key}
                  onClick={() => selectTab(key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                    tab === key ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />} onPress={() => setRefreshKey((k) => k + 1)}>
              Refresh
            </Button>
          </div>
        </div>

        {/* Time range control */}
        <div className="flex items-center gap-2 flex-wrap mb-6">
          <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1 flex-wrap">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setRangePreset(p.key)}
                className={`px-2.5 py-1.5 rounded-medium text-xs font-semibold transition-colors duration-150 ${
                  rangePreset === p.key ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {rangePreset === 'custom' && (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="text-xs font-semibold px-2 py-1.5 rounded-lg border border-divider outline-none bg-content1 text-foreground"
              />
              <span className="text-xs text-foreground-400">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="text-xs font-semibold px-2 py-1.5 rounded-lg border border-divider outline-none bg-content1 text-foreground"
              />
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Spinner size="lg" color="primary" />
          </div>
        ) : tab === 'statpacks' ? (
          <StatpackStatsView stats={statpackStats} onSelectItem={setSelectedItem} />
        ) : (
          <RestockStatsView stats={restockStats} rangeLabelText={activeRangeLabel} />
        )}
      </div>

      {selectedItem && (
        <ItemUsageDrawer
          detail={itemUsageDetail}
          rangeLabel={activeRangeLabel}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}

// ── Statpack view ────────────────────────────────────────────────────────────
function StatpackStatsView({
  stats,
  onSelectItem,
}: {
  stats: StatpackStatsResult;
  onSelectItem: (itemName: string) => void;
}) {
  const { summary, perPack, mostUsedItems, usageOverTime } = stats;
  const maxUsedItem = Math.max(1, ...mostUsedItems.map((i) => i.usedCount));
  const maxWeekCheckouts = Math.max(1, ...usageOverTime.map((b) => b.checkouts));

  if (!stats.hasData) {
    return (
      <Card>
        <CardBody className="py-12 text-center">
          <BarChart3 size={28} className="mx-auto text-foreground-400 mb-3" />
          <p className="text-sm font-semibold text-foreground">No statpack activity yet</p>
          <p className="text-xs text-foreground-400 mt-1">Stats appear here once members start checking packs in and out.</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Checkouts" value={summary.totalCheckouts} caption="Total events" />
        <Kpi label="Check-ins" value={summary.totalCheckins} caption="Total events" />
        <Kpi
          label="Avg Turnaround"
          value={summary.avgTurnaroundMs !== null ? formatDuration(summary.avgTurnaroundMs) : '—'}
          caption="Checkout → check-in"
          valueClass="text-primary"
        />
        <Kpi label="Items Used" value={summary.totalItemsUsed} caption="Short at check-in" />
        <Kpi label="Restock Events" value={summary.restockEvents} caption="Resolved at check-in" valueClass="text-success" />
        <Kpi
          label="Reported Issues"
          value={summary.reportedIssues}
          caption="Missing / broken / expired"
          valueClass={summary.reportedIssues > 0 ? 'text-warning' : 'text-success'}
        />
        <Kpi
          label="Expired Findings"
          value={summary.expiredFindings}
          caption="Found expired in pack"
          valueClass={summary.expiredFindings > 0 ? 'text-danger' : 'text-success'}
        />
      </div>

      {/* Most-used items + usage over time */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400 flex items-center gap-2">
            <TrendingUp size={12} /> Most-Used Items
          </div>
          {mostUsedItems.length === 0 ? (
            <div className="px-4 py-6 text-xs text-foreground-400 text-center">No item usage recorded yet</div>
          ) : (
            <div className="p-4 space-y-2.5">
              {mostUsedItems.map((item) => (
                <button
                  key={item.itemName}
                  onClick={() => onSelectItem(item.itemName)}
                  className="w-full flex items-center gap-3 -mx-1 px-1 py-0.5 rounded-medium cursor-pointer hover:bg-content2 transition-colors duration-150 text-left"
                >
                  <span className="text-xs text-foreground-600 w-32 md:w-40 truncate flex-none" title={item.itemName}>
                    {item.itemName}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${(item.usedCount / maxUsedItem) * 100}%` }} />
                  </div>
                  <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-8 text-right flex-none">{item.usedCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400 flex items-center gap-2">
            <BarChart3 size={12} /> Checkouts Over Time
          </div>
          <div className="p-4 space-y-1.5">
            {usageOverTime.map((b) => (
              <div key={b.weekStart.toISOString()} className="flex items-center gap-3">
                <span className="text-xs text-foreground-400 tabular-nums w-16 flex-none">{b.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                  <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${(b.checkouts / maxWeekCheckouts) * 100}%` }} />
                </div>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-6 text-right flex-none">{b.checkouts}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Per-pack table */}
      <div className="bg-content1 border border-divider rounded-large overflow-hidden">
        <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
          Per-Pack Breakdown — sorted by items used
        </div>
        {perPack.length === 0 ? (
          <div className="px-4 py-6 text-xs text-foreground-400 text-center">No pack activity yet</div>
        ) : (
          <div className="overflow-x-auto">
            <div style={{ minWidth: 720 }}>
              <div
                className="grid gap-4 px-4 py-2.5 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400"
                style={{ gridTemplateColumns: '2fr 1fr 1.2fr 1fr 1fr 1fr 1.3fr' }}
              >
                <span>Pack</span>
                <span className="text-right">Checkouts</span>
                <span className="text-right">Avg Turnaround</span>
                <span className="text-right">Items Used</span>
                <span className="text-right">Restocks</span>
                <span className="text-right">Issues</span>
                <span className="text-right">Last Activity</span>
              </div>
              <div className="divide-y divide-divider">
                {perPack.map((p) => (
                  <div key={p.statpackId} className="grid gap-4 px-4 py-2.5" style={{ gridTemplateColumns: '2fr 1fr 1.2fr 1fr 1fr 1fr 1.3fr' }}>
                    <span className="text-sm text-foreground truncate">{p.statpackName}</span>
                    <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">{p.checkouts}</span>
                    <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">
                      {p.avgTurnaroundMs !== null ? formatDuration(p.avgTurnaroundMs) : '—'}
                    </span>
                    <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">{p.itemsUsed}</span>
                    <span className={`font-mono text-sm tabular-nums text-right ${p.restocks > 0 ? 'text-success' : 'text-foreground-500'}`}>{p.restocks}</span>
                    <span className={`font-mono text-sm tabular-nums text-right ${p.issues > 0 ? 'text-warning' : 'text-foreground-500'}`}>{p.issues}</span>
                    <span className="text-xs text-foreground-400 text-right tabular-nums">{formatLastActivity(p.lastActivity)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Restock view ─────────────────────────────────────────────────────────────
function RestockStatsView({
  stats,
  rangeLabelText,
}: {
  stats: {
    totalReports: number;
    openReports: number;
    totalActions: number;
    avgResolveHours: number | null;
    topBoxes: { id: string; name: string; count: number }[];
    topItems: { id: string; name: string; reported: number }[];
    trend: { label: string; bucketStart: Date; count: number }[];
    maxTrend: number;
  };
  rangeLabelText: string;
}) {
  return (
    <>
      {/* Stat counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Total Reports" value={stats.totalReports} caption={rangeLabelText} />
        <Kpi label="Open Reports" value={stats.openReports} caption="Unresolved" valueClass={stats.openReports > 0 ? 'text-warning' : 'text-success'} />
        <Kpi label="Restock Actions" value={stats.totalActions} caption="Manual restocks" valueClass="text-primary" />
        <Kpi
          label="Avg Resolve Time"
          value={stats.avgResolveHours !== null ? `${stats.avgResolveHours.toFixed(1)}h` : '—'}
          caption="Resolved reports"
        />
      </div>

      {/* Breakdown tables */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
            Top Restock Boxes
          </div>
          <div className="divide-y divide-divider">
            {stats.topBoxes.length === 0 ? (
              <div className="px-4 py-6 text-xs text-foreground-400 text-center">No reports in range</div>
            ) : (
              stats.topBoxes.map((b) => (
                <div key={b.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-foreground truncate">{b.name}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-foreground-500">{b.count}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
            Top Reported Items
          </div>
          <div className="divide-y divide-divider">
            {stats.topItems.length === 0 ? (
              <div className="px-4 py-6 text-xs text-foreground-400 text-center">No reports in range</div>
            ) : (
              stats.topItems.map((i) => (
                <div key={i.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-foreground truncate">{i.name}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-foreground-500">{i.reported}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400 flex items-center gap-2">
            <BarChart3 size={12} /> Reports Over Time
          </div>
          <div className="p-4 space-y-1.5">
            {stats.trend.map((t) => (
              <div key={t.bucketStart.toISOString()} className="flex items-center gap-3">
                <span className="text-xs text-foreground-400 tabular-nums w-16 flex-none">{t.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                  <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${(t.count / stats.maxTrend) * 100}%` }} />
                </div>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-6 text-right flex-none">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// Shared KPI counter tile.
function Kpi({
  label,
  value,
  caption,
  valueClass = 'text-foreground',
}: {
  label: string;
  value: React.ReactNode;
  caption: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-content1 border border-divider rounded-large p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">{label}</div>
      <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${valueClass}`}>{value}</div>
      <div className="text-xs text-foreground-400 mt-1">{caption}</div>
    </div>
  );
}

// ── Item usage drill-down drawer ────────────────────────────────────────────
function ItemUsageDrawer({
  detail,
  rangeLabel,
  onClose,
}: {
  detail: ItemUsageDetail | null;
  rangeLabel: string;
  onClose: () => void;
}) {
  const maxMember = Math.max(1, ...(detail?.byMember.map((m) => m.used) ?? [0]));
  const maxPack = Math.max(1, ...(detail?.byPack.map((p) => p.used) ?? [0]));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw] bg-content1 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-[10px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                <Package size={18} />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">
                  {detail?.itemName ?? '—'}
                </div>
                <div className="text-xs text-foreground-500 mt-0.5">
                  Used {detail?.eventCount ?? 0} time{(detail?.eventCount ?? 0) === 1 ? '' : 's'} · {detail?.totalUsed ?? 0} units total · {rangeLabel}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {!detail || detail.events.length === 0 ? (
            <div className="text-xs text-foreground-400 text-center py-8">No usage recorded in this range.</div>
          ) : (
            <>
              {/* By member */}
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2.5">
                  <User size={12} /> By Member
                </div>
                <div className="space-y-2">
                  {detail.byMember.map((m) => (
                    <div key={m.name} className="flex items-center gap-3">
                      <span className="text-xs text-foreground-600 w-28 truncate flex-none" title={m.name}>
                        {m.name}
                      </span>
                      <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${(m.used / maxMember) * 100}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-16 text-right flex-none">
                        {m.used} <span className="text-foreground-400 font-normal">/ {m.times}x</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* By pack */}
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2.5">
                  <Package size={12} /> By Pack
                </div>
                <div className="space-y-2">
                  {detail.byPack.map((p) => (
                    <div key={p.name} className="flex items-center gap-3">
                      <span className="text-xs text-foreground-600 w-28 truncate flex-none" title={p.name}>
                        {p.name}
                      </span>
                      <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${(p.used / maxPack) * 100}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-16 text-right flex-none">
                        {p.used} <span className="text-foreground-400 font-normal">/ {p.times}x</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent events */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2.5">
                  Recent Events
                </div>
                <div className="space-y-2">
                  {detail.events.slice(0, 30).map((e, i) => (
                    <div key={i} className="bg-content2 rounded-large p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground truncate">{e.packName}</span>
                        <span className="text-xs text-foreground-400 tabular-nums flex-none">
                          {e.date ? e.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                        </span>
                      </div>
                      <div className="text-xs text-foreground-500 mt-1">
                        Used <span className="font-mono font-semibold text-foreground-600 tabular-nums">{e.usedQty}</span>
                        {' · '}checked out by {e.checkoutUser ?? '—'}
                        {' · '}checked in by {e.checkinUser}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
