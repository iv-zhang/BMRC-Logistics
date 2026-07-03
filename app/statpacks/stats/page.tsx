'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import { Button, Card, CardBody, Spinner } from '@heroui/react';
import { RefreshCw, TrendingUp, BarChart3 } from 'lucide-react';
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

const EMPTY_STATS: StatpackStatsResult = {
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

export default function StatpackStatsPage() {
  const router = useRouter();
  const { role, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [logs, setLogs] = useState<StatpackLogWithId[]>([]);
  const [packs, setPacks] = useState<StatpackSummaryDoc[]>([]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [logsSnap, packsSnap] = await Promise.all([
          getDocs(collection(db, 'statpack_logs')),
          getDocs(collection(db, 'statpacks')),
        ]);
        if (cancelled) return;
        setLogs(logsSnap.docs.map((d) => toStatpackLogWithId(d.id, d.data())));
        setPacks(packsSnap.docs.map((d) => toStatpackSummary(d.id, d.data())));
      } catch (e) {
        console.error('Failed to load statpack stats', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, refreshKey]);

  const stats = useMemo(() => (logs.length ? computeStatpackStats(logs, packs) : EMPTY_STATS), [logs, packs]);
  const { summary, perPack, mostUsedItems, usageOverTime } = stats;

  const maxUsedItem = Math.max(1, ...mostUsedItems.map((i) => i.usedCount));
  const maxWeekCheckouts = Math.max(1, ...usageOverTime.map((b) => b.checkouts));

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
            <p className="text-danger">Access denied. Only admins and quartermasters can view statpack stats.</p>
            <Button color="primary" onPress={() => router.push('/dashboard')} className="mt-4">
              Go to Dashboard
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* Page header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Statpack Usage Stats</h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span>Usage-rate tracking &amp; paper trail across every pack</span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span>All-time, from {perPack.length} pack{perPack.length === 1 ? '' : 's'} with activity</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<RefreshCw size={14} />}
            onPress={() => setRefreshKey((k) => k + 1)}
          >
            Refresh
          </Button>
        </div>

        {!stats.hasData ? (
          <Card>
            <CardBody className="py-12 text-center">
              <BarChart3 size={28} className="mx-auto text-foreground-400 mb-3" />
              <p className="text-sm font-semibold text-foreground">No statpack activity yet</p>
              <p className="text-xs text-foreground-400 mt-1">
                Stats appear here once members start checking packs in and out.
              </p>
            </CardBody>
          </Card>
        ) : (
          <>
            {/* KPI grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Checkouts</div>
                <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
                  {summary.totalCheckouts}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Total events</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Check-ins</div>
                <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
                  {summary.totalCheckins}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Total events</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Avg Turnaround</div>
                <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-primary">
                  {summary.avgTurnaroundMs !== null ? formatDuration(summary.avgTurnaroundMs) : '—'}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Checkout → check-in</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Items Used</div>
                <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
                  {summary.totalItemsUsed}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Short at check-in</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Restock Events</div>
                <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-success">
                  {summary.restockEvents}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Resolved at check-in</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Reported Issues</div>
                <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${summary.reportedIssues > 0 ? 'text-warning' : 'text-success'}`}>
                  {summary.reportedIssues}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Missing / broken / expired</div>
              </div>
              <div className="bg-content1 border border-divider rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Expired Findings</div>
                <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${summary.expiredFindings > 0 ? 'text-danger' : 'text-success'}`}>
                  {summary.expiredFindings}
                </div>
                <div className="text-xs text-foreground-400 mt-1">Found expired in pack</div>
              </div>
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
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-300"
                            style={{ width: `${(item.usedCount / maxUsedItem) * 100}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-8 text-right flex-none">
                          {item.usedCount}
                        </span>
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
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${(b.checkouts / maxWeekCheckouts) * 100}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-6 text-right flex-none">
                        {b.checkouts}
                      </span>
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
                        <div
                          key={p.statpackId}
                          className="grid gap-4 px-4 py-2.5"
                          style={{ gridTemplateColumns: '2fr 1fr 1.2fr 1fr 1fr 1fr 1.3fr' }}
                        >
                          <span className="text-sm text-foreground truncate">{p.statpackName}</span>
                          <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">{p.checkouts}</span>
                          <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">
                            {p.avgTurnaroundMs !== null ? formatDuration(p.avgTurnaroundMs) : '—'}
                          </span>
                          <span className="font-mono text-sm tabular-nums text-foreground-500 text-right">{p.itemsUsed}</span>
                          <span className={`font-mono text-sm tabular-nums text-right ${p.restocks > 0 ? 'text-success' : 'text-foreground-500'}`}>
                            {p.restocks}
                          </span>
                          <span className={`font-mono text-sm tabular-nums text-right ${p.issues > 0 ? 'text-warning' : 'text-foreground-500'}`}>
                            {p.issues}
                          </span>
                          <span className="text-xs text-foreground-400 text-right tabular-nums">{formatLastActivity(p.lastActivity)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
