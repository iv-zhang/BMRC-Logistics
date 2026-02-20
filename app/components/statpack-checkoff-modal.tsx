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
import ScannerInput from './scanner-input';
import { THRESHOLDS } from '@/app/config/org-config';
import { ScanLine, CheckCircle2, XCircle, AlertTriangle, PackageOpen, AlertCircle, RefreshCw } from 'lucide-react';

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
  // When true, collect check data but don't log it. Caller is responsible for logging.
  skipLogging?: boolean;
  // Called with check entries when skipLogging is true. Caller handles logging.
  onDataCollected?: (params: {
    checkEntries: Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];
    sealChecks?: Record<string, { sealed: boolean; sealNumber?: string }>;
    oxygenReadings?: Record<string, string>;
    notes?: string;
  }) => Promise<void>;
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
  skipLogging = false,
  onDataCollected,
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
  
  // Restock tracking state for check-in flow
  const [restockStatuses, setRestockStatuses] = useState<Record<string, 'restocked' | 'shelf_empty' | null>>({});
  const [restockNotes, setRestockNotes] = useState<Record<string, string>>({});

  // Asset verification state
  const [scanningItemId, setScanningItemId] = useState<string | null>(null);
  const [itemVerifications, setItemVerifications] = useState<Record<string, {
    scannedCode?: string;
    scannedExpiration?: Date;
    o2Psi?: number;
    warnings: ValidationWarning[];
  }>>({});

  // Custom warning acknowledgment tracking
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<Set<string>>(new Set());

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

    // Validate O₂ PSI requirements before checkout
    if (action === 'checkout') {
      const oxygenItems = (statpack.contents || []).filter(item => item.itemDetails?.isOxygen);
      const missingO2 = oxygenItems.filter(item => !oxygenReadings[item.itemId]);
      
      if (missingO2.length > 0) {
        setInlineAlert({
          type: 'error',
          message: `O₂ PSI required for: ${missingO2.map(i => i.itemDetails?.name || 'Oxygen').join(', ')}`
        });
        setSubmitting(false);
        return;
      }
      
      // Check if any readings are below minimum threshold
      const lowO2Items = oxygenItems.filter(item => {
        const reading = Number(oxygenReadings[item.itemId]);
        const minPsi = item.itemDetails?.verificationPolicy?.requireO2PsiMin || THRESHOLDS.o2PsiMin;
        return reading < minPsi;
      });
      
      if (lowO2Items.length > 0 && !isAdmin) {
        setInlineAlert({
          type: 'error',
          message: `O₂ PSI too low for: ${lowO2Items.map(i => i.itemDetails?.name || 'Oxygen').join(', ')}. Contact admin.`
        });
        setSubmitting(false);
        return;
      }
    }

    setSubmitting(true);
    try {
      const checkEntries = (statpack.contents || []).map(item => {
        const counted = checkCounts[item.itemId] ?? (checkinUsageMode ? 1 : item.requiredQuantity);
        const used = checkinUsageMode ? checkedItems.has(item.itemId) : false;
        
        // Build assetCheckResult if we have O₂ reading for this item
        const o2Reading = oxygenReadings[item.itemId] ? Number(oxygenReadings[item.itemId]) : undefined;
        const assetCheckResult = o2Reading !== undefined ? { oxygenPsi: o2Reading } : undefined;
        
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
          assetCheckResult,
          // Include restock tracking data when checking in
          restockStatus: restockStatuses[item.itemId] ?? (counted < item.requiredQuantity ? undefined : 'not_needed' as const),
          restockNotes: restockNotes[item.itemId] || undefined,
        };
        
        if (checkinUsageMode && used) {
          return { ...baseEntry, used: true, usedQuantity: counted || 1, notes: 'used_and_replaced' };
        }
        return baseEntry;
      }) as Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];

      // If skipLogging is true, collect the data and let the caller handle logging
      if (skipLogging) {
        await onDataCollected?.({
          checkEntries,
          sealChecks: isAdmin && Object.keys(sealChecks).length > 0 ? sealChecks : undefined,
          oxygenReadings: isAdmin && Object.keys(oxygenReadings).length > 0 ? oxygenReadings : undefined,
          notes: notes || undefined,
        });

        // Show success message inline
        if (isAdmin) {
          setInlineAlert({ type: 'success', message: `Pocket verified for ${statpack.name}.` });
        } else {
          setInlineAlert({ type: 'success', message: `Pocket verification recorded for ${statpack.name}.` });
        }

        // Close modal and call callback after brief delay
        setTimeout(() => {
          setInlineAlert(null);
          onCheckOffComplete?.();
          handleClose();
        }, 1200);
        return;
      }

      const result = await logStatpackCheckOff({
        statpackId: statpack.id,
        statpackName: statpack.name,
        action,
        userId,
        userName,
        userRole: role || undefined,
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
        setInlineAlert({ type: 'warning', message: `Saved with ${criticalWarnings.length} critical warning(s). Please review and acknowledge.` });
        return;
      }
      // Show non-critical warnings but don't block submission
      if (warnings.length > 0) {
        setValidationWarnings(warnings);
      }

      // Show success message inline
      if (isAdmin) {
        setInlineAlert({ type: 'success', message: `Audit complete for ${statpack.name}. You are accountable for this bag.` });
      } else {
        setInlineAlert({ type: 'success', message: `Verification recorded for ${statpack.name}. Thank you.` });
      }

      // show inline HeroUI alert then close
      setTimeout(() => {
        setInlineAlert(null);
        onCheckOffComplete?.();
        handleClose();
      }, 1200);
    } catch (e: unknown) {
      // Log full error for debugging
      const error = e instanceof Error ? e : new Error(String(e));
      console.error('Failed to log check-off:', error.stack || error);
      const msg = error.message || String(e);
      // For admins show the detailed message to aid debugging; otherwise show generic.
      if (isAdmin) {
        setInlineAlert({ type: 'error', message: `Error saving check-off: ${msg}` });
      } else {
        setInlineAlert({ type: 'error', message: 'Error saving check-off. Try again.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setCheckCounts({});
    setCheckedItems(new Set());
    setSealChecks({});
    setOxygenReadings({});
    setRestockStatuses({});
    setRestockNotes({});
    setAcknowledgedWarnings(new Set());
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

  const totalItems = statpack.contents?.length || 0;
  const checkedCount = statpack.contents?.filter(item => checkedItems.has(item.itemId)).length || 0;
  const allItemsChecked = totalItems > 0 && checkedCount === totalItems;
  const progressPct = totalItems > 0 ? Math.round((checkedCount / totalItems) * 100) : 0;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="2xl" placement="center">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {action === 'checkout' && 'Checkout: Digital Check-Off'}
          {action === 'checkin' && 'Check-In: Bag Verification'}
          {action === 'maintenance' && 'Maintenance: Inventory Audit'}
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

          {validationWarnings.filter(w => w.severity !== 'info').length > 0 && (
            <Card className="bg-warning-50 border border-warning-200">
              <CardBody className="gap-2">
                <p className="font-semibold text-sm text-warning-700">Validation Warnings</p>
                <div className="flex flex-col gap-2">
                  {validationWarnings.filter(w => w.severity !== 'info').map((w, idx) => (
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
            {/* Progress bar */}
            <div className="w-full">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-default-600">{checkedCount}/{totalItems} items verified</span>
                <span className="text-xs font-medium text-default-600">{progressPct}%</span>
              </div>
              <div className="w-full bg-default-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${allItemsChecked ? 'bg-success' : 'bg-primary'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="font-semibold text-md">Contents Verification</p>
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="light" onPress={() => {
                    // Mark all items as checked and set counts to requiredQuantity
                    const allIds = (statpack?.contents || []).map(i => i.itemId).filter(Boolean) as string[];
                    const counts: Record<string, number> = {};
                    (statpack?.contents || []).forEach(it => {
                      counts[it.itemId] = checkinUsageMode ? (checkCounts[it.itemId] ?? 1) : (it.requiredQuantity ?? 1);
                    });
                    setCheckCounts(counts);
                    setCheckedItems(new Set(allIds));
                    // clear any previous inline alerts
                    setInlineAlert(null);
                  }}>Check all</Button>
                </div>
              )}
            </div>
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

              // Custom admin warnings for this item
              const customWarnings = item.customWarnings || [];

              return (
                <Card
                  key={itemId}
                  className={`transition-colors bg-default-100 ${ok ? 'ring-1 ring-primary/10' : ''} cursor-pointer`}
                  onClick={(e) => {
                    // Avoid toggling when an inner button was clicked
                    if ((e.target as HTMLElement).closest('button')) return;
                    handleItemChecked(itemId);
                  }}
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

                        {/* Custom admin warnings */}
                        {customWarnings.length > 0 && (
                          <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                            {customWarnings.map((cw) => {
                              const isAcked = acknowledgedWarnings.has(cw.id);
                              const bgColor = cw.severity === 'critical' ? 'bg-danger-50 border-danger-200' : cw.severity === 'warning' ? 'bg-warning-50 border-warning-200' : 'bg-primary-50 border-primary-200';
                              const textColor = cw.severity === 'critical' ? 'text-danger-700' : cw.severity === 'warning' ? 'text-warning-700' : 'text-primary-700';
                              const IconComp = cw.severity === 'critical' ? AlertCircle : cw.severity === 'warning' ? AlertTriangle : AlertTriangle;
                              return (
                                <div key={cw.id} className={`flex items-start gap-2 p-2 rounded-lg border ${bgColor} ${isAcked ? 'opacity-60' : ''}`}>
                                  <IconComp size={16} className={`${textColor} mt-0.5 flex-shrink-0`} />
                                  <div className="flex-1">
                                    <p className={`text-xs font-semibold ${textColor}`}>
                                      {cw.severity === 'critical' ? 'ACTION REQUIRED' : cw.severity === 'warning' ? 'Warning' : 'Note'}
                                    </p>
                                    <p className="text-xs text-default-700">{cw.message}</p>
                                    {cw.requiresAcknowledgment && !isAcked && (
                                      <Checkbox
                                        size="sm"
                                        className="mt-1"
                                        isSelected={false}
                                        onValueChange={() => {
                                          setAcknowledgedWarnings(prev => {
                                            const next = new Set(prev);
                                            next.add(cw.id);
                                            return next;
                                          });
                                        }}
                                      >
                                        <span className="text-xs">I have verified this</span>
                                      </Checkbox>
                                    )}
                                    {isAcked && (
                                      <Chip size="sm" color="success" variant="flat" className="mt-1">Acknowledged</Chip>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {item.expirationDate && (
                          <p className={`text-xs ${new Date(item.expirationDate).getTime() < Date.now() ? 'text-danger font-semibold' : 'text-default-500'}`}>
                            Expires: {new Date(item.expirationDate).toLocaleDateString()}
                          </p>
                        )}

                        {/* Restock Action Panel — shown during check-in when item count is short */}
                        {action === 'checkin' && !ok && isChecked && (
                          <div className="mt-2 p-3 rounded-lg bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-700 space-y-2" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-2">
                              <AlertCircle size={14} className="text-warning-600" />
                              <p className="text-xs font-semibold text-warning-800 dark:text-warning-200">
                                Short {item.requiredQuantity - counted}x — What did you do?
                              </p>
                            </div>
                            <p className="text-xs text-warning-700 dark:text-warning-300">
                              Go to the <strong>restock shelf</strong> (front area) and grab a replacement. If the shelf is empty, report it below.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                color={restockStatuses[itemId] === 'restocked' ? 'success' : 'default'}
                                variant={restockStatuses[itemId] === 'restocked' ? 'solid' : 'flat'}
                                startContent={<RefreshCw size={14} />}
                                onPress={() => {
                                  setRestockStatuses(prev => ({ ...prev, [itemId]: 'restocked' }));
                                  // Auto-update count to required since they restocked
                                  handleCountChange(itemId, item.requiredQuantity);
                                }}
                              >
                                I restocked it
                              </Button>
                              <Button
                                size="sm"
                                color={restockStatuses[itemId] === 'shelf_empty' ? 'danger' : 'default'}
                                variant={restockStatuses[itemId] === 'shelf_empty' ? 'solid' : 'flat'}
                                startContent={<PackageOpen size={14} />}
                                onPress={() => setRestockStatuses(prev => ({ ...prev, [itemId]: 'shelf_empty' }))}
                              >
                                Shelf is empty
                              </Button>
                            </div>
                            {restockStatuses[itemId] === 'restocked' && (
                              <Card className="bg-success-50 dark:bg-success-900/20">
                                <CardBody className="py-2 px-3">
                                  <p className="text-xs text-success-700 dark:text-success-300">Great! Count updated. Verify the replacement is correct.</p>
                                </CardBody>
                              </Card>
                            )}
                            {restockStatuses[itemId] === 'shelf_empty' && (
                              <div className="space-y-2">
                                <Card className="bg-danger-50 dark:bg-danger-900/20">
                                  <CardBody className="py-2 px-3">
                                    <p className="text-xs text-danger-700 dark:text-danger-300">Admin will be notified that the restock shelf needs to be refilled.</p>
                                  </CardBody>
                                </Card>
                                <Input
                                  size="sm"
                                  placeholder="Optional: which item / any details"
                                  value={restockNotes[itemId] || ''}
                                  onValueChange={(v) => setRestockNotes(prev => ({ ...prev, [itemId]: v }))}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            )}
                          </div>
                        )}

                        {/* Mismatch hint (when not yet checked but count manually lowered) */}
                        {action === 'checkin' && !ok && !isChecked && (
                          <p className="text-xs text-warning-600 mt-1 italic">
                            Tap to verify, then choose a restock action
                          </p>
                        )}
                        
                        {/* Verification UI */}
                        {hasRules && (
                          <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                            {!verification ? (
                              <div className="space-y-2">
                                {/* Inline scanner — no separate modal needed */}
                                {scanningItemId === itemId ? (
                                  <div className="rounded-lg border border-primary/20 p-2">
                                    <ScannerInput
                                      onScan={(code) => handleScanComplete(code, itemId)}
                                      placeholder="Scan asset barcode…"
                                      label="Verify Asset"
                                      compact
                                    />
                                    <Button
                                      size="sm"
                                      variant="light"
                                      className="mt-1"
                                      onPress={() => setScanningItemId(null)}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      variant="flat"
                                      color="primary"
                                      startContent={<ScanLine size={14} />}
                                      onPress={() => setScanningItemId(itemId)}
                                    >
                                      Verify Asset
                                    </Button>
                                    {/* Allow manual expiration confirmation when required by rules */}
                                    {(item.verificationRules?.requireExpirationConfirmation || item.itemDetails?.verificationPolicy?.requireExpirationConfirmation) && (
                                      <Input
                                        size="sm"
                                        type="date"
                                        placeholder="Confirm Expiration"
                                        value={itemVerifications[itemId]?.scannedExpiration?.toISOString().slice(0,10) || ''}
                                        onClick={(e) => e.stopPropagation()}
                                        onValueChange={async (v) => {
                                          const parsed = v ? new Date(v) : undefined;
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
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <Card className="bg-blue-50 dark:bg-blue-900/20">
                                  <CardBody className="py-1 px-2">
                                    <div className="flex items-center gap-2 text-xs">
                                      <CheckCircle2 size={12} className="text-blue-700 dark:text-blue-300" />
                                      <span className="text-blue-900 dark:text-blue-100">Scanned: {verification.scannedCode}</span>
                                      {/* Allow re-scan */}
                                      <Button
                                        size="sm"
                                        variant="light"
                                        className="ml-auto min-w-0 h-5 px-1"
                                        onPress={() => {
                                          setItemVerifications(prev => {
                                            const next = { ...prev };
                                            delete next[itemId];
                                            return next;
                                          });
                                          setScanningItemId(itemId);
                                        }}
                                      >
                                        Re-scan
                                      </Button>
                                    </div>
                                    {verification.scannedExpiration && (
                                      <p className="text-xs text-blue-700 dark:text-blue-300 ml-4">
                                        Exp: {verification.scannedExpiration.toLocaleDateString('en-US', { month: '2-digit', year: '2-digit' })}
                                      </p>
                                    )}
                                  </CardBody>
                                </Card>
                                
                                {verification.warnings.map((warning, idx) => {
                                  const Icon = warning.severity === 'critical' ? XCircle : AlertTriangle;
                                  const colorClass = warning.severity === 'critical' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20';
                                  const textClass = warning.severity === 'critical' ? 'text-red-700 dark:text-red-300' : 'text-yellow-700 dark:text-yellow-300';
                                  
                                  return (
                                    <Card key={idx} className={colorClass}>
                                      <CardBody className="py-1 px-2">
                                        <div className="flex items-start gap-1">
                                          <Icon size={12} className={`${textClass} mt-0.5`} />
                                          <p className="text-xs text-gray-700 dark:text-gray-300">{warning.message}</p>
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
                  className="bg-default-100 cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return;
                    handleSealCheck(comp.id, !(sealChecks[comp.id]?.sealed ?? comp.isSealed));
                  }}
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

          {/* Oxygen Readings (if any O2 items in pack) - REQUIRED for checkout */}
          {(statpack.contents || []).some(item => item.itemDetails?.isOxygen) && action === 'checkout' && (
            <div className="gap-2 flex flex-col">
              <p className="font-semibold text-md text-danger">Oxygen Cylinder PSI (Required) *</p>
              <p className="text-xs text-default-500">Measure and enter PSI for each oxygen tank before checkout</p>
              {(statpack.contents || [])
                .filter(item => item.itemDetails?.isOxygen)
                .map(item => (
                  <Input
                    key={item.itemId}
                    type="number"
                    label={`${item.itemDetails?.name || 'Oxygen'} PSI`}
                    value={oxygenReadings[item.itemId] || ''}
                    onChange={e => handleOxygenReading(item.itemId, e.target.value)}
                    placeholder="e.g., 2000"
                    size="sm"
                    isRequired
                    min="0"
                    max="3000"
                    description={`Minimum required: ${item.itemDetails?.verificationPolicy?.requireO2PsiMin || THRESHOLDS.o2PsiMin} PSI`}
                  />
                ))}
            </div>
          )}
          {/* Admin-only O₂ display during checkin/maintenance */}
          {isAdmin && (statpack.contents || []).some(item => item.itemDetails?.isOxygen) && action !== 'checkout' && (
            <div className="gap-2 flex flex-col">
              <p className="font-semibold text-md">Oxygen Cylinder PSI (Optional)</p>
              {(statpack.contents || [])
                .filter(item => item.itemDetails?.isOxygen)
                .map(item => (
                  <Input
                    key={item.itemId}
                    type="number"
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

          </div>
        </ModalBody>

          <ModalFooter>
          <Button color="default" onPress={handleClose}>
            Cancel
          </Button>
          {(() => {
            // Compute unacknowledged critical custom warnings across all items
            const allCustomWarnings = (statpack.contents || []).flatMap(i => (i.customWarnings || []));
            const unackedCount = allCustomWarnings.filter(w => w.requiresAcknowledgment && !acknowledgedWarnings.has(w.id)).length;
            const hasUnacked = unackedCount > 0;

            return (
              <Button
                color={allItemsChecked && !hasUnacked ? 'success' : 'primary'}
                onPress={pendingComplete ? handleAcknowledgeWarnings : handleSubmit}
                isLoading={submitting}
                isDisabled={hasUnacked || (!pendingComplete && !allItemsChecked)}
              >
                {hasUnacked
                  ? `Acknowledge ${unackedCount} Warning${unackedCount > 1 ? 's' : ''} First`
                  : pendingComplete
                    ? 'Acknowledge & Continue'
                    : allItemsChecked
                      ? 'Submit Verification'
                      : `Verify All Items (${checkedCount}/${totalItems})`}
              </Button>
            );
          })()}
        </ModalFooter>
      </ModalContent>
      
    </Modal>
  );
}
