'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Chip, Input, Select, SelectItem, Textarea } from '@heroui/react';
import {
  AlertTriangle,
  ArrowRightLeft,
  ClipboardCheck,
  MapPin,
  PackagePlus,
  Wrench,
  X,
} from 'lucide-react';
import type { HQRoom, InventoryItem, LocationType, StorageLocationRef } from '@/app/types';
import { CategoryBadge } from '@/app/components/category-badge';
import CountControl from '@/app/components/count-control';
import ConditionToggle, { type ConditionValue } from '@/app/components/condition-toggle';
import StorageLocationPicker from '@/app/components/storage-location-picker';
import ScannerInput from '@/app/components/scanner-input';
import PanelShell from '@/app/components/panel-shell';
import { determineIsAsset } from '@/app/lib/inventory';
import { computeBagStock, displayLocation, getItemStatus } from '@/app/lib/item-status';
import { parseGs1Barcode } from '@/app/lib/gs1';
import { auditStockFingerprint, buildAuditCountPlan } from '@/app/lib/audit-count';
import { submitAuditEntries } from '@/app/lib/audit-helpers';
import {
  addShipment,
  moveItemLocation,
  recordItemFix,
  reportItemIssue,
  type AuditActor,
  type ItemFixType,
  type ItemIssueType,
} from '@/app/lib/audit-actions';
import { getInventoryAreaOptions } from '@/app/config/org-config';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';

export type DrawerAction = 'count' | 'move' | 'shipment' | 'report' | 'fix';

interface AuditActionDrawerProps {
  item: InventoryItem | null;
  initialAction: DrawerAction;
  actor: AuditActor | null;
  /** Zone label recorded on count submissions */
  zoneLabel: string;
  onClose: () => void;
  /** Called after any successful or failed write, with a toast message */
  onResult: (message: string, ok: boolean) => void;
}

const ACTIONS: { key: DrawerAction; icon: React.ReactNode; label: string }[] = [
  { key: 'count', icon: <ClipboardCheck size={14} />, label: 'Count' },
  { key: 'move', icon: <ArrowRightLeft size={14} />, label: 'Move' },
  { key: 'shipment', icon: <PackagePlus size={14} />, label: 'Shipment' },
  { key: 'report', icon: <AlertTriangle size={14} />, label: 'Report' },
  { key: 'fix', icon: <Wrench size={14} />, label: 'Fixed' },
];

const SUBMIT_LABEL: Record<DrawerAction, string> = {
  count: 'Save count',
  move: 'Move item',
  shipment: 'Add shipment',
  report: 'Submit report',
  fix: 'Mark fixed',
};

const ISSUE_OPTIONS: { key: ItemIssueType; label: string }[] = [
  { key: 'missing', label: 'Missing' },
  { key: 'damaged', label: 'Broken' },
  { key: 'expired', label: 'Expired' },
];

const FIX_OPTIONS: { key: ItemFixType; label: string }[] = [
  { key: 'refilled', label: 'Refilled' },
  { key: 'replaced', label: 'Changed out' },
  { key: 'fixed', label: 'Fixed' },
];

/**
 * Right-side drawer (full-width sheet on mobile) with every action a member
 * can take on the physical item in front of them: count/verify it, move it,
 * log a new shipment, report missing/broken/expired, or record a fix.
 */
export default function AuditActionDrawer({
  item,
  initialAction,
  actor,
  zoneLabel,
  onClose,
  onResult,
}: AuditActionDrawerProps) {
  const [action, setAction] = useState<DrawerAction>(initialAction);
  const [saving, setSaving] = useState(false);
  // Immutable opening snapshot: realtime receipts must never reset an entered count.
  const [baseline, setBaseline] = useState<InventoryItem | null>(item);
  const countItem = baseline ?? item;

  // Live location options (reflect admin org-config overrides).
  const { locations } = useOrgConfig();
  const AREA_OPTIONS = useMemo(
    // `getInventoryAreaOptions` reads the runtime store keyed by `locations`.
    () => { void locations; return getInventoryAreaOptions(); },
    [locations],
  );
  /** Top-level location names (no rooms) — e.g. "CPR Closet", "Shed" */
  const TOP_LEVEL_AREAS = useMemo(
    () => new Set(locations.filter((l) => l.rooms.length === 0).map((l) => l.name)),
    [locations],
  );

  // Count state
  const [countedBoxes, setCountedBoxes] = useState('');
  const [showSealedCount, setShowSealedCount] = useState(false);
  const [countedLoose, setCountedLoose] = useState('');
  const [condition, setCondition] = useState<ConditionValue>('Good');
  const [countExp, setCountExp] = useState('');
  const [countLot, setCountLot] = useState('');
  const [countNotes, setCountNotes] = useState('');

  // Move state
  const [moveLoc, setMoveLoc] = useState<StorageLocationRef | undefined>(undefined);
  const [moveArea, setMoveArea] = useState('');
  const [moveNote, setMoveNote] = useState('');

  // Shipment state
  const [shipQty, setShipQty] = useState(1);
  const [shipPerUnit, setShipPerUnit] = useState('');
  const [shipLot, setShipLot] = useState('');
  const [shipExp, setShipExp] = useState('');
  const [shipSupplier, setShipSupplier] = useState('');
  const [shipNotes, setShipNotes] = useState('');

  // Raw code from the last scan (either tab) — attributed on whichever
  // action ends up being submitted, so a scanned box is traceable in the
  // ledger even if the member switches tabs before confirming.
  const [scannedCode, setScannedCode] = useState('');

  // Report state
  const [issueType, setIssueType] = useState<ItemIssueType>('missing');
  const [issueQty, setIssueQty] = useState('');
  const [issueNotes, setIssueNotes] = useState('');

  // Fix state
  const [fixType, setFixType] = useState<ItemFixType>('refilled');
  const [fixQty, setFixQty] = useState('');
  const [fixNotes, setFixNotes] = useState('');

  const isAsset = item ? determineIsAsset(item) : false;
  const bag = useMemo(() => (countItem ? computeBagStock(countItem) : null), [countItem]);
  const systemBoxes = bag
    ? bag.hasBagTracking
      ? bag.totalBags
      : countItem?.unopenedBoxes ?? 0
    : 0;
  const status = item ? getItemStatus(item) : 'ok';
  const location = item ? displayLocation(item) : '';

  // Reset form state whenever a different item (or entry action) is opened
  useEffect(() => {
    if (!item) return;
    setBaseline(item);
    setAction(initialAction);
    setCountedBoxes('');
    setShowSealedCount(false);
    setCountedLoose('');
    setCondition('Good');
    setCountExp('');
    setCountLot('');
    setCountNotes('');
    setMoveLoc(item.storageLocation);
    setMoveArea('');
    setMoveNote('');
    setShipQty(1);
    setShipPerUnit(item.itemsPerBox ? String(item.itemsPerBox) : '');
    setShipLot('');
    setShipExp('');
    setShipSupplier('');
    setShipNotes('');
    setScannedCode('');
    setIssueType('missing');
    setIssueQty('');
    setIssueNotes('');
    setFixType('refilled');
    setFixQty('');
    setFixNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, initialAction]);

  if (!item || !actor || !countItem) return null;

  const baselineFingerprint = auditStockFingerprint(countItem);
  const stockChanged = auditStockFingerprint(item) !== baselineFingerprint;
  const observation = item.auditCountObservation;

  const packageSizes = new Set((countItem.batches ?? []).map(b => b.itemsPerBag).filter((n): n is number => !!n && n > 0));
  const missingSealedConversion = (countItem.batches ?? []).some(b => (b.bagCount ?? 0) > 0 && !(b.itemsPerBag && b.itemsPerBag > 0));
  const knownPackageSize = bag?.hasBagTracking
    ? !missingSealedConversion && packageSizes.size === 1 ? [...packageSizes][0] : undefined
    : countItem.itemsPerBox;
  const looseOnlyDefault = systemBoxes === 0 && (!knownPackageSize || knownPackageSize <= 1);
  const looseOnly = looseOnlyDefault && !showSealedCount;
  const validCount = countedLoose.trim() !== '' && (looseOnly || countedBoxes.trim() !== '') &&
    [Number(countedLoose), looseOnly ? 0 : Number(countedBoxes)].every(n => Number.isSafeInteger(n) && n >= 0);
  let countPlan: ReturnType<typeof buildAuditCountPlan> | null = null;
  if (validCount) {
    try {
      countPlan = buildAuditCountPlan(countItem, {
        countedBoxes: looseOnly ? 0 : Number(countedBoxes), countedLooseUnits: Number(countedLoose),
      });
    } catch {
      // A safe package count can still overflow after unit conversion.
      // Keep submission disabled; the writer enforces the same bounds.
    }
  }
  const countSummary = countPlan
    ? looseOnly ? `${countPlan.loose} units`
      : knownPackageSize ? `${countPlan.boxes} ${bag?.hasBagTracking ? 'bags' : 'boxes'} × ${knownPackageSize} + ${countPlan.loose} loose = ${countPlan.total ?? 'unknown'} units`
        : `${countPlan.boxes} sealed + ${countPlan.loose} loose — total units unknown`
    : 'Enter the quantities you observed, including zero.';
  const perUnitNum = Math.max(1, Number(shipPerUnit) || 1);

  const canSubmit =
    action === 'move'
      ? Boolean(moveLoc?.zoneId || moveArea)
      : action === 'shipment'
        ? shipQty > 0
        : action === 'count' ? isAsset || countPlan !== null : true;

  const handleSubmit = async (reconcileCount = false) => {
    if (saving || !canSubmit || (action === 'count' && stockChanged)) return;
    setSaving(true);
    try {
      if (action === 'count') {
        const result = await submitAuditEntries(
          [
            {
              itemId: item.id,
              expectedStockFingerprint: baselineFingerprint,
              reconcileCount,
              countedBoxes: isAsset ? undefined : looseOnly ? 0 : Number(countedBoxes),
              countedLooseUnits: isAsset ? undefined : Number(countedLoose),
              condition,
              notes: countNotes || undefined,
              expirationDate: countExp || undefined,
              lotNumber: countLot || undefined,
              scannedBarcode: scannedCode || undefined,
            },
          ],
          [countItem],
          { uid: actor.uid, email: actor.email ?? null, displayName: actor.name },
          zoneLabel
        );
        onResult(
          isAsset
            ? `${item.name} verified`
            : `${item.name}: ${countSummary}${result.unresolved ? ' — unresolved observation' : reconcileCount ? ' — corrected and verified' : result.variances ? ' — variance recorded; verification pending' : ' — verified'}`,
          true
        );
      } else if (action === 'move') {
        const dest: {
          storageLocation?: StorageLocationRef | null;
          location?: LocationType;
          room?: HQRoom | null;
        } = {};
        if (moveArea) {
          if (TOP_LEVEL_AREAS.has(moveArea)) {
            dest.location = moveArea as LocationType;
            dest.room = null;
          } else {
            // Use the room's actual site, not a hardcoded 'HQ'.
            const site = locations.find((l) => l.rooms.some((r) => r.name === moveArea));
            dest.location = (site?.name ?? 'HQ') as LocationType;
            dest.room = moveArea as HQRoom;
          }
        }
        if (moveLoc?.zoneId) {
          dest.storageLocation = moveLoc;
        } else if (moveArea && item.storageLocation) {
          // Quick-area move away from a structured spot: clear the stale ref
          dest.storageLocation = null;
        }
        await moveItemLocation(item, dest, actor, moveNote || undefined);
        onResult(`${item.name} moved`, true);
      } else if (action === 'shipment') {
        await addShipment(
          item,
          {
            qty: shipQty,
            perUnit: perUnitNum,
            lotNumber: shipLot || undefined,
            expirationMonth: shipExp || undefined,
            supplier: shipSupplier || undefined,
            notes: shipNotes || undefined,
            scannedBarcode: scannedCode || undefined,
            // Fresh per-submission token so rapid identical scans (several
            // cases of the same SKU) are never mistaken for a double-tap —
            // see the ShipmentInput/HR-8 comment in audit-actions.ts.
            idempotencyKey: crypto.randomUUID(),
          },
          actor
        );
        onResult(`Shipment added — ${shipQty} × ${perUnitNum} units`, true);
      } else if (action === 'report') {
        await reportItemIssue(
          item,
          {
            issueType,
            quantity: issueQty ? Number(issueQty) : undefined,
            notes: issueNotes || undefined,
          },
          actor
        );
        onResult(`${item.name} reported ${issueType}`, true);
      } else {
        await recordItemFix(
          item,
          {
            fixType,
            quantity: fixQty ? Number(fixQty) : undefined,
            notes: fixNotes || undefined,
          },
          actor
        );
        onResult(`${item.name} marked ${fixType}`, true);
      }
      onClose();
    } catch (e) {
      onResult(e instanceof Error ? e.message : 'Action failed', false);
    }
    setSaving(false);
  };

  const pillToggle = <T extends string>(
    options: { key: T; label: string }[],
    value: T,
    onChange: (v: T) => void
  ) => (
    <div className="flex bg-content2 rounded-large p-1 gap-1">
      {options.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`flex-1 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
            value === key ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content3'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <PanelShell isOpen onClose={onClose} ariaLabel={`Audit actions for ${item.name}`}>
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <CategoryBadge category={item.category} />
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">
                  {item.name}
                </div>
                <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                  <MapPin size={11} className="flex-none" />
                  <span className="truncate">{location || 'No location set'}</span>
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Status chips */}
          <div className="flex gap-1.5 flex-wrap mt-4">
            {status === 'expired' && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
            {status === 'out' && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
            {status === 'low' && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
            {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
            {item.auditCondition && item.auditCondition !== 'Good' && (
              <Chip size="sm" variant="flat" color="warning">{item.auditCondition}</Chip>
            )}
            {isAsset && <Chip size="sm" variant="flat" color="primary">Asset</Chip>}
          </div>

          {/* Action switcher — icon over label so it stays legible one-handed on mobile */}
          <div className="flex bg-content2 rounded-large p-1 gap-1 mt-4">
            {ACTIONS.map(({ key, icon, label }) => (
              <button
                key={key}
                onClick={() => setAction(key)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 px-1 py-1.5 rounded-medium text-xs font-semibold transition-colors duration-150 ${
                  action === key ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content3'
                }`}
              >
                {icon}
                <span className="leading-none whitespace-nowrap">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {action === 'count' && (
            <>
              <div className="flex gap-3">
                <div className="min-w-0 flex-1 bg-content2 rounded-large p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
                    {isAsset ? 'Status' : 'Expected sealed packages'}
                  </div>
                  <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
                    {isAsset ? (item.assetStatus || '—') : systemBoxes}
                  </div>
                </div>
                {!isAsset && (
                  <div className="flex-1 bg-content2 rounded-large p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
                      Total Units
                    </div>
                    <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground">
                      {systemBoxes > 0 && !knownPackageSize ? 'Unknown' : bag?.totalItems ?? 0}
                    </div>
                  </div>
                )}
              </div>

              {!isAsset && (
                <div>
                  {stockChanged && <p role="alert" className="mb-3 text-sm text-danger">Stock changed while this count was open. Your input is preserved. Close and reopen to recount against current stock.</p>}
                  <Button size="sm" variant="flat" className="mb-3 max-w-full whitespace-normal h-auto py-2"
                    isDisabled={stockChanged} onPress={() => {
                      setCountedBoxes(String(systemBoxes));
                      setCountedLoose(String(bag?.totalLoose ?? 0));
                    }}>
                    Matches expected ({systemBoxes > 0 && !knownPackageSize ? `${systemBoxes} sealed + ${bag?.totalLoose ?? 0} loose` : `${bag?.totalItems ?? 0} units`})
                  </Button>
                  <p className="mb-3 text-xs text-foreground-500">Confirm only after physically counting, or enter your observed quantities below.</p>
                  {observation?.status === 'unresolved' && (
                    <div className="mb-3 p-3 rounded-large bg-warning-50 text-sm" data-testid="saved-audit-variance">
                      <p className="font-semibold">Unresolved count recorded</p>
                      <p>Expected: {observation.expected.boxes} sealed + {observation.expected.loose} loose ({observation.expected.total ?? 'unknown'} units)</p>
                      <p>Observed: {observation.observed.boxes} sealed + {observation.observed.loose} loose ({observation.observed.total ?? 'unknown'} units)</p>
                      <p>Delta: {observation.delta.total ?? 'unknown'} units; {observation.delta.boxes} sealed, {observation.delta.loose} loose</p>
                      {observation.stockFingerprint === baselineFingerprint ? (
                        <Button size="sm" variant="flat" className="mt-2" onPress={() => {
                          setShowSealedCount(observation.observed.boxes > 0);
                          setCountedBoxes(String(observation.observed.boxes));
                          setCountedLoose(String(observation.observed.loose));
                        }}>Use recorded observation</Button>
                      ) : <p>Stock has changed since this observation. Count again before correcting.</p>}
                    </div>
                  )}
                  {looseOnly && (
                    <button type="button" onClick={() => setShowSealedCount(true)}
                      className="mb-3 text-sm font-semibold text-primary underline underline-offset-2">
                      Also count sealed packages
                    </button>
                  )}
                  {!looseOnly && (
                    <Input type="number" min={0} step={1} label="Sealed boxes / bags observed"
                      value={countedBoxes} onValueChange={setCountedBoxes} placeholder="Enter count" />
                  )}
                  <Input type="number" min={0} step={1}
                    label={looseOnly ? 'Individual units observed' : 'Loose units observed'}
                    value={countedLoose} onValueChange={setCountedLoose} placeholder="Enter count"
                    className={looseOnly ? '' : 'mt-3'} />
                  <div className="mt-2 text-sm text-foreground-600">{countSummary}</div>
                  {countPlan && <div className="mt-2 text-sm" data-testid="audit-count-comparison">
                    <p>Expected {countPlan.systemTotal ?? 'unknown'} units · Observed {countPlan.total ?? 'unknown'} units · Delta {countPlan.total !== null && countPlan.systemTotal !== null ? countPlan.total - countPlan.systemTotal : 'unknown'} units</p>
                    <p className="text-xs text-foreground-500">Expected {countPlan.systemBoxes} sealed + {countPlan.systemLoose} loose · Observed {countPlan.boxes} sealed + {countPlan.loose} loose · Delta {countPlan.boxes - countPlan.systemBoxes} sealed, {countPlan.loose - countPlan.systemLoose} loose</p>
                  </div>}
                  {countPlan && !countPlan.canReconcile && <p className="mt-2 text-xs text-warning">Lot allocation or package conversion is ambiguous. Record this observation and reconcile the lot details separately.</p>}
                  {countPlan?.variance && countPlan.canReconcile && <Button className="mt-3 max-w-full whitespace-normal h-auto py-2" color="warning" variant="flat" isDisabled={saving || stockChanged} onPress={() => handleSubmit(true)}>Apply observed count to stock</Button>}
                  {countPlan && (countPlan.variance || countPlan.unresolved) && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-warning font-semibold">
                      <AlertTriangle size={12} className="flex-none" />
                      {countPlan.unresolved ? 'Unresolved observation — quantities need reconciliation.' : 'Count differs from system — recorded without verification.'}
                    </div>
                  )}
                </div>
              )}

              <ConditionToggle value={condition} onChange={setCondition} label="Condition" />

              {!isAsset && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    type="month"
                    size="sm"
                    label="Earliest expiration"
                    value={countExp}
                    onValueChange={setCountExp}
                  />
                  <Input
                    size="sm"
                    label="Lot / Batch #"
                    value={countLot}
                    onValueChange={setCountLot}
                    placeholder="Optional"
                  />
                </div>
              )}

              <Textarea
                label="Notes (optional)"
                placeholder="Any observations…"
                value={countNotes}
                onValueChange={setCountNotes}
                size="sm"
                minRows={2}
              />
            </>
          )}

          {action === 'move' && (
            <>
              <div className="bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
                  Current Location
                </div>
                <div className="text-sm font-semibold text-foreground">
                  {location || 'No location set'}
                </div>
              </div>

              <StorageLocationPicker
                value={moveLoc}
                onChange={setMoveLoc}
                label="New storage spot (zone › shelf › container)"
              />

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  Or quick area
                </p>
                <Select
                  size="sm"
                  aria-label="Quick area"
                  selectedKeys={[moveArea || '__keep__']}
                  onSelectionChange={(keys) => {
                    const selected = Array.from(keys)[0] as string | undefined;
                    setMoveArea(!selected || selected === '__keep__' ? '' : selected);
                  }}
                  className="w-full"
                >
                  {[{ value: '__keep__', label: 'Keep current area' }, ...AREA_OPTIONS].map((o) => (
                    <SelectItem key={o.value}>{o.label}</SelectItem>
                  ))}
                </Select>
              </div>

              <Input
                size="sm"
                label="Note (optional)"
                placeholder="e.g. moved into blue tote during reorg"
                value={moveNote}
                onValueChange={setMoveNote}
              />
            </>
          )}

          {action === 'shipment' && (
            <>
              <ScannerInput
                compact
                showLastScan={false}
                label="Scan case barcode to prefill lot/expiry"
                placeholder="Scan or type the case barcode..."
                onScan={(code) => {
                  setScannedCode(code);
                  const gs1 = parseGs1Barcode(code);
                  if (gs1.lot) setShipLot(gs1.lot);
                  if (gs1.expiration) setShipExp(gs1.expiration.slice(0, 7));
                }}
              />
              {scannedCode && (
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                  <PackagePlus size={12} className="flex-none" />
                  Scanned <span className="font-mono">{scannedCode}</span> — prefilled from GS1 data where available
                </div>
              )}

              <div>
                <label className="text-sm font-semibold text-foreground block mb-2">
                  Sealed boxes/bags received
                </label>
                <CountControl
                  value={shipQty}
                  onChange={setShipQty}
                  label=""
                  min={1}
                  presets={[1, 5, 10]}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  type="number"
                  size="sm"
                  label="Units per box/bag"
                  value={shipPerUnit}
                  onValueChange={setShipPerUnit}
                  placeholder="e.g. 10"
                />
                <Input
                  size="sm"
                  label="Lot / Batch #"
                  value={shipLot}
                  onValueChange={setShipLot}
                  placeholder="Optional"
                />
                <Input
                  type="month"
                  size="sm"
                  label="Expiration"
                  value={shipExp}
                  onValueChange={setShipExp}
                />
                <Input
                  size="sm"
                  label="Supplier"
                  value={shipSupplier}
                  onValueChange={setShipSupplier}
                  placeholder="Optional"
                />
              </div>

              <div className="bg-content2 rounded-large p-3 text-sm text-foreground-600">
                Adds{' '}
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {shipQty * perUnitNum}
                </span>{' '}
                units as a sealed batch.
              </div>

              <Textarea
                label="Notes (optional)"
                value={shipNotes}
                onValueChange={setShipNotes}
                size="sm"
                minRows={2}
              />
            </>
          )}

          {action === 'report' && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  What&apos;s wrong?
                </p>
                {pillToggle(ISSUE_OPTIONS, issueType, setIssueType)}
              </div>

              <Input
                type="number"
                size="sm"
                label="How many affected (optional)"
                value={issueQty}
                onValueChange={setIssueQty}
                placeholder="e.g. 3"
              />

              <Textarea
                label="Details"
                placeholder="What did you find?"
                value={issueNotes}
                onValueChange={setIssueNotes}
                size="sm"
                minRows={3}
              />

              <div className="bg-content2 rounded-large p-3 text-xs text-foreground-500">
                Creates a tracked issue report for the quartermasters and stamps
                this item&apos;s condition.
              </div>
            </>
          )}

          {action === 'fix' && (
            <>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  What did you do?
                </p>
                {pillToggle(FIX_OPTIONS, fixType, setFixType)}
              </div>

              <Input
                type="number"
                size="sm"
                label="How many (optional)"
                value={fixQty}
                onValueChange={setFixQty}
                placeholder="e.g. 2"
              />

              <Textarea
                label="Notes (optional)"
                placeholder="e.g. refilled gauze from back stock"
                value={fixNotes}
                onValueChange={setFixNotes}
                size="sm"
                minRows={2}
              />

              <div className="bg-content2 rounded-large p-3 text-xs text-foreground-500">
                Logs the fix so refills and change-outs are trackable, and clears
                any Damaged/Expired flag on this item.
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex gap-3">
          <Button variant="bordered" className="flex-1" onPress={onClose}>
            Cancel
          </Button>
          <Button
            color="primary"
            className="flex-1"
            onPress={() => handleSubmit()}
            isLoading={saving}
            isDisabled={!canSubmit || (action === 'count' && stockChanged)}
          >
            {SUBMIT_LABEL[action]}
          </Button>
        </div>
    </PanelShell>
  );
}
