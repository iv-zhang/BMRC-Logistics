'use client';

import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Checkbox,
  Input,
  Divider,
  Chip,
} from '@heroui/react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { logStatpackCheckOff, verifyAssetAgainstRules } from '@/app/lib/inventory';
import { parseGs1Barcode } from '@/app/lib/gs1';
import type { Statpack, ValidationWarning } from '@/app/types';
import BarcodeScanner from './barcode-scanner';
import { ScanLine, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface StatpackCheckOffModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  statpack: Statpack | null;
  action: 'checkout' | 'checkin' | 'maintenance';
  userId: string;
  userName: string;
  onCheckOffComplete?: () => void;
  // When true, the modal is used for check-in "usage reporting":
  // allow members to check off only items they used and replaced.
  checkinUsageMode?: boolean;
  // Callback for quick check-in when user reports they used nothing.
  onQuickCheckIn?: () => void;
}

/**
 * Digital check-off sheet for statpacks.
 * 
 * Workflow:
 * 1. Show expected contents (from statpack.contents)
 * 2. User verifies each item by counting and clicking checkbox
 * 3. Record actual counts, seal checks, and O2 readings
 * 4. On submit, create structured statpack_log with checkEntries
 * 5. App tracks who checked off the bag (accountability)
 */
export default function StatpackCheckOffModal({
  isOpen,
  onOpenChange,
  statpack,
  action,
  userId,
  userName,
  onCheckOffComplete,
  checkinUsageMode,
  onQuickCheckIn,
}: StatpackCheckOffModalProps) {
  const { role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const [checkCounts, setCheckCounts] = useState<Record<string, number>>({});
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [sealChecks, setSealChecks] = useState<
    Record<string, { sealed: boolean; sealNumber?: string }>
  >({});
  const [oxygenReadings, setOxygenReadings] = useState<Record<string, string>>({});
  
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inlineAlert, setInlineAlert] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([]);
  const [pendingComplete, setPendingComplete] = useState(false);
  
  // Asset verification state
  const [scanningItemId, setScanningItemId] = useState<string | null>(null);
  const [itemVerifications, setItemVerifications] = useState<Record<string, {
    scannedCode?: string;
    scannedExpiration?: Date;
    o2Psi?: number;
    warnings: ValidationWarning[];
  }>>({});

  // Initialize counts from expected quantities
  React.useEffect(() => {
    if (statpack?.contents) {
      const initialCounts: Record<string, number> = {};
      statpack.contents.forEach(item => {
        // In usage reporting mode default to 1 used (so user can adjust),
        // otherwise default to requiredQuantity for verification flows.
        initialCounts[item.itemId] = checkinUsageMode ? 1 : item.requiredQuantity;
      });
      setCheckCounts(initialCounts);
    }
  }, [statpack, checkinUsageMode]);

  const handleCountChange = (itemId: string, count: number) => {
    setCheckCounts(prev => ({
      ...prev,
      [itemId]: count,
    }));
  };

  const handleItemChecked = (itemId: string) => {
    setCheckedItems(prev => {
      const updated = new Set(prev);
      if (updated.has(itemId)) {
        updated.delete(itemId);
      } else {
        updated.add(itemId);
      }
      return updated;
    });
  };

  const handleSealCheck = (compartmentId: string, sealed: boolean) => {
    setSealChecks(prev => ({
      ...prev,
      [compartmentId]: { ...prev[compartmentId], sealed },
    }));
  };

  const handleSealNumber = (compartmentId: string, sealNumber: string) => {
    setSealChecks(prev => ({
      ...prev,
      [compartmentId]: { ...prev[compartmentId], sealNumber },
    }));
  };

  const handleOxygenReading = (itemId: string, reading: string) => {
    setOxygenReadings(prev => ({
      ...prev,
      [itemId]: reading,
    }));
  };

  const handleScanComplete = async (code: string, itemId: string) => {
    setScanningItemId(null);
    
    // Find the statpack item
    const statpackItem = statpack?.contents.find(i => i.itemId === itemId);
    if (!statpackItem) return;
    
    // Parse GS1 for expiration
    const gs1Data = parseGs1Barcode(code);
    let scannedExpiration: Date | undefined;
    if (gs1Data.expiration) {
      try {
        scannedExpiration = new Date(gs1Data.expiration);
      } catch (e) {
        console.warn('Failed to parse GS1 expiration', e);
      }
    }
    
    // Get current O2 reading if any
    const o2Psi = oxygenReadings[itemId] ? Number(oxygenReadings[itemId]) : undefined;
    
    // Run verification
    const warnings = await verifyAssetAgainstRules({
      statpackItem,
      scannedCode: code,
      scannedExpiration,
      scannedO2Psi: o2Psi,
    });
    
    setItemVerifications(prev => ({
      ...prev,
      [itemId]: {
        scannedCode: code,
        scannedExpiration,
        o2Psi,
        warnings,
      },
    }));
  };

  const updateItemO2Psi = async (itemId: string, psi: string) => {
    handleOxygenReading(itemId, psi);
    
    // Re-verify if item has rules
    const statpackItem = statpack?.contents.find(i => i.itemId === itemId);
    const verification = itemVerifications[itemId];
    if (statpackItem?.verificationRules && verification) {
      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedCode: verification.scannedCode,
        scannedExpiration: verification.scannedExpiration,
        scannedO2Psi: psi ? Number(psi) : undefined,
      });
      
      setItemVerifications(prev => ({
        ...prev,
        [itemId]: {
          ...verification,
          o2Psi: psi ? Number(psi) : undefined,
          warnings,
        },
      }));
    }
  };

  const handleSubmit = async () => {
    if (!statpack) return;

    setSubmitting(true);
    try {
      const checkEntries = (statpack.contents || []).map(item => {
        const counted = checkCounts[item.itemId] ?? (checkinUsageMode ? 1 : item.requiredQuantity);
        const used = checkinUsageMode ? checkedItems.has(item.itemId) : false;
          const baseEntry = {
          itemId: item.itemId,
            itemName: item.itemDetails?.name || 'Unknown',
          batchId: item.batchId,
          compartmentId: item.compartmentId,
          pocket: item.pocket,
          requiredQuantity: item.requiredQuantity,
          countedQuantity: counted,
          ok: counted >= item.requiredQuantity,
          serialNumber: item.serialNumber,
          expirationDate: item.expirationDate,
          notes: '',
        };
        
        if (checkinUsageMode && used) {
          return { ...baseEntry, used: true, usedQuantity: counted || 1, notes: 'used_and_replaced' };
        }
        return baseEntry;
      }) as Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];

      const result = await logStatpackCheckOff({
        statpackId: statpack.id,
        statpackName: statpack.name,
        action,
        userId,
        userName,
        checkEntries,
        // Only include seal/oxygen details for admin audits; lightweight member verifications omit them
        sealChecks: isAdmin && Object.keys(sealChecks).length > 0 ? sealChecks : undefined,
        oxygenReadings: isAdmin && Object.keys(oxygenReadings).length > 0 ? oxygenReadings : undefined,
        notes,
      });

      const warnings = result?.validationWarnings || [];
      const criticalWarnings = warnings.filter(w => w.severity === 'critical');
      if (criticalWarnings.length > 0) {
        setValidationWarnings(warnings);
        setPendingComplete(true);
        setInlineAlert({ type: 'warning', message: `✓ Saved with ${criticalWarnings.length} critical warning(s). Please review and acknowledge.` });
        return;
      }
      // Show non-critical warnings but don't block submission
      if (warnings.length > 0) {
        setValidationWarnings(warnings);
      }

      // Show success message inline
      if (isAdmin) {
        setInlineAlert({ type: 'success', message: `✓ Audit complete for ${statpack.name}. You are accountable for this bag.` });
      } else {
        setInlineAlert({ type: 'success', message: `✓ Verification recorded for ${statpack.name}. Thank you.` });
      }

      // show inline HeroUI alert then close
      setTimeout(() => {
        setInlineAlert(null);
        onCheckOffComplete?.();
        handleClose();
      }, 1200);
    } catch (e) {
      console.error('Failed to log check-off:', e);
      setInlineAlert({ type: 'error', message: 'Error saving check-off. Try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setCheckCounts({});
    setCheckedItems(new Set());
    setSealChecks({});
    setOxygenReadings({});
    // asset condition tracking temporarily disabled
    setNotes('');
    setValidationWarnings([]);
    setPendingComplete(false);
    onOpenChange(false);
  };

  const handleAcknowledgeWarnings = () => {
    setInlineAlert(null);
    onCheckOffComplete?.();
    handleClose();
  };

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  
  React.useEffect(() => {
    if (isOpen && bodyRef.current) {
      // Ensure the top of the modal body (instructions) is visible when opened
      bodyRef.current.scrollTop = 0;
    }
  }, [isOpen]);

  if (!statpack) return null;

  const allItemsChecked = statpack.contents?.every(item =>
    checkedItems.has(item.itemId)
  );

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="2xl" placement="center">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {action === 'checkout' && 'Checkout: Digital Check-Off'}
          {action === 'checkin' && '✓ Check-In: Bag Verification'}
          {action === 'maintenance' && '🔧 Maintenance: Inventory Audit'}
        </ModalHeader>

        <ModalBody className="gap-4">
          <div ref={bodyRef} className="max-h-[70vh] overflow-y-auto p-2">
          {inlineAlert && (
            <Card className={
              inlineAlert.type === 'success'
                ? 'bg-success-50'
                : inlineAlert.type === 'warning'
                ? 'bg-warning-50'
                : 'bg-danger-50'
            }>
              <CardBody>
                <p className={
                  inlineAlert.type === 'success'
                    ? 'text-success'
                    : inlineAlert.type === 'warning'
                    ? 'text-warning'
                    : 'text-danger'
                }>{inlineAlert.message}</p>
              </CardBody>
            </Card>
          )}

            {checkinUsageMode && (
              <Card className="bg-default-50">
                <CardBody className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">Report Used Items</p>
                    <p className="text-xs text-default-500">Check the items you used and replaced. If you didn&apos;t use anything, you can mark the pack checked-in immediately.</p>
                  </div>
                  <div>
                    <Button color="default" onPress={() => onQuickCheckIn && onQuickCheckIn()}>I did not use anything — Check In</Button>
                  </div>
                </CardBody>
              </Card>
            )}
          
          {/* Info banner about disposables vs assets */}
          {/* Info banner removed per request: keep modal focused for checkout flow */}

          <Card className="bg-default-100">
            <CardBody className="gap-2">
              <p className="font-semibold">{statpack.name}</p>
              <p className="text-sm text-default-500">
                Checked by: <span className="font-semibold">{userName}</span>
              </p>
              <p className="text-sm text-default-500">
                {isAdmin ? (
                  <>Accountability: You are responsible for the accuracy of this check.</>
                ) : (
                  <>This is a light verification. If discrepancies are found, escalate to an audit.</>
                )}
              </p>
            </CardBody>
          </Card>

          <Divider />

          {validationWarnings.length > 0 && (
            <Card className="bg-warning-50 border border-warning-200">
              <CardBody className="gap-2">
                <p className="font-semibold text-sm text-warning-700">Validation Warnings</p>
                <div className="flex flex-col gap-2">
                  {validationWarnings.map((w, idx) => (
                    <div key={`${w.itemId || 'item'}-${idx}`} className="text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <Chip 
                          size="sm" 
                          color={w.severity === 'critical' ? 'danger' : w.severity === 'warning' ? 'warning' : 'default'}
                          variant="flat"
                        >
                          {w.severity === 'critical' ? 'CRITICAL' : w.severity === 'warning' ? 'Warning' : 'Info'}
                        </Chip>
                        <span className="font-semibold">{w.itemName || w.itemId || 'Unknown Item'}</span>
                      </div>
                      <div className="text-warning-800">{w.message}</div>
                      {w.serialNumber && <div className="text-default-600">Serial: {w.serialNumber}</div>}
                      {w.currentAssignedTo && <div className="text-default-600">Assigned to: {w.currentAssignedTo}</div>}
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* Item Verification Section */}
          <div className="gap-2 flex flex-col">
            <p className="font-semibold text-md">Contents Verification</p>
            {(statpack.contents || []).map(item => {
              const itemId = item.itemId;
              const isChecked = checkedItems.has(itemId);
              const counted = checkCounts[itemId] ?? (checkinUsageMode ? 1 : item.requiredQuantity);
              const ok = counted >= item.requiredQuantity;
              const rulesForItem = item.verificationRules || item.itemDetails?.verificationPolicy;
              const hasRules = rulesForItem && Object.keys(rulesForItem).length > 0;
              
              // Type the verification explicitly to avoid TypeScript 'never' inference
              type ItemVerification = { scannedCode?: string; scannedExpiration?: Date; o2Psi?: number; warnings: ValidationWarning[] };
              const verification: ItemVerification | undefined = itemVerifications[itemId];

              return (
                <Card
                  key={itemId}
                  isPressable
                  onPress={() => handleItemChecked(itemId)}
                  className={`transition-colors bg-default-100 ${ok ? 'ring-1 ring-primary/10' : ''}`}
                >
                  <CardBody className="gap-3 py-4">
                    <div className="flex gap-3 items-start">
                      <Checkbox
                        isSelected={isChecked}
                        onChange={() => handleItemChecked(itemId)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm">
                            {item.itemDetails?.name || 'Unnamed Item'}
                          </p>
                          {hasRules && (
                            <Chip size="sm" color="primary" variant="flat">Rules</Chip>
                          )}
                        </div>
                        <p className="text-xs text-default-500">
                          {checkinUsageMode ? 'Mark if you used and replaced this item' : `Required: ${item.requiredQuantity}x | Category: ${item.itemDetails?.category || 'Other'}`}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-default-500">
                          {item.pocket && <span className="bg-default-200/60 dark:bg-default-700/60 px-2 py-0.5 rounded">Pocket: {item.pocket.replace('_', ' ')}</span>}
                          {item.compartmentId && <span className="bg-default-200/60 dark:bg-default-700/60 px-2 py-0.5 rounded">Compartment: {item.compartmentId}</span>}
                        </div>
                        {item.expirationDate && (
                          <p className={`text-xs ${new Date(item.expirationDate).getTime() < Date.now() ? 'text-danger font-semibold' : 'text-default-500'}`}>
                            Expires: {new Date(item.expirationDate).toLocaleDateString()}
                          </p>
                        )}
                        
                        {/* Verification UI */}
                        {hasRules && (
                          <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                            {!verification ? (
                              <div className="flex gap-2">
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); setScanningItemId(itemId); }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setScanningItemId(itemId);
                                    }
                                  }}
                                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-1 rounded text-sm font-medium text-primary bg-transparent hover:bg-primary/10 focus:outline-none"
                                >
                                  <span className="inline-flex items-center"><ScanLine size={14} /></span>
                                  <span>Verify Asset</span>
                                </div>
                                {/* Allow manual expiration confirmation when required by rules */}
                                {(item.verificationRules?.requireExpirationConfirmation || item.itemDetails?.verificationPolicy?.requireExpirationConfirmation) && (() => {
                                  const currentVerif = itemVerifications[itemId];
                                  return (
                                    <Input
                                      size="sm"
                                      type="date"
                                      placeholder="Confirm Expiration"
                                      value={currentVerif?.scannedExpiration?.toISOString().slice(0,10) || ''}
                                      onClick={(e) => e.stopPropagation()}
                                      onValueChange={async (v) => {
                                      const parsed = v ? new Date(v) : undefined;
                                      setItemVerifications(prev => ({
                                        ...prev,
                                        [itemId]: {
                                          ...(prev[itemId] || { warnings: [] }),
                                          scannedExpiration: parsed,
                                          scannedCode: prev[itemId]?.scannedCode,
                                          o2Psi: prev[itemId]?.o2Psi,
                                        }
                                      }));

                                      // Re-run verification with updated expiration
                                      const statpackItem = statpack?.contents.find(i => i.itemId === itemId);
                                      if (!statpackItem) return;
                                      const currentVerif = itemVerifications[itemId];
                                      const warnings = await verifyAssetAgainstRules({
                                        statpackItem,
                                        scannedCode: currentVerif?.scannedCode,
                                        scannedExpiration: parsed,
                                        scannedO2Psi: currentVerif?.o2Psi,
                                      });
                                      setItemVerifications(prev => ({
                                        ...prev,
                                        [itemId]: {
                                          ...(prev[itemId] || { warnings: [] }),
                                          scannedExpiration: parsed,
                                          scannedCode: prev[itemId]?.scannedCode,
                                          o2Psi: prev[itemId]?.o2Psi,
                                          warnings,
                                        }
                                      }));
                                    }}
                                    />
                                  );
                                })()}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <Card className="bg-blue-50">
                                  <CardBody className="py-1 px-2">
                                    <div className="flex items-center gap-2 text-xs">
                                      <CheckCircle2 size={12} className="text-blue-700" />
                                      <span className="text-blue-900">Scanned: {verification.scannedCode}</span>
                                    </div>
                                    {verification.scannedExpiration && (
                                      <p className="text-xs text-blue-700 ml-4">
                                        Exp: {verification.scannedExpiration.toLocaleDateString('en-US', { month: '2-digit', year: '2-digit' })}
                                      </p>
                                    )}
                                  </CardBody>
                                </Card>
                                
                                {verification.warnings.map((warning, idx) => {
                                  const Icon = warning.severity === 'critical' ? XCircle : AlertTriangle;
                                  const colorClass = warning.severity === 'critical' ? 'bg-red-50' : 'bg-yellow-50';
                                  const textClass = warning.severity === 'critical' ? 'text-red-700' : 'text-yellow-700';
                                  
                                  return (
                                    <Card key={idx} className={colorClass}>
                                      <CardBody className="py-1 px-2">
                                        <div className="flex items-start gap-1">
                                          <Icon size={12} className={`${textClass} mt-0.5`} />
                                          <p className="text-xs text-gray-700">{warning.message}</p>
                                        </div>
                                      </CardBody>
                                    </Card>
                                  );
                                })}
                              </div>
                            )}
                            
                            {item.verificationRules?.requireO2PsiMin !== undefined && item.verificationRules.requireO2PsiMin > 0 && (
                              <Input
                                size="sm"
                                type="number"
                                label="O₂ PSI"
                                placeholder={`Min: ${item.verificationRules.requireO2PsiMin}`}
                                value={oxygenReadings[itemId] || ''}
                                onValueChange={(v) => updateItemO2Psi(itemId, v)}
                                className="w-32"
                              />
                            )}
                          </div>
                        )}
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        {/* Members get a simple checkbox/count field; Admins see and may edit counts */}
                        <Input
                          type="number"
                          min="0"
                          value={String(counted)}
                          onChange={e =>
                            handleCountChange(itemId, parseInt(e.target.value, 10) || 0)
                          }
                          className="w-24"
                          size="sm"
                          label={checkinUsageMode ? 'Used' : 'Counted'}
                          disabled={!isAdmin && !checkinUsageMode}
                        />
                      </div>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>

          <Divider />

          {/* Asset condition tracking temporarily disabled while debugging */}

          <Divider />

          {/* Compartment Seals */}
          {isAdmin && (statpack.compartments?.length || 0) > 0 && (
            <div className="gap-2 flex flex-col">
              <p className="font-semibold text-md">Compartment Seals</p>
              {statpack.compartments.map(comp => (
                <Card
                  key={comp.id}
                  isPressable
                  onPress={() => handleSealCheck(comp.id, !(sealChecks[comp.id]?.sealed ?? comp.isSealed))}
                  className="bg-default-100"
                >
                  <CardBody className="gap-2 py-4">
                    <div className="flex gap-2 items-center">
                      <Checkbox
                        isSelected={sealChecks[comp.id]?.sealed ?? comp.isSealed}
                        onValueChange={(val) => handleSealCheck(comp.id, val)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex-1">
                        <p className="font-semibold text-sm">{comp.name}</p>
                      </div>
                    </div>
                    {sealChecks[comp.id]?.sealed && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <Input
                          type="text"
                          placeholder="Seal #"
                          value={sealChecks[comp.id]?.sealNumber || comp.sealNumber || ''}
                          onChange={e => handleSealNumber(comp.id, e.target.value)}
                          size="sm"
                          className="w-full"
                        />
                      </div>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}

          <Divider />

          {/* Oxygen Readings (if any O2 items in pack) */}
          {isAdmin && (statpack.contents || []).some(item => item.itemDetails?.isOxygen) && (
            <div className="gap-2 flex flex-col">
              <p className="font-semibold text-md">Oxygen Cylinder PSI</p>
              {(statpack.contents || [])
                .filter(item => item.itemDetails?.isOxygen)
                .map(item => (
                  <Input
                    key={item.itemId}
                    type="text"
                    label={`${item.itemDetails?.name || 'Oxygen'} PSI`}
                    value={oxygenReadings[item.itemId] || ''}
                    onChange={e => handleOxygenReading(item.itemId, e.target.value)}
                    placeholder="e.g., 2000"
                    size="sm"
                  />
                ))}
            </div>
          )}

          <Divider />

          {/* General Notes */}
          <div className="gap-1 flex flex-col">
            <label htmlFor="checkoff-notes" className="text-sm font-semibold">
              Additional Notes
            </label>
            <textarea
              id="checkoff-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g., Items appear damaged, missing bag pocket..."
              className="px-2 py-1 border rounded text-sm"
              rows={3}
            />
          </div>
          {/* General Notes */}
          <Divider />

          <div className="gap-1 flex flex-col">
            <label htmlFor="checkoff-notes" className="text-sm font-semibold">
              Additional Notes
            </label>
            <textarea
              id="checkoff-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g., Items appear damaged, missing bag pocket..."
              className="px-2 py-1 border rounded text-sm"
              rows={3}
            />
          </div>

          </div>
        </ModalBody>

          <ModalFooter>
          <Button color="default" onPress={handleClose}>
            Cancel
          </Button>
          <Button
            color="primary"
            onPress={pendingComplete ? handleAcknowledgeWarnings : handleSubmit}
            isLoading={submitting}
            isDisabled={!pendingComplete && (isAdmin ? !allItemsChecked : false)}
          >
            {pendingComplete ? 'Acknowledge & Continue' : (isAdmin ? (allItemsChecked ? '✓ Complete Audit' : 'Verify All Items') : 'Complete Verification')}
          </Button>
        </ModalFooter>
      </ModalContent>
      
      {scanningItemId && (
        <BarcodeScanner
          isOpen={!!scanningItemId}
          onDetected={(code) => handleScanComplete(code, scanningItemId)}
          onClose={() => setScanningItemId(null)}
        />
      )}
    </Modal>
  );
}
