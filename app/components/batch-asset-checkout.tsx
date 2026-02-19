'use client';

import React, { useState, useCallback } from 'react';
import {
  ScanBarcode, X, Check, AlertTriangle, Package, Trash2,
  ArrowRight, ClipboardCheck,
} from 'lucide-react';
import { Button, Input, Chip, Card, CardBody, Divider, Textarea, Select, SelectItem } from '@heroui/react';
import ScannerInput from '@/app/components/scanner-input';
import type { InventoryItem, AssetInstance } from '@/app/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchItem {
  /** Inventory item doc */
  item: InventoryItem;
  /** Specific asset instance, if applicable */
  instance?: AssetInstance;
  /** Resolved display name */
  displayName: string;
  /** Barcode that was scanned */
  scannedBarcode: string;
  /** Condition (for checkin) */
  condition?: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
  /** Quick note */
  notes?: string;
}

interface BatchAssetCheckoutProps {
  /** Function to look up an asset by barcode. Returns matching items. */
  lookupAsset: (barcode: string) => Promise<Array<{ item: InventoryItem; instance?: AssetInstance }>>;
  /** Function to execute batch checkout. */
  onCheckout: (items: BatchItem[], context: BatchContext) => Promise<void>;
  /** Called when user cancels */
  onCancel: () => void;
  /** Mode: checkout or checkin */
  mode: 'checkout' | 'checkin';
  /** Pre-filled context */
  defaultContext?: Partial<BatchContext>;
}

export interface BatchContext {
  purpose: string;
  assignee: string;
  location: string;
  notes: string;
}

const PURPOSES = [
  'Training',
  'Event Coverage',
  'Maintenance',
  'Audit',
  'Transfer',
  'Other',
];

/**
 * Batch asset checkout/checkin component.
 * Allows rapid scanning of multiple assets (e.g., 10 radios) with a single confirmation.
 *
 * UX Flow:
 * 1. Fill in context (purpose, who, where)
 * 2. Continuous scan mode — scanner stays open
 * 3. Each scan adds asset to list with audio/visual feedback
 * 4. Review list, optionally set per-item condition (checkin only)
 * 5. Single confirm button for batch operation
 */
export default function BatchAssetCheckout({
  lookupAsset,
  onCheckout,
  onCancel,
  mode,
  defaultContext,
}: BatchAssetCheckoutProps) {
  const [step, setStep] = useState<'context' | 'scan' | 'review'>('context');
  const [context, setContext] = useState<BatchContext>({
    purpose: defaultContext?.purpose || '',
    assignee: defaultContext?.assignee || '',
    location: defaultContext?.location || '',
    notes: defaultContext?.notes || '',
  });
  const [items, setItems] = useState<BatchItem[]>([]);
  const [scanStatus, setScanStatus] = useState<'success' | 'error' | 'warning' | null>(null);
  const [scanMessage, setScanMessage] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Handle a barcode scan
  const handleScan = useCallback(async (barcode: string) => {
    // Check for duplicates
    if (items.some(i => i.scannedBarcode === barcode)) {
      setScanStatus('warning');
      setScanMessage(`Already scanned: ${barcode}`);
      // Play warning sound
      try { navigator.vibrate?.(200); } catch { /* ignore */ }
      return;
    }

    try {
      const matches = await lookupAsset(barcode);

      if (matches.length === 0) {
        setScanStatus('error');
        setScanMessage(`No asset found for barcode: ${barcode}`);
        try { navigator.vibrate?.(500); } catch { /* ignore */ }
        return;
      }

      if (matches.length === 1) {
        const match = matches[0];
        const displayName = match.instance
          ? `${match.item.name} (${match.instance.serial})`
          : match.item.name;

        // Check if asset is already checked out (for checkout mode)
        if (mode === 'checkout') {
          const instanceStatus = match.instance?.status;
          const itemStatus = match.item.assetStatus;
          if (instanceStatus === 'Checked Out' || itemStatus === 'Checked Out') {
            setScanStatus('warning');
            setScanMessage(`${displayName} is already checked out`);
            // Still add it but mark as warning
          }
        }

        setItems(prev => [...prev, {
          item: match.item,
          instance: match.instance,
          displayName,
          scannedBarcode: barcode,
          condition: 'Good',
        }]);
        setScanStatus('success');
        setScanMessage(`Added: ${displayName}`);

        // Success feedback
        try { navigator.vibrate?.(100); } catch { /* ignore */ }
      } else {
        // Multiple matches — add first match with warning
        const match = matches[0];
        const displayName = `${match.item.name} (${match.instance?.serial || match.item.assetSerial || '?'})`;
        setItems(prev => [...prev, {
          item: match.item,
          instance: match.instance,
          displayName,
          scannedBarcode: barcode,
          condition: 'Good',
        }]);
        setScanStatus('warning');
        setScanMessage(`Added: ${displayName} (${matches.length} matches — using first)`);
      }
    } catch (err) {
      setScanStatus('error');
      setScanMessage(`Lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    // Clear status after 3 seconds
    setTimeout(() => {
      setScanStatus(null);
      setScanMessage('');
    }, 3000);
  }, [items, lookupAsset, mode]);

  // Remove an item from the batch
  const removeItem = useCallback((index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Update item condition (for checkin)
  const updateItemCondition = useCallback((index: number, condition: BatchItem['condition']) => {
    setItems(prev => prev.map((item, i) => i === index ? { ...item, condition } : item));
  }, []);

  // Submit batch
  const handleSubmit = useCallback(async () => {
    if (items.length === 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onCheckout(items, context);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Batch operation failed');
      setIsSubmitting(false);
    }
  }, [items, context, onCheckout]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          {mode === 'checkout' ? <ArrowRight size={20} /> : <ClipboardCheck size={20} />}
          Batch {mode === 'checkout' ? 'Checkout' : 'Check-in'}
        </h2>
        <Chip size="sm" color="primary" variant="flat">
          {items.length} asset{items.length !== 1 ? 's' : ''} scanned
        </Chip>
      </div>

      {/* Step 1: Context */}
      {step === 'context' && (
        <Card>
          <CardBody className="space-y-3">
            <h3 className="text-lg font-semibold">
              {mode === 'checkout' ? 'Checkout Details' : 'Check-in Details'}
            </h3>
            <Select
              label="Purpose"
              placeholder="Select purpose"
              selectedKeys={context.purpose ? [context.purpose] : []}
              onSelectionChange={(keys) => {
                const key = Array.from(keys)[0];
                if (key) setContext(prev => ({ ...prev, purpose: String(key) }));
              }}
              isRequired
            >
              {PURPOSES.map(p => (
                <SelectItem key={p}>{p}</SelectItem>
              ))}
            </Select>
            <Input
              label={mode === 'checkout' ? 'Checked out to' : 'Returned by'}
              placeholder="Name"
              value={context.assignee}
              onValueChange={(v) => setContext(prev => ({ ...prev, assignee: v }))}
              isRequired
            />
            <Input
              label="Location"
              placeholder={mode === 'checkout' ? 'Where will assets be used?' : 'Return location'}
              value={context.location}
              onValueChange={(v) => setContext(prev => ({ ...prev, location: v }))}
            />
            <Textarea
              label="Notes"
              placeholder="Any additional notes..."
              value={context.notes}
              onValueChange={(v) => setContext(prev => ({ ...prev, notes: v }))}
              minRows={2}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="light" onPress={onCancel}>Cancel</Button>
              <Button
                color="primary"
                isDisabled={!context.purpose || !context.assignee}
                onPress={() => setStep('scan')}
              >
                Next: Scan Assets
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step 2: Scan */}
      {step === 'scan' && (
        <div className="space-y-4">
          <Card>
            <CardBody>
              <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                <ScanBarcode size={18} />
                Scan Assets
              </h3>
              <p className="text-sm text-default-500 mb-3">
                Scanner stays open — scan each asset in sequence. 
                {mode === 'checkout' ? ' Each scan adds the asset to checkout list.' : ' Each scan marks the asset as returned.'}
              </p>
              <ScannerInput
                onScan={handleScan}
                continuous
                placeholder="Scan asset barcode..."
                autoFocus
                scanStatus={scanStatus}
                statusMessage={scanMessage}
              />
            </CardBody>
          </Card>

          {/* Scanned items list */}
          {items.length > 0 && (
            <Card>
              <CardBody>
                <h4 className="text-sm font-semibold mb-2">
                  Scanned Assets ({items.length})
                </h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-default-50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium text-default-400 w-6">{idx + 1}.</span>
                        <div className="min-w-0">
                          <div className="text-sm truncate">{item.displayName}</div>
                          <div className="text-xs text-default-400 font-mono">{item.scannedBarcode}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {mode === 'checkin' && (
                          <Select
                            size="sm"
                            className="w-32"
                            selectedKeys={[item.condition || 'Good']}
                            onSelectionChange={(keys) => {
                              const key = Array.from(keys)[0];
                              if (key) updateItemCondition(idx, key as BatchItem['condition']);
                            }}
                            aria-label="Condition"
                          >
                            <SelectItem key="Good">Good</SelectItem>
                            <SelectItem key="Minor Issue">Minor Issue</SelectItem>
                            <SelectItem key="Major Issue">Major Issue</SelectItem>
                            <SelectItem key="Needs Maintenance">Needs Maint.</SelectItem>
                          </Select>
                        )}
                        <Button
                          size="sm"
                          variant="light"
                          color="danger"
                          isIconOnly
                          onPress={() => removeItem(idx)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          <div className="flex gap-2 justify-between">
            <Button variant="light" onPress={() => setStep('context')}>
              Back
            </Button>
            <Button
              color="primary"
              isDisabled={items.length === 0}
              onPress={() => setStep('review')}
              startContent={<ClipboardCheck size={16} />}
            >
              Review ({items.length} assets)
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Review & Confirm */}
      {step === 'review' && (
        <Card>
          <CardBody className="space-y-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <ClipboardCheck size={18} />
              Confirm Batch {mode === 'checkout' ? 'Checkout' : 'Check-in'}
            </h3>

            {/* Context summary */}
            <div className="grid grid-cols-2 gap-2 text-sm bg-default-50 p-3 rounded-lg">
              <div><span className="text-default-500">Purpose:</span> {context.purpose}</div>
              <div><span className="text-default-500">{mode === 'checkout' ? 'To:' : 'By:'}</span> {context.assignee}</div>
              {context.location && <div><span className="text-default-500">Location:</span> {context.location}</div>}
              {context.notes && <div className="col-span-2"><span className="text-default-500">Notes:</span> {context.notes}</div>}
            </div>

            <Divider />

            {/* Items summary */}
            <div>
              <h4 className="text-sm font-semibold mb-2">Assets ({items.length})</h4>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {items.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm px-2 py-1 rounded bg-default-50">
                    <Package size={14} className="text-default-400 shrink-0" />
                    <span className="truncate">{item.displayName}</span>
                    {mode === 'checkin' && item.condition && item.condition !== 'Good' && (
                      <Chip size="sm" color="warning" variant="flat">{item.condition}</Chip>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {submitError && (
              <div className="flex items-center gap-2 text-sm text-danger bg-danger-50 p-2 rounded">
                <AlertTriangle size={14} />
                {submitError}
              </div>
            )}

            <div className="flex gap-2 justify-between">
              <Button variant="light" onPress={() => setStep('scan')}>
                Back to Scanning
              </Button>
              <Button
                color="success"
                isLoading={isSubmitting}
                onPress={handleSubmit}
                startContent={!isSubmitting ? <Check size={16} /> : undefined}
              >
                Confirm {mode === 'checkout' ? 'Checkout' : 'Check-in'} ({items.length} assets)
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
