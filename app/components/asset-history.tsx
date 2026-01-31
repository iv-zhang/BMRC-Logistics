'use client';
import React, { useEffect, useState } from 'react';
import { collection, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Card, CardBody, CardHeader, Chip, Spinner, Table, TableBody, TableCell, TableColumn, TableHeader } from '@heroui/react';
import type { InventoryLog } from '@/app/types';

interface AssetHistoryProps {
  assetId: string;
  maxRows?: number;
}

export default function AssetHistory({ assetId, maxRows = 10 }: AssetHistoryProps) {
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
        const logs: (InventoryLog & { id: string })[] = snap.docs
          .slice(0, maxRows)
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
  }, [assetId, maxRows]);

  const getActionColor = (action: string) => {
    if (action === 'asset_checkout') return 'warning';
    if (action === 'asset_checkin') return 'success';
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
      <CardHeader className="bg-slate-50 py-3">
        <h3 className="text-sm font-semibold">Recent Activity ({logs.length})</h3>
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
            {logs.map((log, idx) => (
              <TableRow key={log.id} className={idx === 0 ? 'bg-blue-50' : ''}>
                <TableCell>
                  <Chip
                    size="sm"
                    variant="flat"
                    color={getActionColor(log.action)}
                    className="capitalize"
                  >
                    {log.action.replace(/_/g, ' ')}
                  </Chip>
                </TableCell>
                <TableCell className="text-sm">{log.userName || 'Unknown'}</TableCell>
                <TableCell className="text-xs text-gray-600 whitespace-nowrap">
                  {formatTimestamp(log.timestamp as Date)}
                </TableCell>
                <TableCell className="text-xs text-gray-600">{log.location || '—'}</TableCell>
                <TableCell className="text-xs text-gray-600 max-w-xs truncate">
                  {log.notes || '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

// Table row component for better type safety
const TableRow = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return <tr className={className}>{children}</tr>;
};
