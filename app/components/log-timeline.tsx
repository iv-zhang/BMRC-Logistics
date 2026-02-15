'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { Card, CardBody, CardHeader, Chip, Button, Divider, Spinner, ScrollShadow } from '@heroui/react';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import { db } from '@/firebase';
import type { StatpackLog } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import LogDetailModal from '@/app/components/log-detail-modal';
import type { StatpackLogDisplayItem } from '@/app/lib/logs';
import { getLatestCheckStatus, normalizeTimestamp, pairStatpackLogs } from '@/app/lib/logs';
import { isBrokenTimestamp, repairDocTimestamp } from '@/app/lib/fix-timestamps';

interface LogTimelineProps {
  statpackId: string;
  maxRows?: number;
  onViewAll?: () => void;
}

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

// ---------------------------------------------------------------------------
// Flatten display items to individual log rows so every entry uses the same
// compact single-line format regardless of whether it was paired.
// ---------------------------------------------------------------------------
interface FlatRow {
  key: string;
  log: StatpackLog & { id: string; timestamp: Date | null };
  /** Original display item — passed to the detail modal */
  displayItem: StatpackLogDisplayItem;
}

function flattenDisplayItems(items: StatpackLogDisplayItem[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const item of items) {
    if (item.kind === 'single') {
      rows.push({ key: `s-${item.log.id}`, log: item.log, displayItem: item });
    } else {
      // "pair" — emit a row for each present leg (checkout first, then checkin)
      if (item.checkout) {
        rows.push({ key: `p-co-${item.checkout.id}`, log: item.checkout, displayItem: item });
      }
      if (item.checkin) {
        rows.push({ key: `p-ci-${item.checkin.id}`, log: item.checkin, displayItem: item });
      }
    }
  }
  // Sort newest first by timestamp (nulls last)
  rows.sort((a, b) => {
    const ta = a.log.timestamp?.getTime() ?? 0;
    const tb = b.log.timestamp?.getTime() ?? 0;
    return tb - ta;
  });
  return rows;
}

export default function LogTimeline({ statpackId, maxRows = 8, onViewAll }: LogTimelineProps) {
  type LogWithTimestamp = StatpackLog & { id: string; timestamp: Date | null };
  const [logs, setLogs] = useState<LogWithTimestamp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<StatpackLogDisplayItem | null>(null);

  useEffect(() => {
    if (!statpackId) return;

    const q = query(
      collection(db, 'statpack_logs'),
      where('statpackId', '==', statpackId)
    );

    const unsub = onSnapshot(q, (snap) => {
      const raw: LogWithTimestamp[] = snap.docs.map((d) => {
        const data = d.data();
        if (isBrokenTimestamp(data.timestamp)) {
          repairDocTimestamp(d.ref);
        }
        return {
          ...data,
          id: d.id,
          timestamp: normalizeTimestamp(data.timestamp, data.clientTimestamp),
        } as LogWithTimestamp;
      });
      raw.sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
      setLogs(raw);
      setError(null);
      setLoading(false);
    }, (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to load log timeline';
      setError(msg);
      setLoading(false);
    });

    return () => unsub();
  }, [statpackId, maxRows]);

  const displayItems = useMemo(() => pairStatpackLogs(logs), [logs]);

  const flatRows = useMemo(() => {
    const all = flattenDisplayItems(displayItems);
    return all.slice(0, maxRows);
  }, [displayItems, maxRows]);

  const { lastCheckout, lastCheckin, isOut } = useMemo(() => getLatestCheckStatus(logs), [logs]);
  const headerTime = useMemo(() => {
    if (lastCheckin) return lastCheckin;
    if (lastCheckout) return lastCheckout;
    return flatRows[0]?.log.timestamp ?? null;
  }, [lastCheckin, lastCheckout, flatRows]);

  const openDetails = (item: StatpackLogDisplayItem) => {
    setSelectedItem(item);
    setDetailOpen(true);
  };

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
    <>
      <Card className="border border-default-200 bg-default-100">
        <CardHeader className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-default-700">Recent activity</span>
            <Chip size="sm" variant="flat" color={isOut ? 'warning' : 'success'}>
              {isOut ? `Checked out ${formatRelative(headerTime)}` : `Checked in ${formatRelative(headerTime)}`}
            </Chip>
          </div>
          {onViewAll && (
            <Button size="sm" variant="light" onPress={onViewAll}>
              View all
            </Button>
          )}
        </CardHeader>
        <Divider />
        <CardBody className="p-0">
          <ScrollShadow className="max-h-[280px] overflow-y-auto px-3 py-2 space-y-1.5">
            {flatRows.length === 0 && (
              <p className="text-xs text-default-500 text-center py-2">No recent activity yet.</p>
            )}
            {flatRows.map((row) => {
              const { log, displayItem } = row;
              const meta = getActionMeta(log.action);
              const Icon = meta.icon;
              const entries = log.checkEntries || [];
              const okCount = entries.filter((e) => e.ok).length;
              const total = entries.length;
              const missing = Math.max(total - okCount, 0);
              const warnings = (log.validationWarnings || []).filter((w) => w.severity !== 'info');
              const isQuick = !!(log as unknown as Record<string, unknown>).quickCheckin;

              return (
                <div
                  key={row.key}
                  className="rounded-md border border-default-200 bg-default-200 px-2.5 py-1.5 flex items-start gap-2 cursor-pointer hover:bg-default-300 transition-colors"
                  onClick={isAdmin ? () => openDetails(displayItem) : undefined}
                  role={isAdmin ? 'button' : undefined}
                  tabIndex={isAdmin ? 0 : undefined}
                >
                  {/* Icon badge */}
                  <span className={`mt-0.5 shrink-0 rounded-full p-1 ${meta.badgeClass}`}>
                    <Icon size={13} />
                  </span>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Chip size="sm" variant="flat" color={meta.color} className="capitalize">
                        {log.action === 'checkin' ? 'Check-in' : log.action === 'checkout' ? 'Check-out' : log.action.replace(/_/g, ' ')}
                      </Chip>
                      {isQuick && (
                        <Chip size="sm" variant="flat" color="warning">⚡</Chip>
                      )}
                      <span className="text-xs text-default-600 truncate">{log.userName || 'Unknown'}</span>
                      {total > 0 && (
                        <Chip size="sm" variant="flat" color={missing > 0 ? 'warning' : 'success'}>
                          {okCount}/{total}
                        </Chip>
                      )}
                      {warnings.length > 0 && (
                        <Chip size="sm" variant="flat" color="danger">
                          {warnings.length} ⚠
                        </Chip>
                      )}
                    </div>
                    {log.notes && (
                      <p className="mt-0.5 text-[11px] text-default-500 italic truncate">
                        &ldquo;{log.notes}&rdquo;
                      </p>
                    )}
                  </div>

                  {/* Timestamp — right-aligned */}
                  <span className="shrink-0 text-[11px] text-default-500 whitespace-nowrap mt-0.5">
                    {formatTimestamp(log.timestamp)}
                  </span>
                </div>
              );
            })}
          </ScrollShadow>
        </CardBody>
      </Card>
      <LogDetailModal isOpen={detailOpen} onOpenChange={setDetailOpen} item={selectedItem} />
    </>
  );
}
