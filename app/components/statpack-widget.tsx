'use client';

import React, { useMemo, useState } from 'react';
import {
  Button,
  Chip,
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
  MapPin,
  Pencil,
  QrCode,
  Wrench,
  Activity,
  Search,
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
  if (lower.includes('ready') && !lower.includes('not')) return 'success' as const;
  if (lower.includes('use')) return 'warning' as const;
  if (lower.includes('maintenance') || lower.includes('not ready')) return 'danger' as const;
  return 'default' as const;
};

/** Two-letter monogram for the pack identity badge (e.g. "Alpha 1" → "A1"). */
function packCode(name?: string): string {
  if (!name) return 'SP';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

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
    <div className="bg-content1 border border-divider rounded-large p-4 hover:border-primary/30 hover:shadow-sm transition-all duration-150 flex flex-col gap-4">

      {/* Header: identity badge + name + status */}
      <div className="flex items-start gap-3">
        <div className="w-[50px] h-[50px] rounded-[13px] flex items-center justify-center font-mono font-semibold text-[15px] flex-none bg-primary-50 dark:bg-primary-900/20 text-primary">
          {packCode(statpack.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-foreground truncate">{statpack.name}</div>
          <div className="flex items-center gap-2 text-xs text-foreground-500 mt-0.5 flex-wrap">
            {statpack.currentLocation && (
              <span className="flex items-center gap-1">
                <MapPin size={11} className="flex-none" /> {statpack.currentLocation}
              </span>
            )}
            <span>
              <span className="font-semibold tabular-nums text-foreground-600">{totalItems}</span> items
            </span>
            {statpack.assetValue ? (
              <span className="font-mono tabular-nums">${statpack.assetValue.toFixed(2)}</span>
            ) : null}
          </div>
          <div className="flex gap-1.5 flex-wrap mt-1.5">
            <Chip size="sm" variant="flat" color={statusColor(statusLabel)}>{statusLabel}</Chip>
            {statpack.isCheckedOut && statpack.assignedToUserName && (
              <Chip size="sm" variant="flat" color="default">{statpack.assignedToUserName}</Chip>
            )}
          </div>
        </div>
        <button
          onClick={() => onOpenEditor(statpack)}
          className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors duration-150 flex-none"
          aria-label="Edit statpack"
        >
          <Pencil size={14} />
        </button>
      </div>

      {/* Pocket pills */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
          Pockets
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedPocket('all')}
            className={`px-2.5 py-1 rounded-medium text-xs font-semibold transition-colors duration-150 ${
              selectedPocket === 'all'
                ? 'bg-primary text-white'
                : 'bg-content2 text-foreground-500 hover:bg-content3'
            }`}
          >
            All
          </button>
          {pocketOrder.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSelectedPocket(key)}
              className={`px-2.5 py-1 rounded-medium text-xs font-semibold transition-colors duration-150 ${
                selectedPocket === key
                  ? 'bg-primary text-white'
                  : 'bg-content2 text-foreground-500 hover:bg-content3'
              }`}
            >
              {label} <span className="tabular-nums">({pocketCounts[key] || 0})</span>
            </button>
          ))}
        </div>

        {selectedPocket !== 'all' && (
          <div className="bg-content2 rounded-large p-3 mt-2">
            {itemsByPocket.length === 0 ? (
              <p className="text-xs text-foreground-400">No items in this pocket.</p>
            ) : (
              <div className="space-y-1.5">
                {itemsByPocket.slice(0, 6).map((item, idx) => (
                  <div key={`${item.itemId}-${idx}`} className="flex items-center justify-between gap-2">
                    {item.assetInstanceId ? (
                      <button
                        type="button"
                        className="truncate text-left text-xs text-foreground hover:text-primary transition-colors duration-150"
                        onClick={() => onEditAsset?.(item.assetInstanceId as string)}
                      >
                        {item.itemDetails?.name || item.itemId}
                      </button>
                    ) : (
                      <span className="truncate text-xs text-foreground">{item.itemDetails?.name || item.itemId}</span>
                    )}
                    <span className="font-mono text-xs font-semibold tabular-nums text-foreground-500 flex-none">
                      {item.currentQuantity ?? 0}/{item.requiredQuantity ?? 0}
                    </span>
                  </div>
                ))}
                {itemsByPocket.length > 6 && (
                  <button
                    onClick={() => onOpenEditor(statpack)}
                    className="text-xs font-semibold text-primary"
                  >
                    View all {itemsByPocket.length} items
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Primary actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" color="primary" startContent={<ClipboardCheck size={14} />} onPress={() => onCheckin(statpack)}>
          Check in
        </Button>
        {onCheckout && (
          <Button size="sm" variant="bordered" startContent={<ClipboardList size={14} />} onPress={() => onCheckout(statpack)}>
            Check out
          </Button>
        )}
        <Button size="sm" variant="flat" startContent={<Wrench size={14} />} onPress={() => onMaintenance(statpack)}>
          Maintenance
        </Button>
        <Button size="sm" variant="light" startContent={<Activity size={14} />} onPress={() => setShowActivity((prev) => !prev)}>
          {showActivity ? 'Hide' : 'Activity'}
        </Button>
      </div>

      {showActivity && (
        <LogTimeline
          statpackId={statpack.id || ''}
          maxRows={4}
          onViewAll={() => historyDisclosure.onOpen()}
        />
      )}

      {/* Utility icon row */}
      <div className="flex items-center gap-1.5 border-t border-divider pt-3 mt-auto">
        <Tooltip content="Scan location">
          <button
            onClick={() => onScan?.(statpack)}
            className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors duration-150"
            aria-label="Scan location"
          >
            <MapPin size={14} />
          </button>
        </Tooltip>
        <Tooltip content="Generate checkout QR">
          <button
            onClick={() => onGenerateQr?.(statpack)}
            className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors duration-150"
            aria-label="Generate checkout QR"
          >
            <QrCode size={14} />
          </button>
        </Tooltip>
        {userRole === 'admin' && onAudit && (
          <Tooltip content="Run audit">
            <button
              onClick={() => onAudit(statpack)}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors duration-150"
              aria-label="Run audit"
            >
              <Search size={14} />
            </button>
          </Tooltip>
        )}
        {userRole === 'admin' && onDuplicate && (
          <Tooltip content="Duplicate statpack">
            <Button
              size="sm"
              variant="light"
              isIconOnly
              onPress={() => onDuplicate(statpack)}
              isLoading={isDuplicating}
              aria-label="Duplicate statpack"
              className="w-8 h-8 min-w-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400"
            >
              {!isDuplicating && <Copy size={14} />}
            </Button>
          </Tooltip>
        )}
      </div>

      <Modal isOpen={historyDisclosure.isOpen} onOpenChange={historyDisclosure.onOpenChange} size="2xl" scrollBehavior="inside">
        <ModalContent className="max-h-[85vh]">
          <ModalHeader>Statpack Activity</ModalHeader>
          <ModalBody className="pb-6 overflow-y-auto max-h-[72vh]">
            <div className="pt-1">
              <StatpackHistory statpackId={statpack.id || ''} maxRows={200} />
            </div>
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
}
