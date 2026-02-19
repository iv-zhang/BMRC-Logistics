'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Input,
  Select,
  SelectItem,
  Slider,
  Textarea,
  Chip,
  Progress,
  ScrollShadow,
  Tabs,
  Tab,
} from '@heroui/react';
import { AlertCircle, CheckCircle2, Clock, ClipboardCheck, Package, Info, Search } from 'lucide-react';
import type { InventoryItem, Statpack, StatpackPocket, AssetCheckResult, StatpackAuditResult } from '@/app/types';
import { performAssetManualCheck, performStatpackManualAudit } from '@/app/lib/inventory';

interface AdminAuditModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  auditType: 'asset' | 'statpack';
  targetAsset?: InventoryItem | null;
  targetStatpack?: Statpack | null;
  userId: string;
  userName?: string;
  onAuditComplete?: () => void;
}

const pocketOrder: { key: StatpackPocket; label: string }[] = [
  { key: 'main', label: 'Main' },
  { key: 'front_aux', label: 'Front' },
  { key: 'side_left', label: 'Left' },
  { key: 'side_right', label: 'Right' },
];

export default function AdminAuditModal({
  isOpen,
  onOpenChange,
  auditType,
  targetAsset,
  targetStatpack,
  userId,
  userName,
  onAuditComplete,
}: AdminAuditModalProps) {
  const [step, setStep] = useState<'input' | 'review' | 'complete'>('input');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AssetCheckResult | StatpackAuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Asset audit fields
  const [batteryPct, setBatteryPct] = useState<number>(50);
  const [o2Psi, setO2Psi] = useState<number>(1000);
  const [assetCondition, setAssetCondition] = useState<'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance'>('Good');
  const [assetNotes, setAssetNotes] = useState('');
  const [dueDateStr, setDueDateStr] = useState('');

  // Statpack audit fields
  const [contentChecks, setContentChecks] = useState<
    Array<{
      itemId: string;
      requiredQuantity: number;
      foundQuantity: number;
      actualLocation: StatpackPocket | 'missing';
      condition: 'good' | 'minor_issue' | 'major_issue' | 'needs_replacement' | 'battery_low';
      expirationStatus: 'valid' | 'expiring_soon' | 'expired' | 'not_applicable';
      notes?: string;
    }>
  >([]);
  const [statpackNotes, setStatpackNotes] = useState('');
  const [selectedPocket, setSelectedPocket] = useState<StatpackPocket | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // -- FIX: depend on targetStatpack.id so items re-init when switching packs --
  useEffect(() => {
    if (!isOpen) return;
    if (auditType === 'statpack' && targetStatpack) {
      const initialChecks = (targetStatpack.contents || []).map((item) => ({
        itemId: item.itemId,
        requiredQuantity: item.requiredQuantity || 1,
        foundQuantity: item.requiredQuantity || 1,
        actualLocation: item.pocket || 'main',
        condition: 'good' as const,
        expirationStatus: 'valid' as const,
      }));
      setContentChecks(initialChecks);
      setSelectedPocket('all');
      setSearchQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, auditType, targetStatpack?.id]);

  // -- Pocket-based filtering --
  const visibleItems = useMemo(() => {
    if (!targetStatpack?.contents) return [];
    return contentChecks.map((check, idx) => {
      const item = targetStatpack.contents?.find((c) => c.itemId === check.itemId);
      const pocket = item?.pocket || 'main';
      return { check, idx, item, pocket };
    }).filter(({ pocket, item }) => {
      const matchesPocket = selectedPocket === 'all' || pocket === selectedPocket;
      const matchesSearch = !searchQuery ||
        (item?.itemDetails?.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item?.itemId || '').toLowerCase().includes(searchQuery.toLowerCase());
      return matchesPocket && matchesSearch;
    });
  }, [contentChecks, selectedPocket, targetStatpack?.contents, searchQuery]);

  const verifiedCount = contentChecks.filter(
    (c) => c.actualLocation !== 'missing' &&
           c.condition === 'good' &&
           (c.expirationStatus === 'valid' || c.expirationStatus === 'not_applicable') &&
           c.foundQuantity >= c.requiredQuantity,
  ).length;

  const progress = contentChecks.length > 0 ? Math.round((verifiedCount / contentChecks.length) * 100) : 0;

  const handleMarkAllOk = () => {
    setContentChecks((prev) =>
      prev.map((c) => {
        const item = targetStatpack?.contents?.find((it) => it.itemId === c.itemId);
        return {
          ...c,
          foundQuantity: c.requiredQuantity,
          actualLocation: item?.pocket || 'main',
          condition: 'good' as const,
          expirationStatus: 'valid' as const,
        };
      }),
    );
  };

  const handleSubmitAssetAudit = async () => {
    if (!targetAsset) return;
    setSubmitting(true);
    setError(null);
    try {
      const dueNext = dueDateStr ? new Date(dueDateStr) : undefined;
      const auditResult = await performAssetManualCheck({
        itemId: targetAsset.id,
        measuredBatteryPct: targetAsset.assetCategory === 'AED' ? batteryPct : undefined,
        measuredO2Psi: targetAsset.isOxygen ? o2Psi : undefined,
        condition: assetCondition,
        notes: assetNotes,
        dueNextDate: dueNext,
        user: { id: userId, fullName: userName },
      });
      setResult(auditResult);
      setStep('review');
    } catch (e) {
      setError((e as Error)?.message || 'Failed to complete asset audit');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitStatpackAudit = async () => {
    if (!targetStatpack) return;
    setSubmitting(true);
    setError(null);
    try {
      // Convert new format to old format expected by the API
      const legacyContentChecks = contentChecks.map(check => ({
        itemId: check.itemId,
        requiredQuantity: check.requiredQuantity,
        foundQuantity: check.foundQuantity,
        inCorrectPocket: check.actualLocation !== 'missing' && check.actualLocation === (targetStatpack.contents?.find(c => c.itemId === check.itemId)?.pocket || 'main'),
        conditionOk: check.condition === 'good',
        expirationOk: check.expirationStatus === 'valid' || check.expirationStatus === 'not_applicable',
        notes: check.notes,
      }));

      const auditResult = await performStatpackManualAudit({
        statpackId: targetStatpack.id,
        contentChecks: legacyContentChecks,
        overallNotes: statpackNotes,
        user: { id: userId, fullName: userName },
      });
      setResult(auditResult);
      setStep('review');
    } catch (e) {
      setError((e as Error)?.message || 'Failed to complete statpack audit');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setStep('input');
    setResult(null);
    setError(null);
    setBatteryPct(50);
    setO2Psi(1000);
    setAssetCondition('Good');
    setAssetNotes('');
    setDueDateStr('');
    setContentChecks([]);
    setStatpackNotes('');
    setSelectedPocket('all');
    setSearchQuery('');
    onOpenChange(false);
    onAuditComplete?.();
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          {auditType === 'asset' ? (
            <>
              <Package size={18} /> Asset Manual Audit
            </>
          ) : (
            <>
              <ClipboardCheck size={18} /> Statpack Contents Audit
            </>
          )}
        </ModalHeader>

        <ModalBody className="gap-4">
          {step === 'input' && (
            <>
              {/* ── Asset Audit Form ── */}
              {auditType === 'asset' && targetAsset && (
                <>
                  <Card className="bg-blue-50 dark:bg-blue-950/30">
                    <CardBody className="p-3">
                      <p className="font-semibold text-sm">{targetAsset.name}</p>
                      {targetAsset.assetSerial && (
                        <p className="text-xs text-default-500">Serial: {targetAsset.assetSerial}</p>
                      )}
                    </CardBody>
                  </Card>

                  <div className="gap-3 flex flex-col">
                    {targetAsset.assetCategory === 'AED' && (
                      <div>
                        <label className="text-sm font-semibold">Measured Battery Level (%)</label>
                        <Slider
                          value={batteryPct}
                          onChange={(val) => setBatteryPct(val as number)}
                          minValue={0}
                          maxValue={100}
                          step={5}
                          className="mt-1"
                        />
                        <p className="text-xs text-default-500 mt-1">{batteryPct}%</p>
                      </div>
                    )}

                    {targetAsset.isOxygen && (
                      <div>
                        <label className="text-sm font-semibold">Measured O2 PSI</label>
                        <Slider
                          value={o2Psi}
                          onChange={(val) => setO2Psi(val as number)}
                          minValue={0}
                          maxValue={2000}
                          step={50}
                          className="mt-1"
                        />
                        <p className="text-xs text-default-500 mt-1">{o2Psi} PSI</p>
                      </div>
                    )}

                    <Select
                      label="Asset Condition"
                      selectedKeys={[assetCondition]}
                      onChange={(e) => setAssetCondition(e.target.value as 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance')}
                    >
                      <SelectItem key="Good">Good</SelectItem>
                      <SelectItem key="Minor Issue">Minor Issue</SelectItem>
                      <SelectItem key="Major Issue">Major Issue</SelectItem>
                      <SelectItem key="Needs Maintenance">Needs Maintenance</SelectItem>
                    </Select>

                    <Textarea
                      label="Notes (optional)"
                      placeholder="e.g., Battery slightly low, pads need replacement soon"
                      value={assetNotes}
                      onValueChange={setAssetNotes}
                      rows={3}
                    />

                    <Input
                      type="date"
                      label="Schedule Next Check (optional)"
                      value={dueDateStr}
                      onChange={(e) => setDueDateStr(e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* ── Statpack Audit Form ── */}
              {auditType === 'statpack' && targetStatpack && (
                <>
                  {/* Header card */}
                  <Card className="bg-blue-50 dark:bg-blue-950/30">
                    <CardBody className="p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-sm">{targetStatpack.name}</p>
                        <Chip size="sm" variant="flat" color={progress === 100 ? 'success' : 'warning'}>
                          {verifiedCount}/{contentChecks.length} OK
                        </Chip>
                      </div>
                      <Progress
                        aria-label="Audit progress"
                        value={progress}
                        color={progress === 100 ? 'success' : 'primary'}
                        size="sm"
                      />
                    </CardBody>
                  </Card>

                  {/* Quick actions and search */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="flat" color="success" onPress={handleMarkAllOk}>
                        <CheckCircle2 size={14} className="mr-1" /> Mark All OK
                      </Button>
                      <div className="text-xs text-default-500 flex items-center gap-1">
                        <Info size={12} /> Select status per item below
                      </div>
                    </div>
                    <Input
                      size="sm"
                      placeholder="Search items..."
                      value={searchQuery}
                      onValueChange={setSearchQuery}
                      className="sm:max-w-xs"
                      startContent={<Search size={16} />}
                    />
                  </div>

                  {/* Pocket tabs */}
                  <Tabs
                    aria-label="Pocket filter"
                    selectedKey={selectedPocket}
                    onSelectionChange={(k) => setSelectedPocket(k as StatpackPocket | 'all')}
                    variant="underlined"
                    classNames={{
                      tabList: 'flex gap-1 overflow-x-auto',
                      tab: 'min-w-fit'
                    }}
                  >
                    <Tab key="all" title={`All (${visibleItems.length})`} />
                    {pocketOrder.map(({ key, label }) => {
                      const count = visibleItems.filter(({ pocket }) => pocket === key).length;
                      return (
                        <Tab key={key} title={`${label} (${count})`} />
                      );
                    })}
                  </Tabs>

                  {/* Items list */}
                  <ScrollShadow className="max-h-[50vh]">
                    <div className="flex flex-col gap-3">
                      {visibleItems.length === 0 && (
                        <p className="text-sm text-default-400 text-center py-4">
                          {searchQuery ? 'No items match your search.' : 'No items in this pocket.'}
                        </p>
                      )}
                      {visibleItems.map(({ check, idx, item }) => {
                        const isCorrectLocation = check.actualLocation === (item?.pocket || 'main');
                        const isGoodCondition = check.condition === 'good';
                        const isValidExpiration = check.expirationStatus === 'valid' || check.expirationStatus === 'not_applicable';
                        const allOk = isCorrectLocation && isGoodCondition && isValidExpiration && check.foundQuantity >= check.requiredQuantity;

                        return (
                          <Card
                            key={`${check.itemId}-${idx}`}
                            className={`border ${allOk ? 'border-success-200 bg-success-50/30 dark:bg-success-950/20' : 'border-warning-200 bg-warning-50/30 dark:bg-warning-950/20'}`}
                          >
                            <CardBody className="gap-3 p-3 sm:p-4">
                              {/* Item header */}
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  {allOk ? (
                                    <CheckCircle2 size={18} className="text-success shrink-0" />
                                  ) : (
                                    <AlertCircle size={18} className="text-warning shrink-0" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <span className="font-medium text-sm block truncate">
                                      {item?.itemDetails?.name || check.itemId}
                                    </span>
                                    <span className="text-xs text-default-500">
                                      Required: {check.requiredQuantity}
                                    </span>
                                  </div>
                                </div>
                                <Chip size="sm" variant="flat" color="default">
                                  {item?.pocket ? String(item.pocket).replace('_', ' ') : 'main'}
                                </Chip>
                              </div>

                              {/* Verification fields - mobile-friendly grid */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                <Input
                                  size="sm"
                                  type="number"
                                  label="Found Quantity"
                                  labelPlacement="outside"
                                  value={String(check.foundQuantity)}
                                  classNames={{ label: 'text-xs font-medium' }}
                                  onChange={(e) => {
                                    const updated = [...contentChecks];
                                    updated[idx].foundQuantity = Number(e.target.value) || 0;
                                    setContentChecks(updated);
                                  }}
                                />

                                <Select
                                  size="sm"
                                  label="Actual Location"
                                  labelPlacement="outside"
                                  selectedKeys={[check.actualLocation]}
                                  classNames={{ label: 'text-xs font-medium' }}
                                  onChange={(e) => {
                                    const updated = [...contentChecks];
                                    updated[idx].actualLocation = e.target.value as StatpackPocket | 'missing';
                                    setContentChecks(updated);
                                  }}
                                >
                                  <SelectItem key="main">Main Pocket</SelectItem>
                                  <SelectItem key="front_aux">Front Pocket</SelectItem>
                                  <SelectItem key="side_left">Left Pocket</SelectItem>
                                  <SelectItem key="side_right">Right Pocket</SelectItem>
                                  <SelectItem key="missing">Missing</SelectItem>
                                </Select>

                                <Select
                                  size="sm"
                                  label="Condition"
                                  labelPlacement="outside"
                                  selectedKeys={[check.condition]}
                                  classNames={{ label: 'text-xs font-medium' }}
                                  onChange={(e) => {
                                    const updated = [...contentChecks];
                                    updated[idx].condition = e.target.value as 'good' | 'minor_issue' | 'major_issue' | 'needs_replacement' | 'battery_low';
                                    setContentChecks(updated);
                                  }}
                                >
                                  <SelectItem key="good">Good</SelectItem>
                                  <SelectItem key="minor_issue">Minor Issue</SelectItem>
                                  <SelectItem key="major_issue">Major Issue</SelectItem>
                                  <SelectItem key="needs_replacement">Needs Replacement</SelectItem>
                                  <SelectItem key="battery_low">Battery Low</SelectItem>
                                </Select>

                                <Select
                                  size="sm"
                                  label="Expiration"
                                  labelPlacement="outside"
                                  selectedKeys={[check.expirationStatus]}
                                  classNames={{ label: 'text-xs font-medium' }}
                                  onChange={(e) => {
                                    const updated = [...contentChecks];
                                    updated[idx].expirationStatus = e.target.value as 'valid' | 'expiring_soon' | 'expired' | 'not_applicable';
                                    setContentChecks(updated);
                                  }}
                                >
                                  <SelectItem key="valid">Valid</SelectItem>
                                  <SelectItem key="expiring_soon">Expiring Soon</SelectItem>
                                  <SelectItem key="expired">Expired</SelectItem>
                                  <SelectItem key="not_applicable">N/A</SelectItem>
                                </Select>
                              </div>

                              {/* Status indicators */}
                              <div className="flex flex-wrap gap-2">
                                {!isCorrectLocation && (
                                  <Chip size="sm" variant="flat" color="warning">
                                    Misplaced
                                  </Chip>
                                )}
                                {!isGoodCondition && (
                                  <Chip size="sm" variant="flat" color="danger">
                                    {check.condition.replace('_', ' ')}
                                  </Chip>
                                )}
                                {!isValidExpiration && check.expirationStatus !== 'not_applicable' && (
                                  <Chip size="sm" variant="flat" color="danger">
                                    {check.expirationStatus.replace('_', ' ')}
                                  </Chip>
                                )}
                                {item?.expirationDate && new Date(item.expirationDate).getTime() < Date.now() && (
                                  <Chip size="sm" variant="flat" color="danger">
                                    Actually Expired: {new Date(item.expirationDate).toLocaleDateString()}
                                  </Chip>
                                )}
                              </div>
                            </CardBody>
                          </Card>
                        );
                      })}
                    </div>
                  </ScrollShadow>

                  <Textarea
                    label="Overall Notes (optional)"
                    placeholder="e.g., Found missing item, reordered contents"
                    value={statpackNotes}
                    onValueChange={setStatpackNotes}
                    rows={2}
                  />
                </>
              )}

              {error && (
                <Card className="bg-danger-50 border border-danger-200">
                  <CardBody className="p-2">
                    <p className="text-xs text-danger">{error}</p>
                  </CardBody>
                </Card>
              )}
            </>
          )}

          {step === 'review' && result && (
            <>
              {auditType === 'asset' && 'measuredBatteryPct' in result && (
                <Card className={result.actionRequired ? 'bg-warning-50' : 'bg-success-50'}>
                  <CardBody className="gap-2 p-3">
                    <div className="flex items-center gap-2">
                      {result.actionRequired ? (
                        <AlertCircle className="text-warning" size={20} />
                      ) : (
                        <CheckCircle2 className="text-success" size={20} />
                      )}
                      <p className="font-semibold">
                        {result.actionRequired ? 'Action Required' : 'Audit Complete'}
                      </p>
                    </div>
                    <p className="text-sm">Condition: {result.condition}</p>
                    <p className="text-sm">Battery: {result.measuredBatteryPct ?? 'N/A'}%</p>
                    {result.measuredO2Psi !== undefined && <p className="text-sm">O2: {result.measuredO2Psi} PSI</p>}
                    {result.expirationWarnings && result.expirationWarnings.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold text-warning">Warnings:</p>
                        {result.expirationWarnings.map((w, idx) => (
                          <p key={idx} className="text-xs text-warning">{w.message}</p>
                        ))}
                      </div>
                    )}
                    {result.dueNextDate && (
                      <div className="flex items-center gap-1 text-xs text-default-500">
                        <Clock size={14} />
                        Next due: {new Date(result.dueNextDate).toLocaleDateString()}
                      </div>
                    )}
                  </CardBody>
                </Card>
              )}

              {auditType === 'statpack' && 'contentChecks' in result && (
                <Card className={result.actionRequired ? 'bg-warning-50' : 'bg-success-50'}>
                  <CardBody className="gap-2 p-3">
                    <div className="flex items-center gap-2">
                      {result.actionRequired ? (
                        <AlertCircle className="text-warning" size={20} />
                      ) : (
                        <CheckCircle2 className="text-success" size={20} />
                      )}
                      <p className="font-semibold">{result.condition}</p>
                    </div>
                    <p className="text-sm">{result.contentChecks.length} items verified</p>
                    {result.validationWarnings.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold text-warning">
                          {result.validationWarnings.length} warnings found
                        </p>
                        {result.validationWarnings.slice(0, 5).map((w, idx) => (
                          <p key={idx} className="text-xs text-warning truncate">{w.message}</p>
                        ))}
                      </div>
                    )}
                  </CardBody>
                </Card>
              )}
            </>
          )}
        </ModalBody>

        <ModalFooter>
          {step === 'input' && (
            <>
              <Button variant="light" onPress={handleClose}>
                Cancel
              </Button>
              <Button
                color="primary"
                onPress={auditType === 'asset' ? handleSubmitAssetAudit : handleSubmitStatpackAudit}
                isLoading={submitting}
              >
                Review & Complete
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button
                variant="light"
                onPress={() => {
                  setStep('input');
                  setError(null);
                }}
              >
                Edit
              </Button>
              <Button color="success" onPress={handleClose}>
                Done
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
