'use client';

import React from 'react';
import { Chip, Button } from '@heroui/react';
import { MapPin, ArrowRightLeft, PackagePlus, AlertTriangle } from 'lucide-react';
import type { DisposableSnapshot, AssetSnapshot } from '@/app/lib/audit-helpers';
import type { DrawerAction } from '@/app/components/audit-action-drawer';
import { CategoryBadge } from '@/app/components/category-badge';
import { formatExp, expTextColor } from '@/app/lib/item-status';

function lastAuditLabel(d?: Date): string {
  if (!d) return 'Never audited';
  return `Audited ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// ─── Disposable Card ──────────────────────────────────────────────────────────

interface DisposableCardProps {
  item: DisposableSnapshot;
  /** Open the action drawer on this item at the given section */
  onAction: (item: DisposableSnapshot, action: DrawerAction) => void;
}

export function DisposableAuditCard({ item, onAction }: DisposableCardProps) {
  const pct = item.reorderThreshold > 0
    ? Math.min(100, (item.totalUnits / (item.reorderThreshold * 2)) * 100)
    : item.totalUnits > 0 ? 100 : 0;
  const barColor = item.isOut || item.isExpired ? 'bg-danger' : item.isLowStock ? 'bg-warning' : 'bg-success';
  const qtyColor = item.isOut ? 'text-danger' : item.isLowStock ? 'text-warning' : 'text-success';
  const loc = [item.location, item.room].filter(Boolean).join(' › ');

  return (
    <div
      onClick={() => onAction(item, 'count')}
      className="flex gap-4 items-center flex-wrap bg-content1 border border-divider rounded-large px-4 py-4 cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all duration-150"
    >
      <CategoryBadge category={item.category} />

      {/* Info */}
      <div className="flex-1 min-w-0 basis-40">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-semibold text-foreground">{item.name}</span>
          <span className="text-xs text-foreground-400">{item.category}</span>
        </div>
        {loc && (
          <div className="flex items-center gap-1 text-xs text-foreground-500 mb-2">
            <MapPin size={11} className="flex-none" /> {loc}
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap items-center">
          {item.isExpired && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
          {item.isOut && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
          {item.isLowStock && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
          {item.auditVerified
            ? <Chip size="sm" variant="flat" color="success">Verified</Chip>
            : <Chip size="sm" variant="flat" color="default">Due</Chip>}
          <span className="text-xs text-foreground-400">{lastAuditLabel(item.lastAuditDate)}</span>
        </div>
        {item.earliestExpiration && (
          <div className={`text-xs font-semibold mt-1.5 ${expTextColor(item.earliestExpiration)}`}>
            Expires {formatExp(item.earliestExpiration)}
          </div>
        )}
      </div>

      {/* Quantity */}
      <div className="w-40 flex-none flex flex-col items-end gap-1.5">
        <div className="text-center min-w-[54px]">
          <div className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
            {item.unopenedBoxes}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-foreground-400 mt-1 font-semibold">
            Boxes
          </div>
        </div>
        <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-1 justify-end flex-wrap">
          <Chip size="sm" variant="flat" color="default">{item.totalUnits} units</Chip>
          {item.reorderThreshold > 0 && (
            <Chip size="sm" variant="flat" color="default">Reorder ≤{item.reorderThreshold}</Chip>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div
        className="flex flex-row sm:flex-col gap-1.5 flex-none w-full sm:w-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <Button size="sm" color="primary" variant="flat" className="flex-1 sm:flex-none" onPress={() => onAction(item, 'count')}>
          Count
        </Button>
        <Button size="sm" variant="bordered" className="flex-1 sm:flex-none" startContent={<ArrowRightLeft size={13} />} onPress={() => onAction(item, 'move')}>
          Move
        </Button>
        <Button size="sm" variant="bordered" className="flex-1 sm:flex-none" startContent={<PackagePlus size={13} />} onPress={() => onAction(item, 'shipment')}>
          Shipment
        </Button>
      </div>
    </div>
  );
}

// ─── Asset Card ───────────────────────────────────────────────────────────────

interface AssetCardProps {
  item: AssetSnapshot;
  onAction: (item: AssetSnapshot, action: DrawerAction) => void;
}

export function AssetAuditCard({ item, onAction }: AssetCardProps) {
  const statusColor =
    item.assetStatus === 'Ready'
      ? 'success'
      : item.assetStatus === 'In Use' || item.assetStatus === 'Checked Out'
        ? 'primary'
        : item.assetStatus === 'Not Ready'
          ? 'danger'
          : 'default';

  return (
    <div
      onClick={() => onAction(item, 'count')}
      className="flex gap-4 items-center flex-wrap bg-content1 border border-divider rounded-large px-4 py-4 cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all duration-150"
    >
      <CategoryBadge category={item.category} />

      <div className="flex-1 min-w-0 basis-40">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-semibold text-foreground">{item.name}</span>
          {item.assetSerial && (
            <span className="font-mono text-xs text-foreground-500">#{item.assetSerial}</span>
          )}
        </div>
        {item.currentLocation && (
          <div className="flex items-center gap-1 text-xs text-foreground-500 mb-2">
            <MapPin size={11} className="flex-none" /> {item.currentLocation}
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap items-center">
          <Chip size="sm" variant="flat" color={statusColor}>{item.assetStatus || 'Unknown'}</Chip>
          {item.instanceCount > 1 && (
            <Chip size="sm" variant="flat" color="default">{item.instanceCount} units</Chip>
          )}
          {item.issueCount > 0 && (
            <Chip size="sm" variant="flat" color="warning">
              {item.issueCount} issue{item.issueCount !== 1 ? 's' : ''}
            </Chip>
          )}
          {item.auditVerified
            ? <Chip size="sm" variant="flat" color="success">Verified</Chip>
            : <Chip size="sm" variant="flat" color="default">Due</Chip>}
          <span className="text-xs text-foreground-400">{lastAuditLabel(item.lastAuditDate)}</span>
        </div>
      </div>

      {/* Quick actions */}
      <div
        className="flex flex-row sm:flex-col gap-1.5 flex-none w-full sm:w-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <Button size="sm" color="primary" variant="flat" className="flex-1 sm:flex-none" onPress={() => onAction(item, 'count')}>
          Verify
        </Button>
        <Button size="sm" variant="bordered" className="flex-1 sm:flex-none" startContent={<ArrowRightLeft size={13} />} onPress={() => onAction(item, 'move')}>
          Move
        </Button>
        <Button size="sm" variant="bordered" className="flex-1 sm:flex-none" startContent={<AlertTriangle size={13} />} onPress={() => onAction(item, 'report')}>
          Report
        </Button>
      </div>
    </div>
  );
}
