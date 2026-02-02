'use client';
import React, { useEffect, useState } from 'react';
import { collection, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Card, CardBody, CardHeader, Chip, Spinner, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@heroui/react';
import type { InventoryLog } from '@/app/types';

interface AssetHistoryProps {
  assetId: string;
  maxRows?: number;
  serialNumber?: string;
}

export default function AssetHistory({ assetId, maxRows = 10, serialNumber }: AssetHistoryProps) {
  const [logs, setLogs] = useState<(InventoryLog & { id: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) return;

    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const q = query(
          collection(db, 'inventory_logs'),
          where('itemId', '==', assetId),
          orderBy('timestamp', 'desc')
        );
        const snap = await getDocs(q);
        let logs: (InventoryLog & { id: string })[] = snap.docs
          .map((doc) => {
            const data = doc.data();
            return {
              id: doc.id,
              ...data,
              timestamp:
                data.timestamp instanceof Timestamp
                  ? data.timestamp.toDate()
                  : data.timestamp instanceof Date
                  ? data.timestamp
                  : new Date(),
            } as InventoryLog & { id: string };
          });

        if (serialNumber) {
          logs = logs.filter((log) => String(log.serialNumber || '') === String(serialNumber));
        }

        logs = logs.slice(0, maxRows);

        if (mounted) {
          setLogs(logs);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          const errorMsg = err instanceof Error ? err.message : 'Failed to load history';
          setError(errorMsg);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [assetId, maxRows, serialNumber]);

  const getActionColor = (action: string) => {
    if (action === 'asset_checkout') return 'warning';
    if (action === 'asset_checkin') return 'success';
    if (action === 'barcode_assign' || action === 'barcode_reassign') return 'secondary';
    return 'default';
  };

  const formatTimestamp = (ts: Date) => {
    return ts.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
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
          <p className="text-gray-500 text-sm text-center py-4">No checkout/checkin history</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex justify-between items-center bg-default-50 px-4 py-3 border-b border-default-200">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Activity ({logs.length})</h3>
      </CardHeader>
      <CardBody className="p-0">
        <Table hideHeader removeWrapper>
          <TableHeader>
            <TableColumn>Action</TableColumn>
            <TableColumn>User</TableColumn>
            <TableColumn>Timestamp</TableColumn>
            <TableColumn>Location</TableColumn>
            <TableColumn>Notes</TableColumn>
          </TableHeader>
          <TableBody>
            {logs.map((log, idx) => {
              const rowClass = idx === 0 ? 'bg-default-50 dark:bg-slate-800 text-gray-700 dark:text-gray-200' : '';
              return (
                <TableRow key={log.id} className={rowClass}>
                <TableCell>
                  <Chip
                    size="sm"
                    variant="solid"
                    color={getActionColor(log.action)}
                    className="capitalize"
                  >
                    {log.action.replace(/_/g, ' ')}
                  </Chip>
                </TableCell>
                <TableCell className="text-sm">{log.userName || 'Unknown'}</TableCell>
                <TableCell className="text-xs text-default-600 dark:text-default-300 whitespace-nowrap">
                  {formatTimestamp(log.timestamp as Date)}
                </TableCell>
                <TableCell className="text-xs text-default-600 dark:text-default-300">{log.location || '—'}</TableCell>
                <TableCell className="text-xs text-default-600 dark:text-default-300 max-w-xs">
                  {log.action === 'barcode_assign' || log.action === 'barcode_reassign' ? (
                    <div>
                      <div className="font-mono text-xs bg-secondary-50 dark:bg-secondary-900/20 px-1 py-0.5 rounded inline-block">
                        {log.details?.newBarcode || '—'}
                      </div>
                      {log.details?.previousBarcode && (
                        <div className="text-xs text-gray-500 mt-1">
                          Previous: <span className="font-mono">{log.details.previousBarcode}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="truncate">{log.notes || '—'}</span>
                  )}
                </TableCell>
              </TableRow>
            );
            })}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

// Using HeroUI TableRow component imported above
