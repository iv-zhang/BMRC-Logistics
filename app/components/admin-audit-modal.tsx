'use client';

import React, { useState, useEffect } from 'react';
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
  Divider,
  Slider,
  Textarea,
  Chip,
} from '@heroui/react';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import type { InventoryItem, Statpack, AssetCheckResult, StatpackAuditResult } from '@/app/types';
import { performAssetManualCheck, performStatpackManualAudit } from '@/app/lib/inventory';
import { serverTimestamp } from 'firebase/firestore';

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
      inCorrectPocket: boolean;
      conditionOk: boolean;
      expirationOk: boolean;
      notes?: string;
    }>
  >([]);
  const [statpackNotes, setStatpackNotes] = useState('');

  useEffect(() => {
    if (auditType === 'statpack' && targetStatpack && contentChecks.length === 0) {
      const initialChecks = (targetStatpack.contents || []).map((item) => ({
        itemId: item.itemId,
        requiredQuantity: item.requiredQuantity || 1,
        foundQuantity: item.requiredQuantity || 1,
        inCorrectPocket: true,
        conditionOk: true,
        expirationOk: true,
      }));
      setContentChecks(initialChecks);
    }
  }, [auditType, targetStatpack, contentChecks.length]);

  const handleSubmitAssetAudit = async () => {
    if (!targetAsset) return;
    setSubmitting(true);
    setError(null);
    try {
      const dueNext = dueDateStr ? new Date(dueDateStr) : undefined;
      const auditResult = await performAssetManualCheck({
        itemId: targetAsset.id,
        measuredBatteryPct: batteryPct,
        measuredO2Psi: targetAsset.isOxygen ? o2Psi : undefined,
        condition: assetCondition,
        notes: assetNotes,
        dueNextDate: dueNext,
        user: { id: userId, fullName: userName },
      });
      setResult(auditResult);
      setStep('review');
    } catch (e) {
      setError((e as any)?.message || 'Failed to complete audit');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitStatpackAudit = async () => {
    if (!targetStatpack) return;
    setSubmitting(true);
    setError(null);
    try {
      const auditResult = await performStatpackManualAudit({
        statpackId: targetStatpack.id,
        contentChecks,
        overallNotes: statpackNotes,
        user: { id: userId, fullName: userName },
      });
      setResult(auditResult);
      setStep('review');
    } catch (e) {
      setError((e as any)?.message || 'Failed to complete audit');
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
    onOpenChange(false);
    onAuditComplete?.();
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          {auditType === 'asset' ? '🔧 Asset Manual Audit' : '📦 Statpack Contents Audit'}
        </ModalHeader>

        <ModalBody className="gap-4">
          {step === 'input' && (
            <>
              {/* Asset Audit Form */}
              {auditType === 'asset' && targetAsset && (
                <>
                  <Card className="bg-blue-50 dark:bg-blue-950/30">
                    <CardBody className="p-3">
                      <p className="font-semibold text-sm">{targetAsset.name}</p>
                      {targetAsset.assetSerial && <p className="text-xs text-default-500">Serial: {targetAsset.assetSerial}</p>}
                    </CardBody>
                  </Card>

                  <div className="gap-3 flex flex-col">
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
                      onChange={(e) => setAssetCondition(e.target.value as any)}
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

              {/* Statpack Audit Form */}
              {auditType === 'statpack' && targetStatpack && (
                <>
                  <Card className="bg-blue-50 dark:bg-blue-950/30">
                    <CardBody className="p-3">
                      <p className="font-semibold text-sm">{targetStatpack.name}</p>
                      <p className="text-xs text-default-500">{contentChecks.length} items to verify</p>
                    </CardBody>
                  </Card>

                  <div className="gap-3 flex flex-col max-h-96 overflow-y-auto">
                    {contentChecks.map((check, idx) => {
                      const item = targetStatpack.contents?.find((c) => c.itemId === check.itemId);
                      return (
                        <Card key={`${check.itemId}-${idx}`} className="bg-default-100">
                          <CardBody className="gap-2 p-3">
                            <div className="flex items-start justify-between">
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-sm">{item?.itemDetails?.name || 'Unknown'}</p>
                                <p className="text-xs text-default-500">Required: {check.requiredQuantity}</p>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <Input
                                size="sm"
                                type="number"
                                label="Found"
                                value={String(check.foundQuantity)}
                                onChange={(e) => {
                                  const updated = [...contentChecks];
                                  updated[idx].foundQuantity = Number(e.target.value) || 0;
                                  setContentChecks(updated);
                                }}
                              />
                              <Select
                                size="sm"
                                label="Pocket"
                                selectedKeys={[check.inCorrectPocket ? 'yes' : 'no']}
                                onChange={(e) => {
                                  const updated = [...contentChecks];
                                  updated[idx].inCorrectPocket = e.target.value === 'yes';
                                  setContentChecks(updated);
                                }}
                              >
                                <SelectItem key="yes">Correct</SelectItem>
                                <SelectItem key="no">Wrong Place</SelectItem>
                              </Select>

                              <Select
                                size="sm"
                                label="Condition"
                                selectedKeys={[check.conditionOk ? 'ok' : 'bad']}
                                onChange={(e) => {
                                  const updated = [...contentChecks];
                                  updated[idx].conditionOk = e.target.value === 'ok';
                                  setContentChecks(updated);
                                }}
                              >
                                <SelectItem key="ok">Good</SelectItem>
                                <SelectItem key="bad">Issue</SelectItem>
                              </Select>

                              <Select
                                size="sm"
                                label="Expiration"
                                selectedKeys={[check.expirationOk ? 'ok' : 'expired']}
                                onChange={(e) => {
                                  const updated = [...contentChecks];
                                  updated[idx].expirationOk = e.target.value === 'ok';
                                  setContentChecks(updated);
                                }}
                              >
                                <SelectItem key="ok">Valid</SelectItem>
                                <SelectItem key="expired">Expired</SelectItem>
                              </Select>
                            </div>
                          </CardBody>
                        </Card>
                      );
                    })}
                  </div>

                  <Textarea
                    label="Overall Notes (optional)"
                    placeholder="e.g., Found missing item, reordered contents"
                    value={statpackNotes}
                    onValueChange={setStatpackNotes}
                    rows={3}
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
                <>
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
                </>
              )}

              {auditType === 'statpack' && 'contentChecks' in result && (
                <>
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
                          <p className="text-xs font-semibold text-warning">{result.validationWarnings.length} warnings found</p>
                          {result.validationWarnings.slice(0, 3).map((w, idx) => (
                            <p key={idx} className="text-xs text-warning truncate">{w.message}</p>
                          ))}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </>
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
