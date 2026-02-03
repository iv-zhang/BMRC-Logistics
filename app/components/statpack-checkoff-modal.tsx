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
} from '@heroui/react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { logStatpackCheckOff } from '@/app/lib/inventory';
import type { Statpack, ValidationWarning } from '@/app/types';

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
  }, [statpack]);

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

  const handleSubmit = async () => {
    if (!statpack) return;

    setSubmitting(true);
    try {
      const checkEntries = (statpack.contents || []).map(item => {
        const counted = checkCounts[item.itemId] ?? (checkinUsageMode ? 1 : item.requiredQuantity);
        const used = checkinUsageMode ? checkedItems.has(item.itemId) : false;
        const entry: any = {
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
          // Mark used items so downstream tooling can interpret usage/consumption
          entry.used = true;
          entry.usedQuantity = counted || 1;
          entry.notes = 'used_and_replaced';
        }
        return entry;
      });

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
      if (warnings.length > 0) {
        setValidationWarnings(warnings);
        setPendingComplete(true);
        setInlineAlert({ type: 'warning', message: `✓ Saved with ${warnings.length} warning(s). Please review below.` });
        return;
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

  if (!statpack) return null;

  const allItemsChecked = statpack.contents?.every(item =>
    checkedItems.has(item.itemId)
  );
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (isOpen && bodyRef.current) {
      // Ensure the top of the modal body (instructions) is visible when opened
      bodyRef.current.scrollTop = 0;
    }
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="2xl" placement="center">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {action === 'checkout' && '📦 Checkout: Digital Check-Off'}
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
                    <p className="text-xs text-default-500">Check the items you used and replaced. If you didn't use anything, you can mark the pack checked-in immediately.</p>
                  </div>
                  <div>
                    <Button color="default" onPress={() => onQuickCheckIn && onQuickCheckIn()}>I did not use anything — Check In</Button>
                  </div>
                </CardBody>
              </Card>
            )}
          
          {/* Info banner about disposables vs assets */}
          <Card className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <CardBody className="p-3">
              <p className="text-xs text-blue-800 dark:text-blue-200">
                <strong>Note:</strong> This check-off creates an audit log only. Disposables are tracked as unopened boxes in the back room. 
                When a member removes items from a sealed box to restock their pack, a quartermaster should use <strong>&ldquo;Consume Box&rdquo;</strong> in Master Inventory 
                to mark the box as opened and track units in an open batch.
                {isAdmin && (
                  <span className="block mt-1 italic">
                    Admins: Use the &ldquo;Consume Box&rdquo; button in Inventory → Back Room items when restocking forward.
                  </span>
                )}
              </p>
            </CardBody>
          </Card>

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
                    <div key={`${w.itemId || 'item'}-${idx}`} className="text-xs text-warning-800">
                      <div className="font-semibold">{w.itemName || w.itemId || 'Unknown Item'}</div>
                      <div>{w.message}</div>
                      {w.serialNumber && <div>Serial: {w.serialNumber}</div>}
                      {w.currentAssignedTo && <div>Assigned to: {w.currentAssignedTo}</div>}
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

              return (
                <Card
                  key={itemId}
                  isPressable
                  onPress={() => handleItemChecked(itemId)}
                  className={`${ok ? '' : 'bg-warning-100'} transition-colors`}
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
                        <p className="font-semibold text-sm">
                          {item.itemDetails?.name || 'Unnamed Item'}
                        </p>
                        <p className="text-xs text-default-500">
                          {checkinUsageMode ? 'Mark if you used and replaced this item' : `Required: ${item.requiredQuantity}x | Category: ${item.itemDetails?.category || 'N/A'}`}
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
    </Modal>
  );
}
