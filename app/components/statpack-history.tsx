'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { collection, query, where, orderBy, onSnapshot, limit } from 'firebase/firestore';
import { db } from '@/firebase';
import { Card, CardBody, CardHeader, Chip, Spinner, Button, Divider } from '@heroui/react';
import type { StatpackLog, StatpackPocket } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import LogDetailModal from '@/app/components/log-detail-modal';
import type { StatpackLogDisplayItem } from '@/app/lib/logs';
import { formatDuration, normalizeTimestamp, pairStatpackLogs } from '@/app/lib/logs';
import { isBrokenTimestamp, repairDocTimestamp } from '@/app/lib/fix-timestamps';

interface StatpackHistoryProps {
  statpackId: string;
  maxRows?: number;
}

const pocketLabel = (pocket?: StatpackPocket | string) => {
  if (!pocket) return 'unknown';
  return String(pocket).replace('_', ' ');
};

const formatTimestamp = (date: Date | null) => {
  if (!date) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

export default function StatpackHistory({ statpackId, maxRows = 12 }: StatpackHistoryProps) {
  type LogWithTimestamp = StatpackLog & { id: string; timestamp: Date | null };
  const [logs, setLogs] = useState<LogWithTimestamp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<StatpackLogDisplayItem | null>(null);

  useEffect(() => {
    if (!statpackId) return;

    const fetchLimit = Math.max(maxRows + 10, 24);
    const q = query(
      collection(db, 'statpack_logs'),
      where('statpackId', '==', statpackId),
      orderBy('timestamp', 'desc'),
      limit(fetchLimit)
    );

    const unsub = onSnapshot(q, (snap) => {
      const raw: LogWithTimestamp[] = snap.docs.map((d) => {
        const data = d.data();
        // Auto-repair broken serverTimestamp() sentinels in the background
        if (isBrokenTimestamp(data.timestamp)) {
          repairDocTimestamp(d.ref);
        }
        return {
          ...data,
          id: d.id,
          timestamp: normalizeTimestamp(data.timestamp, data.clientTimestamp),
        } as LogWithTimestamp;
      });
      setLogs(raw);
      setError(null);
      setLoading(false);
    }, (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to load statpack history';
      setError(msg);
      setLoading(false);
    });

    return () => unsub();
  }, [statpackId, maxRows]);

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const displayItems = useMemo(() => pairStatpackLogs(logs).slice(0, maxRows), [logs, maxRows]);

  const openDetails = (item: StatpackLogDisplayItem) => {
    setSelectedItem(item);
    setDetailOpen(true);
  };

  const getActionColor = (action: string) => {
    if (action === 'checkout') return 'warning';
    if (action === 'checkin') return 'success';
    if (action === 'maintenance') return 'secondary';
    if (action === 'restock') return 'primary';
    return 'default';
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="flex items-center justify-center py-6">
          <Spinner size="sm" />
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-red-50">
        <CardBody>
          <p className="text-red-700 text-sm">{error}</p>
        </CardBody>
      </Card>
    );
  }

  if (displayItems.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-gray-500 text-sm text-center py-4">No statpack history yet</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex justify-between items-center bg-default-50 px-4 py-3 border-b border-default-200">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Statpack Activity ({displayItems.length})</h3>
      </CardHeader>
      <CardBody className="space-y-3">
        {displayItems.map((item) => {
          const key = item.kind === 'pair' ? `pair-${item.pairId}` : `log-${item.log.id}`;
          const checkout = item.kind === 'pair' ? item.checkout : undefined;
          const checkin = item.kind === 'pair' ? item.checkin : undefined;
          const log = item.kind === 'single' ? item.log : undefined;
          const activeLogs = item.kind === 'single' ? [item.log] : [checkout, checkin].filter(Boolean);

          const summary = (entryLog?: StatpackLog) => {
            const entries = entryLog?.checkEntries || [];
            const total = entries.length;
            const okCount = entries.filter((e) => e.ok).length;
            const missing = Math.max(total - okCount, 0);
            return { total, okCount, missing };
          };

          const combinedWarnings = activeLogs.reduce((acc, l) => acc + ((l?.validationWarnings || []).filter(w => w.severity !== 'info').length), 0);
          const combinedSeals = activeLogs.reduce((acc, l) => acc + (l?.issues?.sealChecks ? Object.keys(l.issues.sealChecks).length : 0), 0);
          const combinedO2 = activeLogs.reduce((acc, l) => acc + (l?.issues?.oxygenReadings ? Object.keys(l.issues.oxygenReadings).length : 0), 0);
          const duration = checkout && checkin && checkout.timestamp && checkin.timestamp
            ? formatDuration(checkin.timestamp.getTime() - checkout.timestamp.getTime())
            : null;
          const isQuickCheckin = checkin ? !!(checkin as unknown as Record<string, unknown>).quickCheckin : (log ? !!(log as unknown as Record<string, unknown>).quickCheckin : false);
          const eventName = checkout?.eventName || checkin?.eventName || log?.eventName;

          return (
            <Card key={key} className="border border-default-200">
              <CardBody className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {item.kind === 'pair' ? (
                      <>
                        <Chip size="sm" variant="solid" color={checkin ? 'success' : 'warning'}>
                          {checkin ? 'Check-in' : 'Check-out'}
                        </Chip>
                        {isQuickCheckin && (
                          <Chip size="sm" variant="flat" color="warning">⚡ Quick</Chip>
                        )}
                        <span className="text-xs text-default-500">{duration ? `Duration: ${duration}` : 'Open checkout'}</span>
                      </>
                    ) : (
                      <>
                        <Chip size="sm" variant="solid" color={getActionColor(log?.action || '')} className="capitalize">
                          {log?.action === 'checkin' ? 'Check-in' : log?.action === 'checkout' ? 'Check-out' : log?.action?.replace(/_/g, ' ') || 'log'}
                        </Chip>
                        {isQuickCheckin && (
                          <Chip size="sm" variant="flat" color="warning">⚡ Quick</Chip>
                        )}
                      </>
                    )}
                    <span className="text-sm text-default-600">
                      {item.kind === 'pair'
                        ? `${checkout?.userName || 'Unknown'} → ${checkin?.userName || 'Pending'}`
                        : log?.userName || 'Unknown'}
                    </span>
                    <span className="text-xs text-default-500">
                      {item.kind === 'pair'
                        ? formatTimestamp(checkin?.timestamp ?? checkout?.timestamp ?? null)
                        : formatTimestamp(log?.timestamp ?? null)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="bordered" onPress={() => toggle(key)}>
                      {expanded[key] ? 'Hide details' : 'Details'}
                    </Button>
                    {isAdmin && (
                      <Button size="sm" variant="light" onPress={() => openDetails(item)}>
                        View log
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-default-600">
                  {item.kind === 'pair' ? (
                    <>
                      {checkout && (() => {
                        const s = summary(checkout);
                        return s.total > 0 ? (
                          <Chip size="sm" variant="flat" color={s.missing > 0 ? 'warning' : 'success'}>
                            Checkout {s.okCount}/{s.total} OK
                          </Chip>
                        ) : null;
                      })()}
                      {checkin && (() => {
                        const s = summary(checkin);
                        return s.total > 0 ? (
                          <Chip size="sm" variant="flat" color={s.missing > 0 ? 'warning' : 'success'}>
                            Check-in {s.okCount}/{s.total} OK
                          </Chip>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    (() => {
                      const s = summary(log);
                      return s.total > 0 ? (
                        <Chip size="sm" variant="flat" color={s.missing > 0 ? 'warning' : 'success'}>
                          {s.okCount}/{s.total} OK
                        </Chip>
                      ) : null;
                    })()
                  )}
                  {combinedWarnings > 0 && (
                    <Chip size="sm" variant="flat" color="danger">
                      {combinedWarnings} warnings
                    </Chip>
                  )}
                  {combinedSeals > 0 && (
                    <Chip size="sm" variant="flat" color="secondary">
                      {combinedSeals} seals
                    </Chip>
                  )}
                  {combinedO2 > 0 && (
                    <Chip size="sm" variant="flat" color="secondary">
                      {combinedO2} O2 readings
                    </Chip>
                  )}
                  {eventName && (
                    <Chip size="sm" variant="flat" color="primary">
                      Event: {eventName}
                    </Chip>
                  )}
                </div>

                {/* Show notes/comments in collapsed view for quick visibility */}
                {item.kind === 'pair' && (checkout?.notes || checkin?.notes) && (
                  <div className="space-y-1 mt-1">
                    {checkout?.notes && (
                      <p className="text-xs text-default-600 italic line-clamp-2">
                        <span className="font-medium not-italic text-default-500">Checkout:</span> &ldquo;{checkout.notes}&rdquo;
                      </p>
                    )}
                    {checkin?.notes && (
                      <p className="text-xs text-default-600 italic line-clamp-2">
                        <span className="font-medium not-italic text-default-500">Check-in:</span> &ldquo;{checkin.notes}&rdquo;
                      </p>
                    )}
                  </div>
                )}
                {item.kind === 'single' && log?.notes && (
                  <p className="text-xs text-default-600 italic mt-1 line-clamp-2">
                    &ldquo;{log.notes}&rdquo;
                  </p>
                )}

                {expanded[key] && (
                  <div className="pt-2 space-y-3">
                    {item.kind === 'pair' && (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded border border-default-200 bg-default-50 p-2">
                          <div className="text-xs font-semibold text-default-700">Checkout</div>
                          <div className="text-xs text-default-500">{checkout?.userName || '—'}</div>
                          {checkout?.notes && <p className="text-xs text-default-600 mt-2">Notes: {checkout.notes}</p>}
                        </div>
                        <div className="rounded border border-default-200 bg-default-50 p-2">
                          <div className="text-xs font-semibold text-default-700">Check-in</div>
                          <div className="text-xs text-default-500">{checkin?.userName || 'Pending'}</div>
                          {checkin?.notes && <p className="text-xs text-default-600 mt-2">Notes: {checkin.notes}</p>}
                        </div>
                      </div>
                    )}

                    {item.kind === 'single' && log?.notes && (
                      <p className="text-sm text-default-600">Notes: {log.notes}</p>
                    )}

                    {activeLogs.some((l) => (l?.validationWarnings || []).filter(w => w.severity !== 'info').length > 0) && (
                      <div>
                        <p className="text-xs font-semibold text-danger">Validation Warnings</p>
                        <div className="text-xs text-danger space-y-1">
                          {activeLogs.flatMap((l, idx) =>
                            (l?.validationWarnings || []).filter(w => w.severity !== 'info').map((w, wIdx) => (
                              <div key={`${key}-warn-${idx}-${wIdx}`}>
                                <div className="font-semibold">{w.itemName || w.itemId || 'Unknown Item'}</div>
                                <div>{w.message}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}

                    {activeLogs.some((l) => l?.checkEntries && l.checkEntries.length > 0) && (
                      <>
                        <Divider className="my-2" />
                        <div className="space-y-2">
                          {activeLogs.map((entryLog, logIdx) => (
                            <div key={`${key}-log-${logIdx}`}>
                              <p className="text-xs font-semibold text-default-700 mb-2">
                                {entryLog?.action?.replace(/_/g, ' ') || 'log'} entries
                              </p>
                              <div className="space-y-2">
                                {(entryLog?.checkEntries || []).map((e, idx) => {
                                  const exp = normalizeTimestamp(e.expirationDate);
                                  return (
                                    <div key={`${key}-entry-${logIdx}-${idx}`} className="text-xs text-default-700 border rounded-md p-2 bg-default-50">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="font-semibold">{e.itemName || e.itemId}</div>
                                        <Chip size="sm" variant="flat" color={e.ok ? 'success' : 'warning'}>
                                          {e.countedQuantity}/{e.requiredQuantity}
                                        </Chip>
                                      </div>
                                      <div className="flex flex-wrap gap-2 text-xs text-default-500">
                                        {e.pocket && <span>Pocket: {pocketLabel(e.pocket)}</span>}
                                        {e.compartmentId && <span>Compartment: {e.compartmentId}</span>}
                                        {e.serialNumber && <span>Serial: {e.serialNumber}</span>}
                                        {exp && <span className={exp.getTime() < Date.now() ? 'text-danger' : ''}>Exp: {exp.toLocaleDateString()}</span>}
                                      </div>
                                      {e.assetCondition && (
                                        <div className="flex flex-wrap gap-2 mt-1">
                                          <Chip
                                            size="sm"
                                            variant="flat"
                                            color={
                                              e.assetCondition === 'Good' ? 'success' :
                                              e.assetCondition === 'Minor Issue' ? 'warning' :
                                              'danger'
                                            }
                                          >
                                            Condition: {e.assetCondition}
                                          </Chip>
                                        </div>
                                      )}
                                      {e.assetCheckResult && (
                                        <div className="mt-1 p-1.5 bg-default-200 rounded text-xs space-y-0.5">
                                          {e.assetCheckResult.batteryStatus && (
                                            <div>Battery: {e.assetCheckResult.batteryStatus}{e.assetCheckResult.batteryPct !== undefined ? ` (${e.assetCheckResult.batteryPct}%)` : ''}</div>
                                          )}
                                          {e.assetCheckResult.padsSealed !== undefined && (
                                            <div>Pads: {e.assetCheckResult.padsSealed ? 'Sealed' : 'Not sealed'}</div>
                                          )}
                                          {e.assetCheckResult.oxygenPsi !== undefined && (
                                            <div>O₂ PSI: {e.assetCheckResult.oxygenPsi}</div>
                                          )}
                                          {e.assetCheckResult.notes && (
                                            <div>Notes: {e.assetCheckResult.notes}</div>
                                          )}
                                        </div>
                                      )}
                                      {e.notes && <div className="text-xs text-default-600 mt-1">Notes: {e.notes}</div>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
      </CardBody>
      <LogDetailModal isOpen={detailOpen} onOpenChange={setDetailOpen} item={selectedItem} />
    </Card>
  );
}
