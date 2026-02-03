'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { collection, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Card, CardBody, CardHeader, Chip, Spinner, Button, Divider } from '@heroui/react';
import type { StatpackLog, StatpackPocket } from '@/app/types';

interface StatpackHistoryProps {
  statpackId: string;
  maxRows?: number;
}

const pocketLabel = (pocket?: StatpackPocket | string) => {
  if (!pocket) return 'unknown';
  return String(pocket).replace('_', ' ');
};

const normalizeTimestamp = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  if (typeof value?.toDate === 'function') return value.toDate();
  return null;
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
  const [logs, setLogs] = useState<(StatpackLog & { id: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
          const msg = err instanceof Error ? err.message : 'Failed to load statpack history';
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

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

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

  if (logs.length === 0) {
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Statpack Activity ({logs.length})</h3>
      </CardHeader>
      <CardBody className="space-y-3">
        {logs.map((log) => {
          const entries = log.checkEntries || [];
          const total = entries.length;
          const okCount = entries.filter((e) => e.ok).length;
          const missing = Math.max(total - okCount, 0);
          const pocketCounts = entries.reduce<Record<string, number>>((acc, e) => {
            const key = pocketLabel(e.pocket || e.compartmentId || 'unknown');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {});
          const warningsCount = (log.validationWarnings || []).length;
          const sealChecks = log.issues?.sealChecks ? Object.keys(log.issues.sealChecks).length : 0;
          const oxygenCount = log.issues?.oxygenReadings ? Object.keys(log.issues.oxygenReadings).length : 0;

          return (
            <Card key={log.id} className="border border-default-200">
              <CardBody className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Chip size="sm" variant="solid" color={getActionColor(log.action)} className="capitalize">
                      {log.action.replace(/_/g, ' ')}
                    </Chip>
                    <span className="text-sm text-default-600">{log.userName || 'Unknown'}</span>
                    <span className="text-xs text-default-500">{formatTimestamp(normalizeTimestamp(log.timestamp))}</span>
                  </div>
                  <Button size="sm" variant="bordered" onPress={() => toggle(log.id)}>
                    {expanded[log.id] ? 'Hide details' : 'Details'}
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-default-600">
                  <Chip size="sm" variant="flat" color={missing > 0 ? 'warning' : 'success'}>
                    {okCount}/{total} OK
                  </Chip>
                  {missing > 0 && (
                    <Chip size="sm" variant="flat" color="warning">
                      {missing} missing
                    </Chip>
                  )}
                  {warningsCount > 0 && (
                    <Chip size="sm" variant="flat" color="danger">
                      {warningsCount} warnings
                    </Chip>
                  )}
                  {sealChecks > 0 && (
                    <Chip size="sm" variant="flat" color="secondary">
                      {sealChecks} seals
                    </Chip>
                  )}
                  {oxygenCount > 0 && (
                    <Chip size="sm" variant="flat" color="secondary">
                      {oxygenCount} O2 readings
                    </Chip>
                  )}
                </div>

                {Object.keys(pocketCounts).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(pocketCounts).map(([pocket, count]) => (
                      <Chip key={`${log.id}-${pocket}`} size="sm" variant="bordered">
                        {pocket}: {count}
                      </Chip>
                    ))}
                  </div>
                )}

                {expanded[log.id] && (
                  <div className="pt-2">
                    {log.notes && (
                      <p className="text-sm text-default-600 mb-2">Notes: {log.notes}</p>
                    )}

                    {warningsCount > 0 && (
                      <div className="mb-3">
                        <p className="text-xs font-semibold text-danger">Validation Warnings</p>
                        <div className="text-xs text-danger space-y-1">
                          {log.validationWarnings?.map((w, idx) => (
                            <div key={`${log.id}-warn-${idx}`}>
                              <div className="font-semibold">{w.itemName || w.itemId || 'Unknown Item'}</div>
                              <div>{w.message}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(log.issues?.sealChecks || log.issues?.oxygenReadings) && (
                      <div className="mb-3">
                        <p className="text-xs font-semibold text-default-700">Checks</p>
                        {log.issues?.sealChecks && (
                          <div className="text-xs text-default-600">Seals: {Object.keys(log.issues.sealChecks).length}</div>
                        )}
                        {log.issues?.oxygenReadings && (
                          <div className="text-xs text-default-600">Oxygen: {Object.keys(log.issues.oxygenReadings).length} readings</div>
                        )}
                      </div>
                    )}

                    {entries.length > 0 && (
                      <>
                        <Divider className="my-2" />
                        <div className="space-y-2">
                          {entries.map((e, idx) => {
                            const exp = normalizeTimestamp(e.expirationDate);
                            return (
                              <div key={`${log.id}-entry-${idx}`} className="text-xs text-default-700 border rounded-md p-2 bg-default-50">
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
                                {e.notes && <div className="text-xs text-default-600 mt-1">Notes: {e.notes}</div>}
                              </div>
                            );
                          })}
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
    </Card>
  );
}
