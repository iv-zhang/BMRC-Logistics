'use client';

import React from 'react';
import { Chip, Tooltip } from '@heroui/react';
import { Package, PanelTop, PanelLeft, PanelRight, Link2Off } from 'lucide-react';
import type { StatpackPocket } from '@/app/types';

interface StatpackAssignment {
  statpackId: string;
  statpackName: string;
  pocket: StatpackPocket;
  compartmentLabel?: string;
  positionIndex?: number;
}

interface AssetStatpackBadgeProps {
  /** Assignment info from the asset's statpackAssignment field */
  assignment?: StatpackAssignment | null;
  /** Also accept legacy assignedToId + separate statpack name */
  legacyAssignedToId?: string;
  legacyStatpackName?: string;
  /** If true, clicking navigates to the statpack */
  clickable?: boolean;
  /** Callback when badge is clicked */
  onClick?: (statpackId: string, pocket: StatpackPocket) => void;
  /** Size of the chip */
  size?: 'sm' | 'md' | 'lg';
  /** Show pocket detail */
  showPocket?: boolean;
}

const POCKET_ICONS: Record<StatpackPocket, React.ReactNode> = {
  main: <Package size={12} />,
  front_aux: <PanelTop size={12} />,
  side_left: <PanelLeft size={12} />,
  side_right: <PanelRight size={12} />,
};

const POCKET_LABELS: Record<StatpackPocket, string> = {
  main: 'Main',
  front_aux: 'Front',
  side_left: 'Left',
  side_right: 'Right',
};

/**
 * Visual badge showing which statpack (and pocket) an asset is assigned to.
 * Appears on asset cards/rows for bidirectional visibility.
 *
 * Usage:
 * ```tsx
 * <AssetStatpackBadge
 *   assignment={asset.statpackAssignment}
 *   onClick={(id, pocket) => navigateToStatpack(id, pocket)}
 * />
 * ```
 */
export default function AssetStatpackBadge({
  assignment,
  legacyAssignedToId,
  legacyStatpackName,
  clickable = true,
  onClick,
  size = 'sm',
  showPocket = true,
}: AssetStatpackBadgeProps) {
  // Resolve from either new assignment or legacy fields
  const statpackId = assignment?.statpackId || legacyAssignedToId;
  const statpackName = assignment?.statpackName || legacyStatpackName;
  const pocket = assignment?.pocket;

  if (!statpackId) {
    return (
      <Chip
        size={size}
        variant="flat"
        color="default"
        startContent={<Link2Off size={12} />}
        className="opacity-60"
      >
        Unassigned
      </Chip>
    );
  }

  const pocketLabel = pocket ? POCKET_LABELS[pocket] : null;
  const pocketIcon = pocket ? POCKET_ICONS[pocket] : null;

  const badge = (
    <Chip
      size={size}
      variant="flat"
      color="primary"
      startContent={pocketIcon || <Package size={12} />}
      className={clickable ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}
      onClick={() => {
        if (clickable && onClick && statpackId) {
          onClick(statpackId, pocket || 'main');
        }
      }}
    >
      {statpackName || statpackId}
      {showPocket && pocketLabel && (
        <span className="ml-1 opacity-70">→ {pocketLabel}</span>
      )}
    </Chip>
  );

  if (!pocket || !showPocket) return badge;

  return (
    <Tooltip
      content={
        <div className="text-xs space-y-1 p-1">
          <div><strong>Statpack:</strong> {statpackName || statpackId}</div>
          <div><strong>Pocket:</strong> {POCKET_LABELS[pocket]}</div>
          {assignment?.compartmentLabel && (
            <div><strong>Compartment:</strong> {assignment.compartmentLabel}</div>
          )}
        </div>
      }
    >
      {badge}
    </Tooltip>
  );
}

/**
 * Summary panel showing all assets in a statpack, grouped by pocket.
 * Used in the statpack editor view.
 */
interface StatpackAssetSummaryProps {
  /** All assets assigned to this statpack */
  assets: Array<{
    id: string;
    name: string;
    assetSerial?: string;
    assignedBarcode?: string;
    assetStatus?: string;
    assetCategory?: string;
    pocket?: StatpackPocket;
    lastVerifiedAt?: Date;
  }>;
  /** Callback when an asset is clicked */
  onAssetClick?: (assetId: string) => void;
  /** Callback to verify an asset */
  onVerifyAsset?: (assetId: string) => void;
}

export function StatpackAssetSummary({
  assets,
  onAssetClick,
  onVerifyAsset,
}: StatpackAssetSummaryProps) {
  // Group by pocket
  const byPocket = assets.reduce<Record<string, typeof assets>>((acc, asset) => {
    const pocket = asset.pocket || 'unassigned';
    if (!acc[pocket]) acc[pocket] = [];
    acc[pocket].push(asset);
    return acc;
  }, {});

  const pocketOrder: (StatpackPocket | 'unassigned')[] = ['main', 'front_aux', 'side_left', 'side_right', 'unassigned'];

  if (assets.length === 0) {
    return (
      <div className="text-sm text-default-400 italic py-2">
        No assets assigned to this statpack
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <Package size={14} />
        Assets ({assets.length})
      </h4>
      {pocketOrder.map(pocket => {
        const items = byPocket[pocket];
        if (!items?.length) return null;

        const label = pocket === 'unassigned' ? 'Unassigned' : POCKET_LABELS[pocket as StatpackPocket];

        return (
          <div key={pocket} className="space-y-1">
            <div className="text-xs font-medium text-default-500 flex items-center gap-1">
              {pocket !== 'unassigned' && POCKET_ICONS[pocket as StatpackPocket]}
              {label}
            </div>
            {items.map(asset => (
              <div
                key={asset.id}
                className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-default-50 hover:bg-default-100 transition-colors cursor-pointer"
                onClick={() => onAssetClick?.(asset.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm truncate">{asset.name}</span>
                  {asset.assetSerial && (
                    <span className="text-xs text-default-400 font-mono">{asset.assetSerial}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Chip
                    size="sm"
                    variant="dot"
                    color={
                      asset.assetStatus === 'Ready' ? 'success' :
                      asset.assetStatus === 'Checked Out' || asset.assetStatus === 'In Use' ? 'warning' :
                      'danger'
                    }
                  >
                    {asset.assetStatus || 'Unknown'}
                  </Chip>
                  {onVerifyAsset && (
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={(e) => { e.stopPropagation(); onVerifyAsset(asset.id); }}
                    >
                      Verify
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
