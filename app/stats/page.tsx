'use client';

/**
 * Unified Statistics page — combines Statpack usage stats and Restock stats
 * behind one route with a segmented view toggle. Replaces the separate
 * /statpacks/stats and /restock-stats pages (both now redirect here).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Button, Card, CardBody, Spinner } from '@heroui/react';
import { RefreshCw, TrendingUp, BarChart3, ClipboardList, Boxes } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { formatDuration } from '@/app/lib/logs';
import {
  computeStatpackStats,
  toStatpackLogWithId,
  toStatpackSummary,
  type StatpackLogWithId,
  type StatpackSummaryDoc,
  type StatpackStatsResult,
} from '@/app/lib/statpack-stats';

type Tab = 'statpacks' | 'restock';

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

  // Statpack data
  const [logs, setLogs] = useState<StatpackLogWithId[]>([]);
  const [packs, setPacks] = useState<StatpackSummaryDoc[]>([]);
  // Restock data
  const [reports, setReports] = useState<RestockReport[]>([]);
  const [actions, setActions] = useState<RestockAction[]>([]);

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
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const sinceTs = Timestamp.fromDate(since);
        const [logsSnap, packsSnap, rSnap, aSnap] = await Promise.all([
          getDocs(collection(db, 'statpack_logs')),
          getDocs(collection(db, 'statpacks')),
          getDocs(query(collection(db, 'restock_reports'), where('createdAt', '>=', sinceTs))),
          getDocs(query(collection(db, 'restock_actions'), where('createdAt', '>=', sinceTs))),
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

  const statpackStats = useMemo(
    () => (logs.length ? computeStatpackStats(logs, packs) : EMPTY_STATPACK_STATS),
    [logs, packs]
  );

  const restockStats = useMemo(() => {
    const totalReports = reports.length;
    const openReports = reports.filter((r) => !r.resolved).length;
    const totalActions = actions.length;

    const resolveTimes: number[] = [];
    reports.forEach((r) => {
      const c = toDate(r.createdAt);
      const res = toDate(r.resolvedAt);
      if (c && res) resolveTimes.push((res.getTime() - c.getTime()) / (1000 * 60 * 60));
    });
    const avgResolveHours = resolveTimes.length ? resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length : null;

    const perBox: Record<string, { name: string; count: number }> = {};
    reports.forEach((r) => {
      const id = r.restockBoxId || 'unknown';
      if (!perBox[id]) perBox[id] = { name: r.restockBoxName || id, count: 0 };
      perBox[id].count++;
    });
    const topBoxes = Object.entries(perBox)
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const perItem: Record<string, { name: string; reported: number }> = {};
    reports.forEach((r) => {
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

    const trend: { day: string; count: number }[] = [];
    const dayCounts: Record<string, number> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayCounts[d.toISOString().slice(0, 10)] = 0;
    }
    reports.forEach((r) => {
      const c = toDate(r.createdAt);
      if (!c) return;
      const key = c.toISOString().slice(0, 10);
      if (key in dayCounts) dayCounts[key]++;
    });
    Object.entries(dayCounts).forEach(([day, count]) => trend.push({ day, count }));
    const maxTrend = Math.max(1, ...trend.map((t) => t.count));

    return { totalReports, openReports, totalActions, avgResolveHours, topBoxes, topItems, trend, maxTrend };
  }, [reports, actions]);

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
      ? `Usage-rate tracking & paper trail across every pack · ${statpackStats.perPack.length} pack${statpackStats.perPack.length === 1 ? '' : 's'} with activity`
      : 'Operational metrics for restocking decisions · Last 90 days';

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
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

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Spinner size="lg" color="primary" />
          </div>
        ) : tab === 'statpacks' ? (
          <StatpackStatsView stats={statpackStats} />
        ) : (
          <RestockStatsView stats={restockStats} />
        )}
      </div>
    </div>
  );
}

// ── Statpack view ────────────────────────────────────────────────────────────
function StatpackStatsView({ stats }: { stats: StatpackStatsResult }) {
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
                <div key={item.itemName} className="flex items-center gap-3">
                  <span className="text-xs text-foreground-600 w-32 md:w-40 truncate flex-none" title={item.itemName}>
                    {item.itemName}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${(item.usedCount / maxUsedItem) * 100}%` }} />
                  </div>
                  <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-8 text-right flex-none">{item.usedCount}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-content1 border border-divider rounded-large overflow-hidden">
          <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400 flex items-center gap-2">
            <BarChart3 size={12} /> Checkouts Per Week (12 weeks)
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
}: {
  stats: {
    totalReports: number;
    openReports: number;
    totalActions: number;
    avgResolveHours: number | null;
    topBoxes: { id: string; name: string; count: number }[];
    topItems: { id: string; name: string; reported: number }[];
    trend: { day: string; count: number }[];
    maxTrend: number;
  };
}) {
  return (
    <>
      {/* Stat counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Total Reports" value={stats.totalReports} caption="Last 90 days" />
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
            <BarChart3 size={12} /> 14-Day Trend
          </div>
          <div className="p-4 space-y-1.5">
            {stats.trend.map((t) => (
              <div key={t.day} className="flex items-center gap-3">
                <span className="text-xs text-foreground-400 tabular-nums w-20 flex-none">
                  {new Date(`${t.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
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
