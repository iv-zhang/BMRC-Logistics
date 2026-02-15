'use client';

import React, { useMemo, useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Chip,
  Divider,
  Tooltip,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@heroui/react';
import {
  ClipboardCheck,
  ClipboardList,
  Copy,
  Eye,
  MapPin,
  QrCode,
  Wrench,
  Boxes,
  Activity,
} from 'lucide-react';
import type { Statpack, StatpackPocket } from '@/app/types';
import LogTimeline from '@/app/components/log-timeline';
import StatpackHistory from '@/app/components/statpack-history';

interface StatpackWidgetProps {
  statpack: Statpack;
  userRole?: string | null;
  isDuplicating?: boolean;
  onOpenEditor: (pack: Statpack) => void;
  onCheckin: (pack: Statpack) => void;
  onCheckout?: (pack: Statpack) => void;
  onMaintenance: (pack: Statpack) => void;
  onAudit?: (pack: Statpack) => void;
  onDuplicate?: (pack: Statpack) => void;
  onScan?: (pack: Statpack) => void;
  onGenerateQr?: (pack: Statpack) => void;
  onEditAsset?: (assetInstanceId: string) => void;
}

const pocketOrder: { key: StatpackPocket; label: string }[] = [
  { key: 'main', label: 'Main' },
  { key: 'front_aux', label: 'Front' },
  { key: 'side_left', label: 'Left' },
  { key: 'side_right', label: 'Right' },
];

const statusColor = (status?: string) => {
  if (!status) return 'default' as const;
  const lower = status.toLowerCase();
  if (lower.includes('ready')) return 'success' as const;
  if (lower.includes('use')) return 'warning' as const;
  if (lower.includes('maintenance') || lower.includes('not ready')) return 'danger' as const;
  return 'default' as const;
};

export default function StatpackWidget({
  statpack,
  userRole,
  isDuplicating,
  onOpenEditor,
  onCheckin,
  onCheckout,
  onMaintenance,
  onAudit,
  onDuplicate,
  onScan,
  onGenerateQr,
  onEditAsset,
}: StatpackWidgetProps) {
  const [selectedPocket, setSelectedPocket] = useState<StatpackPocket | 'all'>('all');
  const [showActivity, setShowActivity] = useState(false);
  const historyDisclosure = useDisclosure();

  const pocketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    pocketOrder.forEach(({ key }) => (counts[key] = 0));
    (statpack.contents || []).forEach((item) => {
      const key = item.pocket || 'main';
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }, [statpack.contents]);

  const itemsByPocket = useMemo(() => {
    if (selectedPocket === 'all') return [];
    return (statpack.contents || []).filter((item) => item.pocket === selectedPocket);
  }, [selectedPocket, statpack.contents]);

  const statusLabel = statpack.status || (statpack.isCheckedOut ? 'In Use' : 'Ready');
  const totalItems = statpack.contents?.length || 0;

  return (
    <Card className="border border-default-200 shadow-lg hover:shadow-xl transition-shadow">
      <CardHeader className="flex flex-col gap-2 items-start">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold truncate">{statpack.name}</h3>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Chip size="sm" variant="flat" color={statusColor(statusLabel)}>{statusLabel}</Chip>
              {statpack.currentLocation && (
                <Chip size="sm" variant="flat" color="default">
                  <span className="flex items-center gap-1">
                    <MapPin size={12} />
                    {statpack.currentLocation}
                  </span>
                </Chip>
              )}
            </div>
          </div>
          <Button size="sm" variant="flat" onPress={() => onOpenEditor(statpack)}>
            <Eye size={14} className="mr-1" />
            Edit
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-default-600">
          <span className="flex items-center gap-1">
            <Boxes size={12} />
            {totalItems} items
          </span>
          <span>Value: {statpack.assetValue ? `$${statpack.assetValue.toFixed(2)}` : '—'}</span>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="space-y-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-default-500">Pockets</span>
            <Button
              size="sm"
              variant={selectedPocket === 'all' ? 'solid' : 'flat'}
              color={selectedPocket === 'all' ? 'primary' : 'default'}
              onPress={() => setSelectedPocket('all')}
            >
              All
            </Button>
            {pocketOrder.map(({ key, label }) => (
              <Button
                key={key}
                size="sm"
                variant={selectedPocket === key ? 'solid' : 'flat'}
                color={selectedPocket === key ? 'primary' : 'default'}
                onPress={() => setSelectedPocket(key)}
              >
                {label} ({pocketCounts[key] || 0})
              </Button>
            ))}
          </div>
          {selectedPocket !== 'all' && (
            <div className="rounded-md border border-default-200 bg-default-50 p-2">
              {itemsByPocket.length === 0 ? (
                <p className="text-xs text-default-500">No items in this pocket.</p>
              ) : (
                <div className="space-y-2">
                  {itemsByPocket.slice(0, 6).map((item, idx) => (
                    <div key={`${item.itemId}-${idx}`} className="flex items-center justify-between gap-2 text-xs">
                      {item.assetInstanceId ? (
                        <button
                          type="button"
                          className="truncate text-left text-sm text-default-700 hover:underline"
                          onClick={() => onEditAsset?.(item.assetInstanceId as string)}
                        >
                          {item.itemDetails?.name || item.itemId}
                        </button>
                      ) : (
                        <span className="truncate">{item.itemDetails?.name || item.itemId}</span>
                      )}
                      <Chip size="sm" variant="flat" color="default">
                        {item.currentQuantity ?? 0}/{item.requiredQuantity ?? 0}
                      </Chip>
                    </div>
                  ))}
                  {itemsByPocket.length > 6 && (
                    <Button size="sm" variant="light" onPress={() => onOpenEditor(statpack)}>
                      View all items
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" color="primary" onPress={() => onCheckin(statpack)}>
            <ClipboardCheck size={14} className="mr-1" />
            Check-In
          </Button>
          {onCheckout && (
            <Button size="sm" variant="flat" onPress={() => onCheckout(statpack)}>
              <ClipboardList size={14} className="mr-1" />
              Check-Out
            </Button>
          )}
          <Button size="sm" variant="flat" onPress={() => onMaintenance(statpack)}>
            <Wrench size={14} className="mr-1" />
            Maintenance
          </Button>
          <Button size="sm" variant="light" onPress={() => setShowActivity((prev) => !prev)}>
            <Activity size={14} className="mr-1" />
            {showActivity ? 'Hide activity' : 'Show activity'}
          </Button>
        </div>

        {showActivity && (
          <LogTimeline
            statpackId={statpack.id || ''}
            maxRows={4}
            onViewAll={() => historyDisclosure.onOpen()}
          />
        )}

        <Divider />

        <div className="flex flex-wrap items-center gap-2">
          <Tooltip content="Scan location">
            <Button size="sm" variant="light" isIconOnly onPress={() => onScan?.(statpack)}>
              <MapPin size={14} />
            </Button>
          </Tooltip>
          <Tooltip content="Generate checkout QR">
            <Button size="sm" variant="light" isIconOnly onPress={() => onGenerateQr?.(statpack)}>
              <QrCode size={14} />
            </Button>
          </Tooltip>
          {userRole === 'admin' && (
            <>
              <Tooltip content="Manual audit">
                <Button size="sm" variant="light" isIconOnly onPress={() => onAudit?.(statpack)}>
                  <Wrench size={14} />
                </Button>
              </Tooltip>
              <Tooltip content="Duplicate statpack">
                <Button
                  size="sm"
                  variant="light"
                  isIconOnly
                  onPress={() => onDuplicate?.(statpack)}
                  isLoading={isDuplicating}
                >
                  <Copy size={14} />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </CardBody>

      <Modal isOpen={historyDisclosure.isOpen} onOpenChange={historyDisclosure.onOpenChange} size="2xl">
        <ModalContent>
          <ModalHeader>Statpack Activity</ModalHeader>
          <ModalBody className="pb-6">
            <StatpackHistory statpackId={statpack.id || ''} maxRows={20} />
          </ModalBody>
        </ModalContent>
      </Modal>
    </Card>
  );
}
