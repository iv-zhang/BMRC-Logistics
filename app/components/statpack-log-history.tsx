'use client';

import React, { useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Chip,
  Spinner,
} from '@heroui/react';
import { collection, query, where, orderBy, onSnapshot, limit } from 'firebase/firestore';
import { db } from '@/firebase';
import type { StatpackLog } from '@/app/types';
import {
  normalizeTimestamp,
  formatTimestamp,
  pairStatpackLogs,
  formatDuration,
  calculateEventDuration,
  type StatpackLogWithId,
  type StatpackLogDisplayItem,
} from '@/app/lib/logs';
import LogDetailModal from '@/app/components/log-detail-modal';

interface StatpackLogHistoryProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  statpackId: string | null;
  statpackName?: string;
}

export default function StatpackLogHistory({ isOpen, onOpenChange, statpackId, statpackName }: StatpackLogHistoryProps) {
  const [logs, setLogs] = useState<StatpackLogWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<StatpackLogDisplayItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    if (!isOpen || !statpackId) return;

    // Loading state is managed via the snapshot callback below
    const q = query(
      collection(db, 'statpack_logs'),
      where('statpackId', '==', statpackId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsub = onSnapshot(q, (snap) => {
      const result: StatpackLogWithId[] = snap.docs.map((d) => {
        const data = d.data() as StatpackLog & Record<string, unknown>;
        return {
          ...data,
          id: d.id,
          timestamp: normalizeTimestamp(data.timestamp, data.clientTimestamp) ?? null,
        } as StatpackLogWithId;
      });
      setLogs(result);
      setLoading(false);
    }, (err) => {
      console.error('Failed to load statpack logs:', err);
      setLoading(false);
    });

    return () => unsub();
  }, [isOpen, statpackId]);

  const pairedItems = pairStatpackLogs(logs);

  // Stats
  const totalCheckouts = logs.filter(l => l.action === 'checkout').length;
  const totalCheckins = logs.filter(l => l.action === 'checkin').length;
  const quickCheckins = logs.filter(l => (l as StatpackLogWithId & { quickCheckin?: boolean }).quickCheckin).length;

  return (
    <>
      <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="3xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <span className="text-base font-semibold">Activity Log — {statpackName || 'Statpack'}</span>
            <div className="flex gap-2 text-xs">
              <Chip size="sm" variant="flat">{totalCheckouts} checkouts</Chip>
              <Chip size="sm" variant="flat">{totalCheckins} checkins</Chip>
              {quickCheckins > 0 && (
                <Chip size="sm" variant="flat" color="warning">{quickCheckins} quick</Chip>
              )}
            </div>
          </ModalHeader>
          <ModalBody>
            {loading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : pairedItems.length === 0 ? (
              <Card className="bg-default-50">
                <CardBody className="text-center py-8">
                  <p className="text-default-500">No activity logged yet.</p>
                </CardBody>
              </Card>
            ) : (
              <div className="space-y-3">
                {pairedItems.map((item, idx) => {
                  if (item.kind === 'pair') {
                    const duration = calculateEventDuration(item.checkout, item.checkin);
                    const isQuick = item.checkin && (item.checkin as StatpackLogWithId & { quickCheckin?: boolean }).quickCheckin;
                    const checkoutEntries = item.checkout?.checkEntries?.length || 0;
                    const checkinEntries = item.checkin?.checkEntries?.length || 0;
                    const checkoutOk = item.checkout?.checkEntries?.filter(e => e.ok).length || 0;
                    const checkinOk = item.checkin?.checkEntries?.filter(e => e.ok).length || 0;
                    
                    // Check for low O₂ readings in checkout
                    const lowO2 = item.checkout?.checkEntries?.some(e => 
                      e.assetCheckResult?.oxygenPsi !== undefined && e.assetCheckResult.oxygenPsi < 1800
                    );

                    return (
                      <Card
                        key={`pair-${item.pairId}-${idx}`}
                        isPressable
                        onPress={() => { setSelectedItem(item); setDetailOpen(true); }}
                        className="hover:shadow-md transition-shadow"
                      >
                        <CardBody className="gap-2 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Chip size="sm" variant="solid" color="warning" className="capitalize">Checkout</Chip>
                              <span className="text-xs text-default-500">→</span>
                              <Chip size="sm" variant="solid" color="success" className="capitalize">
                                {isQuick ? 'Quick Check-in' : 'Check-in'}
                              </Chip>
                              {duration !== null && (
                                <Chip size="sm" variant="flat" className="text-xs">{formatDuration(duration)}</Chip>
                              )}
                              {lowO2 && (
                                <Chip size="sm" variant="flat" color="warning" className="text-xs">Low O2</Chip>
                              )}
                            </div>
                            <span className="text-xs text-default-500 whitespace-nowrap">
                              {formatTimestamp(item.sortTime)}
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-xs text-default-600">
                            <span>By: {item.checkout?.userName || item.checkin?.userName || 'Unknown'}</span>
                            {checkoutEntries > 0 && (
                              <span className="text-default-400">Out: {checkoutOk}/{checkoutEntries} OK</span>
                            )}
                            {checkinEntries > 0 && (
                              <span className="text-default-400">In: {checkinOk}/{checkinEntries} OK</span>
                            )}
                          </div>

                          {isQuick && (
                            <div className="flex items-center gap-1">
                              <Chip size="sm" color="warning" variant="flat">Quick check-in — no item verification</Chip>
                            </div>
                          )}

                          {item.checkout?.notes && (
                            <p className="text-xs text-default-500 truncate">{item.checkout.notes}</p>
                          )}
                        </CardBody>
                      </Card>
                    );
                  }

                  // Single (unpaired) log
                  const log = item.log;
                  const isQuick = (log as StatpackLogWithId & { quickCheckin?: boolean }).quickCheckin;
                  const entries = log.checkEntries?.length || 0;
                  const okEntries = log.checkEntries?.filter(e => e.ok).length || 0;

                  return (
                    <Card
                      key={`single-${log.id}-${idx}`}
                      isPressable
                      onPress={() => { setSelectedItem(item); setDetailOpen(true); }}
                      className="hover:shadow-md transition-shadow border-l-4 border-default-300"
                    >
                      <CardBody className="gap-2 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Chip
                              size="sm"
                              variant="solid"
                              className="capitalize"
                              color={log.action === 'checkout' ? 'warning' : log.action === 'checkin' ? 'success' : 'default'}
                            >
                              {log.action?.replace(/_/g, ' ') || 'Unknown'}
                            </Chip>
                            {isQuick && <Chip size="sm" color="warning" variant="flat">Quick</Chip>}
                            {!log.pairId && (
                              <Chip size="sm" color="danger" variant="flat">Unpaired</Chip>
                            )}
                          </div>
                          <span className="text-xs text-default-500 whitespace-nowrap">
                            {formatTimestamp(log.timestamp)}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 text-xs text-default-600">
                          <span>By: {log.userName || 'Unknown'}</span>
                          {entries > 0 && <span>{okEntries}/{entries} items OK</span>}
                        </div>

                        {log.notes && (
                          <p className="text-xs text-default-500 truncate">{log.notes}</p>
                        )}
                      </CardBody>
                    </Card>
                  );
                })}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => onOpenChange(false)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <LogDetailModal
        isOpen={detailOpen}
        onOpenChange={setDetailOpen}
        item={selectedItem}
      />
    </>
  );
}
