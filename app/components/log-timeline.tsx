'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { collection, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { Card, CardBody, CardHeader, Chip, Button, Divider, Spinner } from '@heroui/react';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import { db } from '@/firebase';
import type { StatpackLog } from '@/app/types';

interface LogTimelineProps {
  statpackId: string;
  maxRows?: number;
  onViewAll?: () => void;
}

const normalizeTimestamp = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  const obj = value as { toDate?: () => Date };
  if (typeof obj.toDate === 'function') return obj.toDate();
  return null;
};

const formatTimestamp = (date: Date | null) => {
  if (!date) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

const formatRelative = (date: Date | null) => {
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const getActionMeta = (action: string) => {
  if (action === 'checkout') return { color: 'warning' as const, icon: ArrowUpRight, badgeClass: 'bg-amber-100 text-amber-700' };
  if (action === 'checkin') return { color: 'success' as const, icon: ArrowDownLeft, badgeClass: 'bg-emerald-100 text-emerald-700' };
  if (action === 'maintenance') return { color: 'secondary' as const, icon: Clock, badgeClass: 'bg-purple-100 text-purple-700' };
  if (action === 'restock') return { color: 'primary' as const, icon: CheckCircle2, badgeClass: 'bg-sky-100 text-sky-700' };
  return { color: 'default' as const, icon: ShieldAlert, badgeClass: 'bg-slate-100 text-slate-600' };
};

export default function LogTimeline({ statpackId, maxRows = 4, onViewAll }: LogTimelineProps) {
  const [logs, setLogs] = useState<(StatpackLog & { id: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!statpackId) return;

    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const q = query(
          collection(db, 'statpack_logs'),
          where('statpackId', '==', statpackId),
          orderBy('timestamp', 'desc')
        );
        const snap = await getDocs(q);
        const raw = snap.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            timestamp: normalizeTimestamp(data.timestamp) || new Date(),
          } as StatpackLog & { id: string };
        });
        const limited = raw.slice(0, maxRows);
        if (mounted) {
          setLogs(limited);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          const msg = err instanceof Error ? err.message : 'Failed to load log timeline';
          setError(msg);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [statpackId, maxRows]);

  const { lastCheckout, lastCheckin, isOut } = useMemo(() => {
    const lastCheckout = logs.find((log) => log.action === 'checkout');
    const lastCheckin = logs.find((log) => log.action === 'checkin');
    const checkoutTs = normalizeTimestamp(lastCheckout?.timestamp);
    const checkinTs = normalizeTimestamp(lastCheckin?.timestamp);
    const isOut = !!checkoutTs && (!checkinTs || checkoutTs.getTime() > checkinTs.getTime());
    return { lastCheckout: checkoutTs, lastCheckin: checkinTs, isOut };
  }, [logs]);

  if (!statpackId) {
    return (
      <Card className="border border-default-200">
        <CardBody>
          <p className="text-xs text-default-500">Activity unavailable.</p>
        </CardBody>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="border border-default-200">
        <CardBody className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border border-danger-200 bg-danger-50">
        <CardBody>
          <p className="text-xs text-danger-600">{error}</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="border border-default-200 bg-default-100">
      <CardHeader className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-default-700">Recent activity</span>
          <Chip size="sm" variant="flat" color={isOut ? 'warning' : 'success'}>
            {isOut ? `Checked out ${formatRelative(lastCheckout)}` : `Ready ${formatRelative(lastCheckin)}`}
          </Chip>
        </div>
        {onViewAll && (
          <Button size="sm" variant="light" onPress={onViewAll}>
            View all
          </Button>
        )}
      </CardHeader>
      <Divider />
      <CardBody className="space-y-2">
        {logs.length === 0 && (
          <p className="text-xs text-default-500 text-center py-2">No recent activity yet.</p>
        )}
        {logs.map((log) => {
          const meta = getActionMeta(log.action);
          const Icon = meta.icon;
          const entries = log.checkEntries || [];
          const okCount = entries.filter((e) => e.ok).length;
          const total = entries.length;
          const missing = Math.max(total - okCount, 0);
          return (
            <div key={log.id} className="rounded-md border border-default-200 bg-default-200 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full p-1 ${meta.badgeClass}`}>
                    <Icon size={14} />
                  </span>
                  <Chip size="sm" variant="flat" color={meta.color} className="capitalize">
                    {log.action.replace(/_/g, ' ')}
                  </Chip>
                  <span className="text-xs text-default-600">{log.userName || 'Unknown'}</span>
                </div>
                <span className="text-[11px] text-default-500">{formatTimestamp(normalizeTimestamp(log.timestamp))}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-default-500">
                {total > 0 && (
                  <Chip size="sm" variant="flat" color={missing > 0 ? 'warning' : 'success'}>
                    {okCount}/{total} OK
                  </Chip>
                )}
                {(log.validationWarnings || []).length > 0 && (
                  <Chip size="sm" variant="flat" color="danger">
                    {(log.validationWarnings || []).length} warnings
                  </Chip>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
