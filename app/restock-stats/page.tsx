"use client"

import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Spinner,
  Divider,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableColumn,
  Button
} from '@heroui/react';

type RestockReport = {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { itemId?: string; name?: string; observedQuantity?: number; requiredQuantity?: number }[];
  createdAt?: any;
  resolved?: boolean;
  resolvedAt?: any;
};

type RestockAction = {
  id?: string;
  restockBoxId?: string;
  restockBoxName?: string;
  items?: { name?: string; quantity?: number }[];
  createdAt?: any;
};

export default function RestockStatsPage() {
  const [loading, setLoading] = useState(true);
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

        const r: RestockReport[] = rSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        const a: RestockAction[] = aSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

        setReports(r);
        setActions(a);
      } catch (e) {
        console.error('Failed to load stats', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const stats = useMemo(() => {
    const totalReports = reports.length;
    const openReports = reports.filter(r => !r.resolved).length;
    const totalActions = actions.length;

    const resolveTimes: number[] = [];
    reports.forEach(r => {
      const c = r.createdAt && typeof r.createdAt.toDate === 'function' ? r.createdAt.toDate() : r.createdAt instanceof Date ? r.createdAt : null;
      const res = r.resolvedAt && typeof r.resolvedAt.toDate === 'function' ? r.resolvedAt.toDate() : r.resolvedAt instanceof Date ? r.resolvedAt : null;
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
      const c = r.createdAt && typeof r.createdAt.toDate === 'function' ? r.createdAt.toDate() : r.createdAt instanceof Date ? r.createdAt : null;
      if (!c) return;
      const key = c.toISOString().slice(0, 10);
      if (key in dayCounts) dayCounts[key]++;
    });
    Object.entries(dayCounts).forEach(([day, count]) => trend.push({ day, count }));

    return { totalReports, openReports, totalActions, avgResolveHours, topBoxes, topItems, trend };
  }, [reports, actions]);

  if (loading) return <div className="h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">Restock Statistics</h1>
            <p className="text-sm text-gray-500">Operational metrics for restocking decisions.</p>
          </div>
          <div>
            <Button color="primary" onPress={() => window.location.reload()}>Refresh</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader>Total Reports</CardHeader>
            <CardBody><div className="text-2xl font-bold">{stats.totalReports}</div><div className="text-xs">Last 90 days</div></CardBody>
          </Card>
          <Card>
            <CardHeader>Open Reports</CardHeader>
            <CardBody><div className="text-2xl font-bold">{stats.openReports}</div><div className="text-xs">Unresolved</div></CardBody>
          </Card>
          <Card>
            <CardHeader>Restock Actions</CardHeader>
            <CardBody><div className="text-2xl font-bold">{stats.totalActions}</div><div className="text-xs">Manual restocks</div></CardBody>
          </Card>
          <Card>
            <CardHeader>Avg Resolve Time</CardHeader>
            <CardBody><div className="text-2xl font-bold">{stats.avgResolveHours ? `${stats.avgResolveHours.toFixed(1)} h` : '—'}</div><div className="text-xs">Resolved reports</div></CardBody>
          </Card>
        </div>

        <Divider />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card>
            <CardHeader>Top Restock Boxes</CardHeader>
            <CardBody>
              <Table removeWrapper>
                <TableHeader><TableColumn>Box</TableColumn><TableColumn>Reports</TableColumn></TableHeader>
                <TableBody>
                  {stats.topBoxes.map(b => (
                    <TableRow key={b.id}><TableCell>{b.name}</TableCell><TableCell>{b.count}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>Top Reported Items</CardHeader>
            <CardBody>
              <Table removeWrapper>
                <TableHeader><TableColumn>Item</TableColumn><TableColumn>Reports</TableColumn></TableHeader>
                <TableBody>
                  {stats.topItems.map(i => (
                    <TableRow key={i.id}><TableCell>{i.name}</TableCell><TableCell>{i.reported}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>14-day Trend</CardHeader>
            <CardBody>
              <div className="space-y-2">
                {stats.trend.map(t => (
                  <div key={t.day} className="flex justify-between text-sm"><div className="text-gray-600">{t.day}</div><div className="font-semibold">{t.count}</div></div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
