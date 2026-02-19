'use client';

import React, { useState, useCallback, useMemo } from 'react';
import {
  Check, X, AlertTriangle, ScanBarcode, CalendarClock, Battery,
  Gauge, ShieldCheck, Hash, Power, Package, SkipForward,
} from 'lucide-react';
import { Button, Input, Chip, Slider, Switch, Divider } from '@heroui/react';
import ScannerInput from '@/app/components/scanner-input';
import {
  VERIFICATION_FIELDS,
  getVerificationFieldsForCategory,
  type VerificationFieldDef,
} from '@/app/config/org-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** Values for each field that was checked */
  fieldValues: Record<string, string | number | boolean | Date>;
  /** Whether the barcode scan matched the expected asset */
  barcodeMatched?: boolean;
  /** The scanned barcode value */
  scannedBarcode?: string;
  /** Any warnings generated */
  warnings: Array<{ fieldId: string; message: string; severity: 'warning' | 'critical' }>;
  /** Whether the user explicitly skipped verification */
  skipped?: boolean;
}

export interface ExpectedAsset {
  /** Display name */
  name: string;
  /** Expected barcode / serial / assigned tag */
  expectedBarcode?: string;
  /** Expected serial number */
  expectedSerial?: string;
  /** Asset category for determining verification fields */
  assetCategory?: string;
  /** Item-level verification rules (overrides category defaults) */
  verificationRules?: {
    requireSerial?: boolean;
    requireExpirationConfirmation?: boolean;
    requireO2PsiMin?: number;
    advisoryOnly?: boolean;
  };
  /** Known expiration date to verify against */
  knownExpiration?: Date;
  /** Known battery level */
  knownBatteryPct?: number;
  /** Known O2 PSI */
  knownO2Psi?: number;
}

interface AssetVerifyStepProps {
  /** The expected asset to verify */
  expectedAsset: ExpectedAsset;
  /** Override which verification fields to show */
  verificationFieldIds?: string[];
  /** Called when verification is complete (passed or failed) */
  onVerified: (result: VerificationResult) => void;
  /** Called when user skips verification */
  onSkip?: () => void;
  /** Allow skipping. Default: true */
  allowSkip?: boolean;
  /** Compact layout. Default: false */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Icon Map
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ReactNode> = {
  ScanBarcode: <ScanBarcode size={16} />,
  CalendarClock: <CalendarClock size={16} />,
  Battery: <Battery size={16} />,
  Gauge: <Gauge size={16} />,
  ShieldCheck: <ShieldCheck size={16} />,
  Lock: <Package size={16} />,
  Hash: <Hash size={16} />,
  Power: <Power size={16} />,
  Package: <Package size={16} />,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Per-item asset verification step used during statpack checkout.
 * Dynamically renders verification fields based on asset category config.
 *
 * Flow:
 * 1. If barcode scan is configured → show scanner first
 * 2. On scan match → show remaining fields (expiration, battery, PSI, etc.)
 * 3. User fills in all required fields
 * 4. Component validates and calls onVerified
 */
export default function AssetVerifyStep({
  expectedAsset,
  verificationFieldIds,
  onVerified,
  onSkip,
  allowSkip = true,
  compact = false,
}: AssetVerifyStepProps) {
  // Determine which fields to show
  const fields = useMemo(() => {
    if (verificationFieldIds) {
      return verificationFieldIds
        .map(id => VERIFICATION_FIELDS[id])
        .filter((f): f is VerificationFieldDef => !!f);
    }
    if (expectedAsset.assetCategory) {
      return getVerificationFieldsForCategory(expectedAsset.assetCategory);
    }
    // Default: just barcode scan
    return [VERIFICATION_FIELDS.serial_scan].filter((f): f is VerificationFieldDef => !!f);
  }, [verificationFieldIds, expectedAsset.assetCategory]);

  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean | Date>>({});
  const [barcodeStatus, setBarcodeStatus] = useState<'pending' | 'matched' | 'mismatched' | 'skipped'>('pending');
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Array<{ fieldId: string; message: string; severity: 'warning' | 'critical' }>>([]);

  const setField = useCallback((fieldId: string, value: string | number | boolean | Date) => {
    setFieldValues(prev => ({ ...prev, [fieldId]: value }));
  }, []);

  // Handle barcode scan
  const handleBarcodeScan = useCallback((code: string) => {
    setScannedBarcode(code);
    const expected = expectedAsset.expectedBarcode || expectedAsset.expectedSerial;
    if (!expected) {
      // No expected barcode — accept any scan as identification
      setBarcodeStatus('matched');
      setField('serial_scan', code);
      return;
    }

    // Flexible matching: normalize both values
    const normalize = (s: string) => s.trim().toLowerCase().replace(/[-_\s]/g, '');
    if (normalize(code) === normalize(expected)) {
      setBarcodeStatus('matched');
      setField('serial_scan', code);
    } else {
      setBarcodeStatus('mismatched');
      setField('serial_scan', code);
      setWarnings(prev => [
        ...prev.filter(w => w.fieldId !== 'serial_scan'),
        {
          fieldId: 'serial_scan',
          message: `Expected "${expected}", scanned "${code}"`,
          severity: expectedAsset.verificationRules?.advisoryOnly ? 'warning' : 'critical',
        },
      ]);
    }
  }, [expectedAsset, setField]);

  // Validate and submit
  const handleSubmit = useCallback(() => {
    const newWarnings: typeof warnings = [];

    for (const field of fields) {
      const value = fieldValues[field.id];

      // Check required fields
      if (field.required && (value === undefined || value === '' || value === null)) {
        newWarnings.push({
          fieldId: field.id,
          message: `${field.label} is required`,
          severity: 'critical',
        });
        continue;
      }

      // Check numeric thresholds
      if (field.type === 'number' && typeof value === 'number') {
        if (field.criticalThreshold !== undefined && value <= field.criticalThreshold) {
          newWarnings.push({
            fieldId: field.id,
            message: `${field.label}: ${value}${field.unit || ''} is critically low`,
            severity: 'critical',
          });
        } else if (field.warningThreshold !== undefined && value <= field.warningThreshold) {
          newWarnings.push({
            fieldId: field.id,
            message: `${field.label}: ${value}${field.unit || ''} is low`,
            severity: 'warning',
          });
        }
      }

      // Check expiration
      if (field.id === 'expiration_date' && value) {
        const expDate = value instanceof Date ? value : new Date(value as string);
        if (expDate < new Date()) {
          newWarnings.push({
            fieldId: field.id,
            message: 'Item is EXPIRED',
            severity: 'critical',
          });
        } else {
          const daysUntil = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          if (daysUntil <= 30) {
            newWarnings.push({
              fieldId: field.id,
              message: `Expires in ${daysUntil} days`,
              severity: 'warning',
            });
          }
        }
      }
    }

    // Check barcode mismatch
    if (barcodeStatus === 'mismatched') {
      const existingBarcodeWarning = newWarnings.find(w => w.fieldId === 'serial_scan');
      if (!existingBarcodeWarning) {
        newWarnings.push({
          fieldId: 'serial_scan',
          message: 'Barcode does not match expected asset',
          severity: expectedAsset.verificationRules?.advisoryOnly ? 'warning' : 'critical',
        });
      }
    }

    setWarnings(newWarnings);

    const hasCritical = newWarnings.some(w => w.severity === 'critical');
    const passed = !hasCritical;

    onVerified({
      passed,
      fieldValues,
      barcodeMatched: barcodeStatus === 'matched',
      scannedBarcode: scannedBarcode || undefined,
      warnings: newWarnings,
    });
  }, [fields, fieldValues, barcodeStatus, scannedBarcode, expectedAsset, onVerified]);

  const handleSkip = useCallback(() => {
    onVerified({
      passed: false,
      fieldValues: {},
      warnings: [{ fieldId: 'skip', message: 'Verification skipped by user', severity: 'warning' }],
      skipped: true,
    });
    onSkip?.();
  }, [onVerified, onSkip]);

  // Check if all required fields are filled
  const requiredFilled = fields.every(f => {
    if (!f.required) return true;
    const v = fieldValues[f.id];
    return v !== undefined && v !== '' && v !== null;
  });

  const hasBarcodeField = fields.some(f => f.id === 'serial_scan');
  const otherFields = fields.filter(f => f.id !== 'serial_scan');
  const showOtherFields = !hasBarcodeField || barcodeStatus !== 'pending';

  return (
    <div className={`space-y-3 ${compact ? 'p-2' : 'p-3'} rounded-lg bg-default-50 border border-default-200`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-primary" />
          <span className={`font-medium ${compact ? 'text-sm' : ''}`}>
            Verify: {expectedAsset.name}
          </span>
        </div>
        {barcodeStatus === 'matched' && (
          <Chip size="sm" color="success" variant="flat" startContent={<Check size={12} />}>
            Matched
          </Chip>
        )}
        {barcodeStatus === 'mismatched' && (
          <Chip size="sm" color="danger" variant="flat" startContent={<X size={12} />}>
            Mismatch
          </Chip>
        )}
      </div>

      {/* Barcode scan step */}
      {hasBarcodeField && barcodeStatus === 'pending' && (
        <div className="space-y-2">
          <ScannerInput
            onScan={handleBarcodeScan}
            label="Scan asset barcode"
            placeholder={`Scan ${expectedAsset.name} barcode...`}
            compact={compact}
            autoFocus
            scanStatus={null}
          />
        </div>
      )}

      {/* Barcode scan result */}
      {hasBarcodeField && barcodeStatus !== 'pending' && (
        <div className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${
          barcodeStatus === 'matched' ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'
        }`}>
          {barcodeStatus === 'matched' ? <Check size={14} /> : <AlertTriangle size={14} />}
          <span className="text-sm">
            {barcodeStatus === 'matched'
              ? `✓ Barcode matched: ${scannedBarcode}`
              : `✗ Expected "${expectedAsset.expectedBarcode || expectedAsset.expectedSerial}", got "${scannedBarcode}"`
            }
          </span>
          <Button
            size="sm"
            variant="light"
            className="ml-auto"
            onPress={() => {
              setBarcodeStatus('pending');
              setScannedBarcode(null);
              setWarnings(prev => prev.filter(w => w.fieldId !== 'serial_scan'));
            }}
          >
            Rescan
          </Button>
        </div>
      )}

      {/* Other verification fields */}
      {showOtherFields && otherFields.length > 0 && (
        <>
          {hasBarcodeField && <Divider className="my-2" />}
          <div className="space-y-3">
            {otherFields.map(field => (
              <VerificationField
                key={field.id}
                field={field}
                value={fieldValues[field.id]}
                onChange={(v) => setField(field.id, v)}
                compact={compact}
                warning={warnings.find(w => w.fieldId === field.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                w.severity === 'critical' ? 'bg-danger-50 text-danger-700' : 'bg-warning-50 text-warning-700'
              }`}
            >
              <AlertTriangle size={12} />
              {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {showOtherFields && (
        <div className="flex gap-2 justify-end">
          {allowSkip && (
            <Button
              size="sm"
              variant="light"
              color="default"
              startContent={<SkipForward size={14} />}
              onPress={handleSkip}
            >
              Skip
            </Button>
          )}
          <Button
            size="sm"
            color={warnings.some(w => w.severity === 'critical') ? 'warning' : 'success'}
            startContent={<Check size={14} />}
            onPress={handleSubmit}
            isDisabled={!requiredFilled && !barcodeStatus}
          >
            {warnings.some(w => w.severity === 'critical') ? 'Submit with Issues' : 'Verified ✓'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual verification field renderer
// ---------------------------------------------------------------------------

interface VerificationFieldProps {
  field: VerificationFieldDef;
  value: string | number | boolean | Date | undefined;
  onChange: (value: string | number | boolean | Date) => void;
  compact?: boolean;
  warning?: { message: string; severity: 'warning' | 'critical' };
}

function VerificationField({ field, value, onChange, compact, warning }: VerificationFieldProps) {
  const icon = field.icon ? ICON_MAP[field.icon] : null;

  switch (field.type) {
    case 'boolean':
      return (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <span className={compact ? 'text-sm' : ''}>{field.label}</span>
            {field.required && <span className="text-danger text-xs">*</span>}
          </div>
          <Switch
            size="sm"
            isSelected={!!value}
            onValueChange={(v) => onChange(v)}
            color={value ? 'success' : 'default'}
          />
        </div>
      );

    case 'number':
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon}
            <span className={compact ? 'text-sm' : ''}>{field.label}</span>
            {field.unit && <span className="text-xs text-default-400">({field.unit})</span>}
            {field.required && <span className="text-danger text-xs">*</span>}
          </div>
          {field.max && field.max <= 100 ? (
            <Slider
              size="sm"
              step={1}
              minValue={field.min ?? 0}
              maxValue={field.max}
              value={typeof value === 'number' ? value : field.max}
              onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
              className="max-w-full"
              color={
                typeof value === 'number' && field.criticalThreshold && value <= field.criticalThreshold ? 'danger' :
                typeof value === 'number' && field.warningThreshold && value <= field.warningThreshold ? 'warning' :
                'success'
              }
              renderThumb={(props) => (
                <div {...props} className="group p-0.5 top-1/2 bg-background border-small border-default-200 shadow-medium rounded-full cursor-grab data-[dragging=true]:cursor-grabbing">
                  <span className="transition-transform bg-gradient-to-br shadow-small from-primary-100 to-primary-300 rounded-full w-4 h-4 block group-data-[dragging=true]:scale-80" />
                </div>
              )}
            />
          ) : (
            <Input
              type="number"
              size="sm"
              min={field.min}
              max={field.max}
              value={value?.toString() ?? ''}
              onValueChange={(v) => onChange(Number(v) || 0)}
              endContent={field.unit && <span className="text-xs text-default-400">{field.unit}</span>}
            />
          )}
          {typeof value === 'number' && (
            <div className="text-xs text-right text-default-500">
              {value}{field.unit || ''}
            </div>
          )}
          {warning && (
            <div className={`text-xs ${warning.severity === 'critical' ? 'text-danger' : 'text-warning'}`}>
              ⚠ {warning.message}
            </div>
          )}
        </div>
      );

    case 'date':
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon}
            <span className={compact ? 'text-sm' : ''}>{field.label}</span>
            {field.required && <span className="text-danger text-xs">*</span>}
          </div>
          <Input
            type="month"
            size="sm"
            value={value ? (value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}` : String(value)) : ''}
            onValueChange={(v) => {
              if (v) {
                const [year, month] = v.split('-').map(Number);
                onChange(new Date(year, month - 1, 1));
              }
            }}
          />
          {warning && (
            <div className={`text-xs ${warning.severity === 'critical' ? 'text-danger' : 'text-warning'}`}>
              ⚠ {warning.message}
            </div>
          )}
        </div>
      );

    case 'select':
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon}
            <span className={compact ? 'text-sm' : ''}>{field.label}</span>
            {field.required && <span className="text-danger text-xs">*</span>}
          </div>
          <div className="flex flex-wrap gap-1">
            {field.options?.map(opt => (
              <Chip
                key={opt}
                size="sm"
                variant={value === opt ? 'solid' : 'flat'}
                color={value === opt ? (
                  opt.includes('Good') ? 'success' :
                  opt.includes('Minor') ? 'warning' :
                  opt.includes('Major') || opt.includes('Maintenance') ? 'danger' :
                  'primary'
                ) : 'default'}
                className="cursor-pointer"
                onClick={() => onChange(opt)}
              >
                {opt}
              </Chip>
            ))}
          </div>
        </div>
      );

    case 'text':
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon}
            <span className={compact ? 'text-sm' : ''}>{field.label}</span>
            {field.required && <span className="text-danger text-xs">*</span>}
          </div>
          <Input
            size="sm"
            value={typeof value === 'string' ? value : ''}
            onValueChange={(v) => onChange(v)}
            placeholder={`Enter ${field.label.toLowerCase()}`}
          />
        </div>
      );

    default:
      return null;
  }
}
