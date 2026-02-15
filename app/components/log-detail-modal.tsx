'use client';

import React from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Divider,
} from '@heroui/react';
import type { StatpackLog } from '@/app/types';
import { formatTimestamp, normalizeTimestamp, formatDuration, calculateEventDuration } from '@/app/lib/logs';
import type { StatpackLogDisplayItem, StatpackLogWithId } from '@/app/lib/logs';

interface LogDetailModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  item: StatpackLogDisplayItem | null;
}

const summarizeEntries = (log?: StatpackLog) => {
  const entries = log?.checkEntries || [];
  const okCount = entries.filter((e) => e.ok).length;
  const total = entries.length;
  const missing = Math.max(total - okCount, 0);
  return { okCount, total, missing };
};

const renderIssues = (log?: StatpackLog) => {
  if (!log?.issues) return null;
  const sealChecks = log.issues.sealChecks || {};
  const oxygenReadings = log.issues.oxygenReadings || {};
  const issueReports = log.issues.issueReports || {};

  return (
    <div className="space-y-2">
      {Object.keys(sealChecks).length > 0 && (
        <div className="text-xs text-default-600">
          <p className="font-semibold text-default-700">Seal checks</p>
          <div className="space-y-1">
            {Object.entries(sealChecks).map(([key, val]) => (
              <div key={`seal-${key}`} className="flex flex-wrap gap-2">
                <span className="font-medium">{key}</span>
                <span>{val.sealed ? 'Sealed' : 'Broken'}</span>
                {val.sealNumber && <span>Seal #: {val.sealNumber}</span>}
                {val.expiration && <span>Exp: {new Date(val.expiration).toLocaleDateString()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {Object.keys(oxygenReadings).length > 0 && (
        <div className="text-xs text-default-600">
          <p className="font-semibold text-default-700">Oxygen readings</p>
          <div className="space-y-1">
            {Object.entries(oxygenReadings).map(([key, val]) => (
              <div key={`oxy-${key}`} className="flex flex-wrap gap-2">
                <span className="font-medium">{key}</span>
                <span>{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {Object.keys(issueReports).length > 0 && (
        <div className="text-xs text-default-600">
          <p className="font-semibold text-default-700">Issue reports</p>
          <div className="space-y-1">
            {Object.entries(issueReports).map(([key, val]) => (
              <div key={`issue-${key}`} className="space-y-1 rounded border border-default-200 bg-default-50 p-2">
                <div className="font-semibold">{val.itemName}</div>
                <div className="text-xs text-default-500">{val.issueType}</div>
                <div className="text-xs">Replaced: {val.isReplaced ? `Yes (${val.replacedQuantity})` : 'No'}</div>
                {val.notes && <div className="text-xs">Notes: {val.notes}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const renderWarnings = (log?: StatpackLog) => {
  if (!log?.validationWarnings || log.validationWarnings.length === 0) return null;
  // Filter out info-level warnings (e.g., "Inventory item not found" for non-asset items)
  // These are not actionable for logistics until a full inventory audit is done
  const actionableWarnings = log.validationWarnings.filter(w => w.severity !== 'info');
  if (actionableWarnings.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-danger">Validation warnings</p>
      <div className="space-y-1">
        {actionableWarnings.map((w, idx) => (
          <div key={`warn-${idx}`} className="text-xs text-danger">
            <div className="font-semibold">{w.itemName || w.itemId || 'Unknown item'}</div>
            <div>{w.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const renderEntries = (log?: StatpackLog) => {
  const entries = log?.checkEntries || [];
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-default-700">Checked items</p>
      <div className="space-y-2">
        {entries.map((e, idx) => {
          const exp = normalizeTimestamp(e.expirationDate);
          return (
            <div key={`${log?.id || 'log'}-entry-${idx}`} className="rounded border border-default-200 bg-default-50 p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{e.itemName || e.itemId}</div>
                <Chip size="sm" variant="flat" color={e.ok ? 'success' : 'warning'}>
                  {e.countedQuantity}/{e.requiredQuantity}
                </Chip>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-default-500">
                {e.pocket && <span>Pocket: {String(e.pocket).replace('_', ' ')}</span>}
                {e.compartmentId && <span>Compartment: {e.compartmentId}</span>}
                {e.serialNumber && <span>Serial: {e.serialNumber}</span>}
                {exp && <span className={exp.getTime() < Date.now() ? 'text-danger' : ''}>Exp: {exp.toLocaleDateString()}</span>}
                {e.assetCondition && <span>Condition: {e.assetCondition}</span>}
                {e.assetCheckResult?.batteryPct !== undefined && (
                  <span>Battery: {e.assetCheckResult.batteryPct}%</span>
                )}
                {e.assetCheckResult?.oxygenPsi !== undefined && (
                  <span>O2: {e.assetCheckResult.oxygenPsi} PSI</span>
                )}
              </div>
              {e.notes && <div className="mt-1 text-default-500">Notes: {e.notes}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const renderLogSummary = (log?: StatpackLogWithId) => {
  if (!log) return null;
  const { okCount, total, missing } = summarizeEntries(log);
  // Count only actionable warnings (exclude info-level)
  const warnings = (log.validationWarnings || []).filter(w => w.severity !== 'info').length;
  return (
    <div className="flex flex-wrap gap-2 text-xs text-default-600">
      {total > 0 && (
        <Chip size="sm" variant="flat" color={missing > 0 ? 'warning' : 'success'}>
          {okCount}/{total} OK
        </Chip>
      )}
      {missing > 0 && (
        <Chip size="sm" variant="flat" color="warning">
          {missing} missing
        </Chip>
      )}
      {warnings > 0 && (
        <Chip size="sm" variant="flat" color="danger">
          {warnings} warnings
        </Chip>
      )}
    </div>
  );
};

const renderLogBlock = (log?: StatpackLogWithId, label?: string) => {
  if (!log) return null;
  return (
    <div className="rounded border border-default-200 bg-default-50 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {label && <Chip size="sm" variant="flat">{label}</Chip>}
          <Chip size="sm" variant="solid" className="capitalize" color={log.action === 'checkout' ? 'warning' : log.action === 'checkin' ? 'success' : 'default'}>
            {log.action.replace(/_/g, ' ')}
          </Chip>
          <span className="text-xs text-default-600">{log.userName || 'Unknown'}</span>
        </div>
        <span className="text-xs text-default-500">{formatTimestamp(normalizeTimestamp(log.timestamp, (log as unknown as Record<string, unknown>).clientTimestamp))}</span>
      </div>
      {renderLogSummary(log)}
      {log.notes && <div className="text-xs text-default-600">Notes: {log.notes}</div>}
      {renderWarnings(log)}
      {renderIssues(log)}
      {renderEntries(log)}
    </div>
  );
};

export default function LogDetailModal({ isOpen, onOpenChange, item }: LogDetailModalProps) {
  const title = item?.kind === 'pair' ? 'Checkout + Check-in Details' : 'Log Details';

  // Compute duration and quick-checkin for pairs
  const pairDuration = item?.kind === 'pair' ? calculateEventDuration(item.checkout, item.checkin) : null;
  const isQuickCheckin = item?.kind === 'pair' && item.checkin
    ? !!(item.checkin as StatpackLogWithId & { quickCheckin?: boolean }).quickCheckin
    : item?.kind === 'single'
    ? !!(item.log as StatpackLogWithId & { quickCheckin?: boolean }).quickCheckin
    : false;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span className="text-base font-semibold">{title}</span>
          <div className="flex flex-wrap items-center gap-2">
            {item?.kind === 'pair' && (
              <span className="text-xs text-default-500">Pair ID: {item.pairId}</span>
            )}
            {item?.kind === 'single' && item.log.pairId && (
              <span className="text-xs text-default-500">Pair ID: {item.log.pairId}</span>
            )}
            {pairDuration !== null && (
              <Chip size="sm" variant="flat" color="default">⏱ {formatDuration(pairDuration)}</Chip>
            )}
            {isQuickCheckin && (
              <Chip size="sm" variant="flat" color="warning">⚡ Quick Check-in</Chip>
            )}
          </div>
        </ModalHeader>
        <ModalBody className="space-y-3">
          {!item && <p className="text-sm text-default-500">No log selected.</p>}
          {item?.kind === 'pair' && (
            <>
              {renderLogBlock(item.checkout, 'Checkout')}
              <Divider />
              {renderLogBlock(item.checkin, isQuickCheckin ? '⚡ Quick Check-in' : 'Check-in')}
            </>
          )}
          {item?.kind === 'single' && renderLogBlock(item.log)}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
