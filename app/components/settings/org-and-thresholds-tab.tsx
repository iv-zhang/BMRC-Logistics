'use client';
import React from 'react';
import { Input, Select, SelectItem } from '@heroui/react';
import { AUDIT_CADENCES } from '@/app/config/org-config';
import type { AuditCadence, OrgInfo, ThresholdConfig } from '@/app/config/org-config';

// ---------------------------------------------------------------------------
// Organization tab — org.name / org.shortName / org.timezone
// ---------------------------------------------------------------------------

interface OrgTabProps {
  org: OrgInfo;
  onChange: (org: OrgInfo) => void;
}

export function OrgTab({ org, onChange }: OrgTabProps) {
  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Organization</h2>
      <p className="text-sm text-foreground-500 mb-4">
        These values appear in headers, exports, and reports across the app.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="Organization name"
          placeholder="e.g., Berkeley Medical Reserve Corps"
          value={org.name}
          onValueChange={(v) => onChange({ ...org, name: v })}
        />
        <Input
          label="Short name"
          placeholder="e.g., BMRC"
          value={org.shortName}
          onValueChange={(v) => onChange({ ...org, shortName: v })}
        />
        <Input
          label="Timezone"
          placeholder="e.g., America/Los_Angeles"
          description="Used for scheduling and timestamps."
          value={org.timezone}
          onValueChange={(v) => onChange({ ...org, timezone: v })}
          className="md:col-span-2"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thresholds tab — stock & alert thresholds
// ---------------------------------------------------------------------------

interface ThresholdsTabProps {
  thresholds: ThresholdConfig;
  onChange: (thresholds: ThresholdConfig) => void;
}

type NumericThresholdKey = {
  [K in keyof ThresholdConfig]: ThresholdConfig[K] extends number ? K : never;
}[keyof ThresholdConfig];

const CADENCE_LABELS: Record<AuditCadence, { label: string; helper: string }> = {
  monthly: { label: 'Monthly', helper: 'Every item is re-counted each calendar month.' },
  quarterly: { label: 'Quarterly', helper: 'Every item is re-counted each calendar quarter (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec).' },
  semester: { label: 'Each semester', helper: 'Every item is re-counted once per semester (uses the semester start date under Events & Venues).' },
  yearly: { label: 'Yearly', helper: 'Every item is re-counted each calendar year.' },
};

interface ThresholdField {
  key: NumericThresholdKey;
  label: string;
  helper: string;
  unit: string;
  unitPosition: 'start' | 'end';
}

const FIELDS: ThresholdField[] = [
  {
    key: 'assetValueThreshold',
    label: 'High-value asset threshold',
    helper: 'Items worth at least this much are tracked as assets, not consumable inventory.',
    unit: '$',
    unitPosition: 'start',
  },
  {
    key: 'lowStockPercent',
    label: 'Low-stock warning',
    helper: 'Warn when stock falls below this percent of its par level.',
    unit: '%',
    unitPosition: 'end',
  },
  {
    key: 'expirationWarningDays',
    label: 'Expiration warning window',
    helper: 'Show an expiring-soon warning this many days before expiration.',
    unit: 'days',
    unitPosition: 'end',
  },
  {
    key: 'expirationCriticalDays',
    label: 'Expiration critical window',
    helper: 'Escalate to a critical alert this many days before expiration.',
    unit: 'days',
    unitPosition: 'end',
  },
  {
    key: 'o2PsiMin',
    label: 'Minimum O₂ for checkout',
    helper: 'Oxygen tanks below this pressure cannot be checked out.',
    unit: 'PSI',
    unitPosition: 'end',
  },
  {
    key: 'o2PsiWarning',
    label: 'O₂ low warning',
    helper: 'Show a low-pressure warning at or below this reading.',
    unit: 'PSI',
    unitPosition: 'end',
  },
  {
    key: 'statpackAuditIntervalDays',
    label: 'Statpack audit interval',
    helper: 'How often each statpack must be re-audited.',
    unit: 'days',
    unitPosition: 'end',
  },
];

export function ThresholdsTab({ thresholds, onChange }: ThresholdsTabProps) {
  const setField = (key: NumericThresholdKey, raw: string) => {
    const n = raw === '' ? 0 : Number(raw);
    onChange({ ...thresholds, [key]: Number.isFinite(n) ? n : 0 });
  };

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Stock &amp; Alert Thresholds</h2>
      <p className="text-sm text-foreground-500 mb-4">
        Numbers that drive warnings, colors, and checkout blocks throughout the app.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Supply audit cadence"
          description={CADENCE_LABELS[thresholds.auditCadence]?.helper ?? CADENCE_LABELS.monthly.helper}
          selectedKeys={[AUDIT_CADENCES.includes(thresholds.auditCadence) ? thresholds.auditCadence : 'monthly']}
          disallowEmptySelection
          onChange={(e) => {
            const val = e.target.value as AuditCadence;
            if (AUDIT_CADENCES.includes(val)) onChange({ ...thresholds, auditCadence: val });
          }}
          className="md:col-span-2"
        >
          {AUDIT_CADENCES.map((c) => (
            <SelectItem key={c}>{CADENCE_LABELS[c].label}</SelectItem>
          ))}
        </Select>
        {FIELDS.map((f) => (
          <Input
            key={f.key}
            type="number"
            min={0}
            label={f.label}
            description={f.helper}
            value={String(thresholds[f.key] ?? 0)}
            onValueChange={(v) => setField(f.key, v)}
            startContent={
              f.unitPosition === 'start' ? (
                <span className="text-foreground-400 text-sm">{f.unit}</span>
              ) : undefined
            }
            endContent={
              f.unitPosition === 'end' ? (
                <span className="text-foreground-400 text-xs">{f.unit}</span>
              ) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
