'use client';

import React from 'react';
import { Card, CardBody, Chip, Button, Progress } from '@heroui/react';
import {
  Package,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Box,
  Store,
  MapPin,
} from 'lucide-react';
import type { DisposableSnapshot, AssetSnapshot } from '@/app/lib/audit-helpers';

// ─── Disposable Card ──────────────────────────────────────────────────────────

interface DisposableCardProps {
  item: DisposableSnapshot;
  onAudit?: (item: DisposableSnapshot) => void;
  onConsume?: (item: DisposableSnapshot) => void;
  compact?: boolean;
}

export function DisposableAuditCard({
  item,
  onAudit,
  onConsume,
  compact = false,
}: DisposableCardProps) {
  const stockRatio =
    item.reorderThreshold > 0
      ? Math.min(100, (item.unopenedBoxes / item.reorderThreshold) * 100)
      : item.unopenedBoxes > 0
        ? 100
        : 0;

  const stockColor =
    item.unopenedBoxes === 0
      ? 'danger'
      : item.isLowStock
        ? 'warning'
        : 'success';

  const expiryText = item.earliestExpiration
    ? item.earliestExpiration.toLocaleDateString()
    : 'No expiry tracked';

  return (
    <Card
      className={`w-full ${item.isLowStock || item.isExpired ? 'border-2 border-warning' : ''} ${item.unopenedBoxes === 0 ? 'border-2 border-danger' : ''}`}
    >
      <CardBody className={compact ? 'p-3' : 'p-4'}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Box size={16} className="text-default-500 flex-shrink-0" />
              <span className={`font-semibold ${compact ? 'text-sm' : 'text-base'} truncate`}>
                {item.name}
              </span>
              <Chip size="sm" variant="flat" color="default">
                {item.category}
              </Chip>
            </div>

            {!compact && (
              <div className="text-xs text-default-500 mt-1">
                {item.location}
                {item.room ? ` — ${item.room}` : ''}
              </div>
            )}

            {/* Box count — THE key metric */}
            <div className="mt-2">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="font-medium flex items-center gap-1">
                  <Box size={14} /> {item.unopenedBoxes} box{item.unopenedBoxes !== 1 ? 'es' : ''} in back
                </span>
                {item.itemsPerBox > 1 && (
                  <span className="text-xs text-default-400">
                    ({item.itemsPerBox} per box = {item.unopenedBoxes * item.itemsPerBox} units)
                  </span>
                )}
              </div>
              <Progress
                size="sm"
                value={stockRatio}
                color={stockColor}
                className="max-w-full"
              />
              {item.reorderThreshold > 0 && (
                <div className="text-xs text-default-400 mt-0.5">
                  Par level: {item.reorderThreshold} boxes
                </div>
              )}
            </div>

            {/* Open batch info (front area — informational) */}
            {item.openBatchUnits > 0 && (
              <div className="mt-1 text-xs text-default-500 flex items-center gap-1">
                <Store size={12} /> {item.openBatchUnits} loose units in front (not tracked for audit)
              </div>
            )}

            {/* Status chips */}
            <div className="flex gap-1 mt-2 flex-wrap">
              {item.isExpired && (
                <Chip size="sm" color="danger" variant="flat" startContent={<XCircle size={12} />}>
                  Expired
                </Chip>
              )}
              {item.isLowStock && !item.isExpired && (
                <Chip
                  size="sm"
                  color="warning"
                  variant="flat"
                  startContent={<AlertTriangle size={12} />}
                >
                  Low Stock
                </Chip>
              )}
              {item.auditVerified && (
                <Chip
                  size="sm"
                  color="success"
                  variant="flat"
                  startContent={<CheckCircle2 size={12} />}
                >
                  Verified
                </Chip>
              )}
              {!item.auditVerified && (
                <Chip
                  size="sm"
                  color="default"
                  variant="flat"
                  startContent={<Clock size={12} />}
                >
                  Not Verified
                </Chip>
              )}
            </div>

            {/* Expiration */}
            {!compact && item.earliestExpiration && (
              <div
                className={`text-xs mt-1 ${item.isExpired ? 'text-danger font-semibold' : 'text-default-500'}`}
              >
                {item.isExpired ? 'Expired: ' : 'Expires: '}
                {expiryText}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-1 flex-shrink-0">
            {onAudit && (
              <Button
                size="sm"
                color="primary"
                variant="flat"
                onPress={() => onAudit(item)}
              >
                Audit
              </Button>
            )}
            {onConsume && item.unopenedBoxes > 0 && (
              <Button
                size="sm"
                color="secondary"
                variant="flat"
                onPress={() => onConsume(item)}
              >
                Open Box
              </Button>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Asset Card ───────────────────────────────────────────────────────────────

interface AssetCardProps {
  item: AssetSnapshot;
  onAudit?: (item: AssetSnapshot) => void;
  compact?: boolean;
}

export function AssetAuditCard({ item, onAudit, compact = false }: AssetCardProps) {
  const statusColor =
    item.assetStatus === 'Ready'
      ? 'success'
      : item.assetStatus === 'In Use' || item.assetStatus === 'Checked Out'
        ? 'primary'
        : item.assetStatus === 'Not Ready'
          ? 'danger'
          : 'default';

  return (
    <Card
      className={`w-full ${item.issueCount > 0 ? 'border-2 border-warning' : ''}`}
    >
      <CardBody className={compact ? 'p-3' : 'p-4'}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Package size={16} className="text-primary flex-shrink-0" />
              <span className={`font-semibold ${compact ? 'text-sm' : 'text-base'} truncate`}>
                {item.name}
              </span>
              {item.assetSerial && (
                <Chip size="sm" variant="flat" color="default">
                  #{item.assetSerial}
                </Chip>
              )}
            </div>

            <div className="flex gap-1 mt-2 flex-wrap">
              <Chip size="sm" color={statusColor} variant="flat">
                {item.assetStatus || 'Unknown'}
              </Chip>
              {item.currentLocation && (
                <Chip size="sm" variant="flat" color="default" startContent={<MapPin size={12} />}>
                  {item.currentLocation}
                </Chip>
              )}
              {item.instanceCount > 1 && (
                <Chip size="sm" variant="flat" color="default">
                  {item.instanceCount} units
                </Chip>
              )}
              {item.issueCount > 0 && (
                <Chip
                  size="sm"
                  color="warning"
                  variant="flat"
                  startContent={<AlertTriangle size={12} />}
                >
                  {item.issueCount} issue{item.issueCount !== 1 ? 's' : ''}
                </Chip>
              )}
              {item.auditVerified ? (
                <Chip
                  size="sm"
                  color="success"
                  variant="flat"
                  startContent={<CheckCircle2 size={12} />}
                >
                  Verified
                </Chip>
              ) : (
                <Chip
                  size="sm"
                  color="default"
                  variant="flat"
                  startContent={<Clock size={12} />}
                >
                  Not Verified
                </Chip>
              )}
            </div>

            {!compact && item.lastChecked && (
              <div className="text-xs text-default-500 mt-1">
                Last checked: {item.lastChecked.toLocaleDateString()}
              </div>
            )}
          </div>

          {onAudit && (
            <Button
              size="sm"
              color="primary"
              variant="flat"
              onPress={() => onAudit(item)}
            >
              Audit
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
