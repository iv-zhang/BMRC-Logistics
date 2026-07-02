"use client"

import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Button, Spinner } from '@heroui/react';
import { RefreshCw, BarChart3 } from 'lucide-react';

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

export default function RestockStatsPage() {
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reports, setReports] = useState<RestockReport[]>([]);
  const [actions, setActions] = useState<RestockAction[]>([]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const sinceTs = Timestamp.fromDate(since);

        const rptQ = query(collection(db, 'restock_reports'), where('createdAt', '>=', sinceTs));
        const actQ = query(collection(db, 'restock_actions'), where('createdAt', '>=', sinceTs));

        const [rSnap, aSnap] = await Promise.all([getDocs(rptQ), getDocs(actQ)]);

        setReports(rSnap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<RestockReport, 'id'>) })));
        setActions(aSnap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<RestockAction, 'id'>) })));
      } catch (e) {
        console.error('Failed to load stats', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [refreshKey]);

  const stats = useMemo(() => {
    const totalReports = reports.length;
    const openReports = reports.filter(r => !r.resolved).length;
    const totalActions = actions.length;

    const resolveTimes: number[] = [];
    reports.forEach(r => {
      const c = toDate(r.createdAt);
      const res = toDate(r.resolvedAt);
      if (c && res) resolveTimes.push((res.getTime() - c.getTime()) / (1000 * 60 * 60));
    });
    const avgResolveHours = resolveTimes.length ? (resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length) : null;

    const perBox: Record<string, { name: string; count: number }> = {};
    reports.forEach(r => {
      const id = r.restockBoxId || 'unknown';
      if (!perBox[id]) perBox[id] = { name: r.restockBoxName || id, count: 0 };
      perBox[id].count++;
    });
    const topBoxes = Object.entries(perBox).map(([id, v]) => ({ id, name: v.name, count: v.count })).sort((a, b) => b.count - a.count).slice(0, 10);

    const perItem: Record<string, { name: string; reported: number }> = {};
    reports.forEach(r => {
      (r.items || []).forEach(it => {
        const key = it.itemId || it.name || 'unknown';
        if (!perItem[key]) perItem[key] = { name: it.name || key, reported: 0 };
        perItem[key].reported += 1;
      });
    });
    const topItems = Object.entries(perItem).map(([id, v]) => ({ id, name: v.name, reported: v.reported })).sort((a, b) => b.reported - a.reported).slice(0, 10);

    const trend: { day: string; count: number }[] = [];
    const dayCounts: Record<string, number> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayCounts[key] = 0;
    }
    reports.forEach(r => {
      const c = toDate(r.createdAt);
      if (!c) return;
      const key = c.toISOString().slice(0, 10);
      if (key in dayCounts) dayCounts[key]++;
    });
    Object.entries(dayCounts).forEach(([day, count]) => trend.push({ day, count }));
    const maxTrend = Math.max(1, ...trend.map(t => t.count));

    return { totalReports, openReports, totalActions, avgResolveHours, topBoxes, topItems, trend, maxTrend };
  }, [reports, actions]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Restock Statistics</h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span>Operational metrics for restocking decisions</span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span>Last 90 days</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<RefreshCw size={14} />}
            onPress={() => setRefreshKey(k => k + 1)}
          >
            Refresh
          </Button>
        </div>

        {/* ── Stat counters ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-content1 border border-divider rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Total Reports</div>
            <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
              {stats.totalReports}
            </div>
            <div className="text-xs text-foreground-400 mt-1">Last 90 days</div>
          </div>
          <div className="bg-content1 border border-divider rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Open Reports</div>
            <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${stats.openReports > 0 ? 'text-warning' : 'text-success'}`}>
              {stats.openReports}
            </div>
            <div className="text-xs text-foreground-400 mt-1">Unresolved</div>
          </div>
          <div className="bg-content1 border border-divider rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Restock Actions</div>
            <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-primary">
              {stats.totalActions}
            </div>
            <div className="text-xs text-foreground-400 mt-1">Manual restocks</div>
          </div>
          <div className="bg-content1 border border-divider rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Avg Resolve Time</div>
            <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
              {stats.avgResolveHours !== null ? stats.avgResolveHours.toFixed(1) : '—'}
              {stats.avgResolveHours !== null && <span className="text-sm text-foreground-400 font-normal ml-1">h</span>}
            </div>
            <div className="text-xs text-foreground-400 mt-1">Resolved reports</div>
          </div>
        </div>

        {/* ── Breakdown tables ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-content1 border border-divider rounded-large overflow-hidden">
            <div className="px-4 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
              Top Restock Boxes
            </div>
            <div className="divide-y divide-divider">
              {stats.topBoxes.length === 0 ? (
                <div className="px-4 py-6 text-xs text-foreground-400 text-center">No reports in range</div>
              ) : (
                stats.topBoxes.map(b => (
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
                stats.topItems.map(i => (
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
              {stats.trend.map(t => (
                <div key={t.day} className="flex items-center gap-3">
                  <span className="text-xs text-foreground-400 tabular-nums w-20 flex-none">
                    {new Date(`${t.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-content3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${(t.count / stats.maxTrend) * 100}%` }}
                    />
                  </div>
                  <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 w-6 text-right flex-none">
                    {t.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
