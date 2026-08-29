'use client';
import React from 'react';
import { Input, Select, SelectItem, Button, Switch, Textarea, Checkbox, Chip } from '@heroui/react';
import { Plus, Trash2, Info, Copy, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import type {
  WaitlistConfig,
  CancellationPolicyConfig,
  PriorityTierConfig,
  DefaultTierWindow,
  ShiftReminderConfig,
  NotificationDeliveryConfig,
} from '@/app/config/org-config';
import { WAITLIST_DEFAULTS } from '@/app/config/org-config';
import type { TierCriteria, User } from '@/app/types';
import { newId } from './settings-utils';

// ---------------------------------------------------------------------------
// Waitlist & Tiers tab — the settings surface for the six [Phase 0] config
// groups added for the waitlist/tier/reminder feature (docs/medops-signup-plan.md
// §4.1/§4.2). Everything here is org-config data, never hardcoded (P11): every
// threshold, window, mode, and member-facing string below has a control.
//
// Tenure criteria (minSemesters / minTenureDays) render but stay disabled —
// see the note above the tier list in PriorityTiersCard. §8 Phase 2 requires
// the roster join-date backfill to run FIRST; enabling tenure rules against a
// half-populated roster silently locks out real members.
// ---------------------------------------------------------------------------

const ROLE_OPTIONS: { label: string; value: NonNullable<User['role']> }[] = [
  { label: 'FTO', value: 'FTO' },
  { label: 'FTO Intern', value: 'fto_intern' },
  { label: 'Member', value: 'member' },
  { label: 'MedOps', value: 'medops' },
  { label: 'Quartermaster', value: 'quartermaster' },
  { label: 'Inventory Helper', value: 'inventory_helper' },
  { label: 'Admin', value: 'admin' },
];

const MEMBER_STATUS_OPTIONS: { label: string; value: NonNullable<User['memberStatus']> }[] = [
  { label: 'New', value: 'new' },
  { label: 'Probationary', value: 'probationary' },
  { label: 'General', value: 'general' },
];

function toggleInArray<T>(arr: T[] | undefined, v: T): T[] {
  const cur = arr ?? [];
  return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
}

function WarningBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 bg-warning-50 dark:bg-warning-950/20 border border-warning/20 rounded-large px-4 py-3">
      <Info size={16} className="text-warning flex-none mt-0.5" />
      <p className="text-sm text-foreground-600">{children}</p>
    </div>
  );
}

function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-warning flex items-start gap-1 mt-1">
      <AlertTriangle size={12} className="flex-none mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Card 1 — Waitlist
// ---------------------------------------------------------------------------

function WaitlistCard({ value, onChange }: { value: WaitlistConfig; onChange: (v: WaitlistConfig) => void }) {
  const set = (patch: Partial<WaitlistConfig>) => onChange({ ...value, ...patch });

  const responseWindowTooLong =
    value.longNoticeResponseWindowHours > value.longNoticeThresholdHours ||
    value.shortNoticeResponseWindowHours > value.longNoticeThresholdHours;

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Waitlist</h2>
      <p className="text-sm text-foreground-500 mb-4">
        Controls what happens when a member requests a full slot.
      </p>

      <div className="flex items-start gap-3 mb-4">
        <Switch isSelected={value.enabled} onValueChange={(v) => set({ enabled: v })} size="sm" className="mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">Enable waitlist</p>
          <p className="text-xs text-foreground-500 mt-1">
            When on, a member who requests a full slot joins a queue instead of being blocked.
          </p>
        </div>
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${value.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <Select
          label="Queue scope"
          selectedKeys={[value.scope]}
          onChange={(e) => e.target.value && set({ scope: e.target.value as WaitlistConfig['scope'] })}
          description="Per event means a seat freeing on any team reaches everyone waiting for that role."
        >
          <SelectItem key="event">One queue per event (recommended)</SelectItem>
          <SelectItem key="team">One queue per team</SelectItem>
        </Select>

        <Select
          label="Team preference"
          selectedKeys={[value.honorTeamPreference]}
          onChange={(e) => e.target.value && set({ honorTeamPreference: e.target.value as WaitlistConfig['honorTeamPreference'] })}
          description="Strict can leave a seat empty while someone waits for their preferred team."
        >
          <SelectItem key="ignore">Ignore</SelectItem>
          <SelectItem key="soft">Honour when possible (recommended)</SelectItem>
          <SelectItem key="strict">Strict</SelectItem>
        </Select>

        <Input
          type="number"
          min={0}
          label="Long-notice threshold"
          description="Offers made with more notice than this are binding on accept."
          value={String(value.longNoticeThresholdHours)}
          onValueChange={(v) => set({ longNoticeThresholdHours: Number(v) || 0 })}
          endContent={<span className="text-foreground-400 text-xs">hours</span>}
        />
        <div />

        <Input
          type="number"
          min={0}
          label="Long-notice response window"
          value={String(value.longNoticeResponseWindowHours)}
          onValueChange={(v) => set({ longNoticeResponseWindowHours: Number(v) || 0 })}
          endContent={<span className="text-foreground-400 text-xs">hours</span>}
        />
        <Input
          type="number"
          min={0}
          label="Short-notice response window"
          description="Short-notice acceptance is never binding — a no-show on a short-notice pickup doesn't count against them."
          value={String(value.shortNoticeResponseWindowHours)}
          onValueChange={(v) => set({ shortNoticeResponseWindowHours: Number(v) || 0 })}
          endContent={<span className="text-foreground-400 text-xs">hours</span>}
        />
      </div>
      {value.enabled && responseWindowTooLong && (
        <InlineWarning>
          A response window longer than the long-notice threshold means an offer could still be pending after it would
          have counted as short notice — check this is intentional.
        </InlineWarning>
      )}

      <div className={`flex flex-col gap-4 mt-4 pt-4 border-t border-divider ${value.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="flex items-start gap-3">
          <Switch isSelected={value.autoPromote} onValueChange={(v) => set({ autoPromote: v })} size="sm" className="mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">Auto-promote from waitlist</p>
            <p className="text-xs text-foreground-500 mt-1">
              When off, a freed slot sits open until a manager sends the next offer by hand.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="After a declined or expired offer"
            selectedKeys={[value.declinedOfferBehavior]}
            onChange={(e) => e.target.value && set({ declinedOfferBehavior: e.target.value as WaitlistConfig['declinedOfferBehavior'] })}
          >
            <SelectItem key="terminal">Remove from queue</SelectItem>
            <SelectItem key="requeue_back">Move to back of queue</SelectItem>
          </Select>

          <Input
            type="number"
            min={0}
            label="Max offers per member per event"
            isDisabled={value.declinedOfferBehavior !== 'requeue_back'}
            description={value.declinedOfferBehavior !== 'requeue_back' ? 'Only applies with "Move to back of queue."' : 'Caps the requeue loop.'}
            value={String(value.maxOffersPerMember)}
            onValueChange={(v) => set({ maxOffersPerMember: Number(v) || 0 })}
          />

          <Input
            type="number"
            min={0}
            label="Max queue length"
            description="0 = unlimited. A visible cap beats an invisible one."
            value={String(value.maxQueueLength)}
            onValueChange={(v) => set({ maxQueueLength: Number(v) || 0 })}
          />

          <div className="flex items-start gap-3 md:self-center">
            <Switch
              isSelected={value.allowQueueAfterShiftStart}
              onValueChange={(v) => set({ allowQueueAfterShiftStart: v })}
              size="sm"
              className="mt-0.5"
            />
            <p className="text-sm font-medium text-foreground">Allow joining after the shift has started</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 2 — Cancellation policy
// ---------------------------------------------------------------------------

function CancellationCard({
  value,
  onChange,
}: {
  value: CancellationPolicyConfig;
  onChange: (v: CancellationPolicyConfig) => void;
}) {
  const set = (patch: Partial<CancellationPolicyConfig>) => onChange({ ...value, ...patch });

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Cancellation policy</h2>
      <p className="text-sm text-foreground-500 mb-4">
        What happens when a member cancels a shift close to its start time.
      </p>

      <div className="flex items-start gap-3 mb-4">
        <Switch isSelected={value.enabled} onValueChange={(v) => set({ enabled: v })} size="sm" className="mt-0.5" />
        <p className="text-sm font-medium text-foreground">Enable cancellation policy</p>
      </div>

      <div className={`flex flex-col gap-4 ${value.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            type="number"
            min={0}
            label="Notice window"
            description="Cancelling inside this window counts as a late cancellation."
            value={String(value.noticeHours)}
            onValueChange={(v) => set({ noticeHours: Number(v) || 0 })}
            endContent={<span className="text-foreground-400 text-xs">hours</span>}
          />

          <Select
            label="When a member cancels inside the window"
            selectedKeys={[value.mode]}
            onChange={(e) => e.target.value && set({ mode: e.target.value as CancellationPolicyConfig['mode'] })}
          >
            <SelectItem key="ignore">Do nothing</SelectItem>
            <SelectItem key="flag">Flag for managers</SelectItem>
            <SelectItem key="confirm">Warn the member and flag (recommended)</SelectItem>
            <SelectItem key="block">Block the cancel</SelectItem>
          </Select>

          <Select
            label="Applies to"
            selectedKeys={[value.appliesTo]}
            onChange={(e) => e.target.value && set({ appliesTo: e.target.value as CancellationPolicyConfig['appliesTo'] })}
          >
            <SelectItem key="binding">Committed shifts only (recommended)</SelectItem>
            <SelectItem key="all">All confirmed shifts</SelectItem>
          </Select>

          <div className="flex items-start gap-3 md:self-center">
            <Switch isSelected={value.countsAgainstRecord} onValueChange={(v) => set({ countsAgainstRecord: v })} size="sm" className="mt-0.5" />
            <p className="text-sm font-medium text-foreground">Count late cancellations on the member&apos;s record</p>
          </div>
        </div>

        {value.mode === 'block' && (
          <InlineWarning>
            Blocking is enforced in the app only until Firestore rules ship (Phase 0.5). A member with developer tools
            can still cancel.
          </InlineWarning>
        )}

        <Textarea
          label="Message shown to the member"
          description="{hours} is replaced with the notice window."
          value={value.memberMessage}
          onValueChange={(v) => set({ memberMessage: v })}
          minRows={2}
        />
        {value.noticeHours <= 0 && <InlineWarning>A notice window of 0 or less means this policy never applies.</InlineWarning>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 3 — Priority access tiers
// ---------------------------------------------------------------------------

function criteriaIsEmpty(c: TierCriteria): boolean {
  return (
    !(c.roles && c.roles.length) &&
    !(c.memberStatus && c.memberStatus.length) &&
    !c.minCompletedShifts &&
    !(c.minShiftsByType && Object.keys(c.minShiftsByType).length) &&
    !c.minTenureDays &&
    !c.minSemesters &&
    !c.requireCommitteeMember
  );
}

function CriteriaEditor({
  criteria,
  eventTypes,
  onChange,
}: {
  criteria: TierCriteria;
  eventTypes: string[];
  onChange: (c: TierCriteria) => void;
}) {
  const [newTypeKey, setNewTypeKey] = React.useState(eventTypes[0] ?? '');
  const [newTypeVal, setNewTypeVal] = React.useState('1');
  const set = (patch: Partial<TierCriteria>) => onChange({ ...criteria, ...patch });

  const addShiftsByType = () => {
    const key = newTypeKey.trim();
    const n = Number(newTypeVal);
    if (!key || !Number.isFinite(n) || n <= 0) return;
    set({ minShiftsByType: { ...(criteria.minShiftsByType ?? {}), [key]: n } });
  };

  const removeShiftsByType = (key: string) => {
    const next = { ...(criteria.minShiftsByType ?? {}) };
    delete next[key];
    set({ minShiftsByType: next });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Roles</p>
        <div className="flex flex-wrap gap-1.5">
          {ROLE_OPTIONS.map((r) => {
            const active = (criteria.roles ?? []).includes(r.value);
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => set({ roles: toggleInArray(criteria.roles, r.value) })}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors duration-150 ${
                  active
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Member status</p>
        <div className="flex flex-wrap gap-1.5">
          {MEMBER_STATUS_OPTIONS.map((s) => {
            const active = (criteria.memberStatus ?? []).includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => set({ memberStatus: toggleInArray(criteria.memberStatus, s.value) })}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors duration-150 ${
                  active
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min completed shifts"
          value={String(criteria.minCompletedShifts ?? 0)}
          onValueChange={(v) => set({ minCompletedShifts: Number(v) || 0 })}
        />
        <div className="flex items-end gap-2">
          <Switch
            isSelected={!!criteria.requireCommitteeMember}
            onValueChange={(v) => set({ requireCommitteeMember: v })}
            size="sm"
          />
          <span className="text-sm text-foreground">Requires committee membership</span>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Min shifts by type</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {Object.entries(criteria.minShiftsByType ?? {}).map(([k, n]) => (
            <Chip key={k} size="sm" variant="flat" onClose={() => removeShiftsByType(k)}>
              {k}: {n}
            </Chip>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Select size="sm" label="Event type" className="max-w-[160px]" selectedKeys={newTypeKey ? [newTypeKey] : []} onChange={(e) => setNewTypeKey(e.target.value)}>
            {eventTypes.map((t) => (
              <SelectItem key={t}>{t}</SelectItem>
            ))}
          </Select>
          <Input size="sm" type="number" min={1} label="Min shifts" className="max-w-[100px]" value={newTypeVal} onValueChange={setNewTypeVal} />
          <Button size="sm" variant="flat" isIconOnly onPress={addShiftsByType} aria-label="Add">
            <Plus size={14} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end pt-2 border-t border-divider">
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min semesters"
          isDisabled
          value={String(criteria.minSemesters ?? '')}
          onValueChange={(v) => set({ minSemesters: v === '' ? undefined : Number(v) || 0 })}
        />
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min tenure days"
          isDisabled
          value={String(criteria.minTenureDays ?? '')}
          onValueChange={(v) => set({ minTenureDays: v === '' ? undefined : Number(v) || 0 })}
        />
        <Select
          size="sm"
          label="Match"
          selectedKeys={[criteria.combine ?? 'all']}
          onChange={(e) => e.target.value && set({ combine: e.target.value as TierCriteria['combine'] })}
        >
          <SelectItem key="all">all of the above</SelectItem>
          <SelectItem key="any">any of the above</SelectItem>
        </Select>
      </div>
      <p className="text-[11px] text-foreground-400 -mt-1">
        Tenure fields are disabled until the roster join-date backfill runs — see the note above.
      </p>
    </div>
  );
}

function TierWindowRow({
  window,
  eventTypes,
  onChange,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  window: DefaultTierWindow;
  eventTypes: string[];
  onChange: (patch: Partial<DefaultTierWindow>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <div className="bg-content2 border border-divider rounded-large p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
          <Input size="sm" label="Label" value={window.label} onValueChange={(v) => onChange({ label: v })} />
          <Input
            size="sm"
            type="number"
            min={0}
            label="Opens"
            description="Days before the event"
            value={String(window.leadDays)}
            onValueChange={(v) => onChange({ leadDays: Number(v) || 0 })}
            endContent={<span className="text-foreground-400 text-xs">days before</span>}
          />
        </div>
        <div className="flex flex-col gap-1 flex-none">
          <Button isIconOnly size="sm" variant="light" onPress={onMoveUp} aria-label="Move up">
            <ArrowUp size={14} />
          </Button>
          <Button isIconOnly size="sm" variant="light" onPress={onMoveDown} aria-label="Move down">
            <ArrowDown size={14} />
          </Button>
        </div>
      </div>

      <CriteriaEditor criteria={window.criteria} eventTypes={eventTypes} onChange={(criteria) => onChange({ criteria })} />

      {criteriaIsEmpty(window.criteria) && (window.criteria.combine ?? 'all') === 'all' && (
        <InlineWarning>
          Empty criteria with &quot;all of the above&quot; matches everyone — this window is a no-op relative to general
          signup.
        </InlineWarning>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-divider">
        <Button size="sm" variant="flat" startContent={<Copy size={13} />} onPress={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="flat" color="danger" startContent={<Trash2 size={13} />} onPress={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function PriorityTiersCard({
  value,
  eventTypes,
  onChange,
}: {
  value: PriorityTierConfig;
  eventTypes: string[];
  onChange: (v: PriorityTierConfig) => void;
}) {
  const set = (patch: Partial<PriorityTierConfig>) => onChange({ ...value, ...patch });

  const updateWindowAt = (idx: number, patch: Partial<DefaultTierWindow>) => {
    const next = [...value.defaultTiers];
    next[idx] = { ...next[idx], ...patch };
    set({ defaultTiers: next });
  };

  const removeWindowAt = (idx: number) => {
    if (!confirm('Remove this priority window?')) return;
    set({ defaultTiers: value.defaultTiers.filter((_, i) => i !== idx) });
  };

  const duplicateWindowAt = (idx: number) => {
    const w = value.defaultTiers[idx];
    const copy: DefaultTierWindow = { ...w, id: newId('tier'), label: `${w.label} (copy)` };
    const next = [...value.defaultTiers];
    next.splice(idx + 1, 0, copy);
    set({ defaultTiers: next });
  };

  const moveWindow = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= value.defaultTiers.length) return;
    const next = [...value.defaultTiers];
    [next[idx], next[j]] = [next[j], next[idx]];
    set({ defaultTiers: next });
  };

  const addWindow = () => {
    set({
      defaultTiers: [
        ...value.defaultTiers,
        { id: newId('tier'), label: 'New window', leadDays: value.defaultGeneralLeadDays + 7, criteria: { combine: 'any' } },
      ],
    });
  };

  const leadDaysCounts = new Map<number, number>();
  value.defaultTiers.forEach((w) => leadDaysCounts.set(w.leadDays, (leadDaysCounts.get(w.leadDays) ?? 0) + 1));
  const hasDuplicateLeadDays = Array.from(leadDaysCounts.values()).some((n) => n > 1);

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Priority access tiers</h2>
      <p className="text-sm text-foreground-500 mb-4">
        Staged sign-up windows that open before general registration, for members who meet the window&apos;s criteria.
      </p>

      <div className="flex items-start gap-3 mb-4">
        <Switch isSelected={value.enabled} onValueChange={(v) => set({ enabled: v })} size="sm" className="mt-0.5" />
        <p className="text-sm font-medium text-foreground">Enable priority tiers</p>
      </div>

      <div className={`flex flex-col gap-4 ${value.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <WarningBanner>
          Tenure-based criteria (min semesters / min tenure days) are shown but disabled below. Enabling them against a
          half-populated roster would silently lock out real members with no join date on file — configure Terms
          (Events &amp; Venues tab), run the roster join-date backfill, then enable tenure rules here.
        </WarningBanner>

        <div className="flex flex-col gap-3">
          {value.defaultTiers.map((w, idx) => (
            <TierWindowRow
              key={w.id}
              window={w}
              eventTypes={eventTypes}
              onChange={(patch) => updateWindowAt(idx, patch)}
              onDuplicate={() => duplicateWindowAt(idx)}
              onRemove={() => removeWindowAt(idx)}
              onMoveUp={() => moveWindow(idx, -1)}
              onMoveDown={() => moveWindow(idx, 1)}
            />
          ))}
          {value.defaultTiers.length === 0 && <p className="text-xs text-foreground-400">No priority windows yet.</p>}
        </div>
        {hasDuplicateLeadDays && (
          <InlineWarning>
            Two windows open on the same day. That&apos;s legal (different criteria opening together) — confirm it&apos;s
            intentional.
          </InlineWarning>
        )}
        {value.defaultTiers.some((w) => w.leadDays <= value.defaultGeneralLeadDays) && (
          <InlineWarning>
            A window&apos;s &quot;opens&quot; day should be after general signup opens, or it never actually runs early.
          </InlineWarning>
        )}

        <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} className="self-start" onPress={addWindow}>
          Add window
        </Button>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-divider">
          <Input
            type="number"
            min={0}
            label="General signup opens"
            value={String(value.defaultGeneralLeadDays)}
            onValueChange={(v) => set({ defaultGeneralLeadDays: Number(v) || 0 })}
            endContent={<span className="text-foreground-400 text-xs">days before</span>}
          />
        </div>
        <Textarea
          label="Default rationale"
          description="Shown to members BEFORE they hit the restriction, explaining who gets in early and why."
          value={value.defaultRationale}
          onValueChange={(v) => set({ defaultRationale: v })}
          minRows={2}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 4 — Shift reminders
// ---------------------------------------------------------------------------

function ShiftRemindersCard({
  value,
  emailReady,
  onChange,
}: {
  value: ShiftReminderConfig;
  emailReady: boolean;
  onChange: (v: ShiftReminderConfig) => void;
}) {
  const set = (patch: Partial<ShiftReminderConfig>) => onChange({ ...value, ...patch });
  const [newHours, setNewHours] = React.useState('');

  const addHours = () => {
    const n = Number(newHours);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = Array.from(new Set([...value.hoursBefore, n])).sort((a, b) => b - a);
    set({ hoursBefore: next });
    setNewHours('');
  };

  const removeHours = (n: number) => set({ hoursBefore: value.hoursBefore.filter((h) => h !== n) });

  const toggleChannel = (ch: 'in_app' | 'email') => {
    set({ channels: toggleInArray(value.channels, ch) });
  };

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Shift reminders</h2>
      <p className="text-sm text-foreground-500 mb-4">Nudges sent to a member before their shift starts.</p>

      <div className="flex items-start gap-3 mb-4">
        <Switch isSelected={value.enabled} onValueChange={(v) => set({ enabled: v })} size="sm" className="mt-0.5" />
        <p className="text-sm font-medium text-foreground">Enable shift reminders</p>
      </div>

      <div className={`flex flex-col gap-4 ${value.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div>
          <p className="text-xs font-semibold text-foreground-500 mb-1.5">Send a reminder before the shift</p>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {value.hoursBefore.map((h) => (
              <Chip key={h} size="sm" variant="flat" onClose={() => removeHours(h)}>
                {h}h
              </Chip>
            ))}
            {value.hoursBefore.length === 0 && <span className="text-xs text-foreground-400">No reminders configured.</span>}
          </div>
          <div className="flex items-end gap-2">
            <Input
              size="sm"
              type="number"
              min={1}
              label="Hours before"
              className="max-w-[140px]"
              value={newHours}
              onValueChange={setNewHours}
            />
            <Button size="sm" variant="flat" isIconOnly onPress={addHours} aria-label="Add reminder offset">
              <Plus size={14} />
            </Button>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-foreground-500 mb-1.5">Channels</p>
          <div className="flex flex-col gap-1.5">
            <Checkbox isSelected={value.channels.includes('in_app')} onValueChange={() => toggleChannel('in_app')}>
              In-app
            </Checkbox>
            <Checkbox isSelected={value.channels.includes('email')} isDisabled={!emailReady} onValueChange={() => toggleChannel('email')}>
              Email{!emailReady ? ' (requires delivery setup — Notification Delivery card)' : ''}
            </Checkbox>
          </div>
        </div>

        <Textarea
          label="Message template"
          description="{event} {team} {role} {hours} are interpolated."
          value={value.template}
          onValueChange={(v) => set({ template: v })}
          minRows={2}
        />

        <WarningBanner>
          With no scheduler, in-app reminders appear only when the member opens the app. Email requires the delivery
          worker described in the Notification Delivery card.
        </WarningBanner>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 5 — Member-facing copy
// ---------------------------------------------------------------------------

function MemberCopyCard({ value, onChange }: { value: WaitlistConfig; onChange: (v: WaitlistConfig) => void }) {
  const setCopy = (patch: Partial<WaitlistConfig['copy']>) => onChange({ ...value, copy: { ...value.copy, ...patch } });
  const resetCopy = () => {
    if (!confirm('Reset all member-facing waitlist copy to the built-in defaults?')) return;
    onChange({ ...value, copy: { ...WAITLIST_DEFAULTS.copy } });
  };

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Member-facing copy</h2>
      <p className="text-sm text-foreground-500 mb-4">
        The exact wording members see for the waitlist and offers, editable without a deploy.
      </p>

      <WarningBanner>
        The short-notice message is a policy promise. Don&apos;t remove the &quot;no penalty&quot; wording without
        changing the underlying policy.
      </WarningBanner>

      <div className="flex flex-col gap-4 mt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Join button label" value={value.copy.joinButtonLabel} onValueChange={(v) => setCopy({ joinButtonLabel: v })} />
          <Input
            label="Queued label"
            description="{position} is replaced with the member's place in line."
            value={value.copy.queuedLabel}
            onValueChange={(v) => setCopy({ queuedLabel: v })}
          />
        </div>
        <Textarea
          label="Long-notice offer message"
          description="The binding warning shown before accepting a long-notice offer. {cancelHours} is interpolated."
          value={value.copy.offerLongNotice}
          onValueChange={(v) => setCopy({ offerLongNotice: v })}
          minRows={2}
        />
        <Textarea
          label="Short-notice offer message"
          description="The no-penalty reassurance shown before responding to a short-notice offer."
          value={value.copy.offerShortNotice}
          onValueChange={(v) => setCopy({ offerShortNotice: v })}
          minRows={2}
        />
        <Textarea
          label="Team preference hint"
          value={value.copy.preferenceHint}
          onValueChange={(v) => setCopy({ preferenceHint: v })}
          minRows={2}
        />
        <Button size="sm" variant="flat" className="self-start" onPress={resetCopy}>
          Reset copy to defaults
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card 6 — Notification delivery
// ---------------------------------------------------------------------------

function NotificationDeliveryCard({
  value,
  onChange,
}: {
  value: NotificationDeliveryConfig;
  onChange: (v: NotificationDeliveryConfig) => void;
}) {
  const set = (patch: Partial<NotificationDeliveryConfig>) => onChange({ ...value, ...patch });
  const setEmail = (patch: Partial<NotificationDeliveryConfig['email']>) => onChange({ ...value, email: { ...value.email, ...patch } });

  const statusLine =
    value.email.provider === 'none'
      ? 'Email sender: not configured. In-app only.'
      : value.email.provider === 'worker'
        ? 'Email sender: external worker configured. This settings page cannot confirm it is actually running — check the worker\'s own logs (§6.4).'
        : 'Email sender: Cloud Functions configured (requires a Blaze-plan project).';

  return (
    <div className="bg-content1 border border-divider rounded-large p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">Notification delivery</h2>
      <p className="text-sm text-foreground-500 mb-4">Which channels exist at all, and who drives them.</p>

      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch isSelected={value.inApp} isDisabled size="sm" className="mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">In-app notifications</p>
            <p className="text-xs text-foreground-500 mt-1">Always on — the bell is the only guaranteed channel.</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Switch isSelected={value.email.enabled} onValueChange={(v) => setEmail({ enabled: v })} size="sm" className="mt-0.5" />
          <p className="text-sm font-medium text-foreground">Email notifications</p>
        </div>

        <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${value.email.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <Select
            label="Sender"
            selectedKeys={[value.email.provider]}
            onChange={(e) => e.target.value && setEmail({ provider: e.target.value as NotificationDeliveryConfig['email']['provider'] })}
          >
            <SelectItem key="none">None</SelectItem>
            <SelectItem key="worker">External worker (free, §6.4)</SelectItem>
            <SelectItem key="functions">Cloud Functions (requires Blaze)</SelectItem>
          </Select>
          <Input
            type="number"
            min={0}
            label="Digest manager emails every"
            description="0 = send individually."
            value={String(value.email.digestMinutes)}
            onValueChange={(v) => setEmail({ digestMinutes: Number(v) || 0 })}
            endContent={<span className="text-foreground-400 text-xs">minutes</span>}
          />
          <Input label="From name" value={value.email.fromName} onValueChange={(v) => setEmail({ fromName: v })} />
          <Input label="Reply-to address" type="email" value={value.email.replyTo} onValueChange={(v) => setEmail({ replyTo: v })} />
        </div>

        <div className="flex items-start gap-3 pt-2 border-t border-divider">
          <Switch isSelected={value.allowManagerMailto} onValueChange={(v) => set({ allowManagerMailto: v })} size="sm" className="mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Show managers a &quot;email the queue&quot; button</p>
            <p className="text-xs text-foreground-500 mt-1">Opens their own mail client — no infrastructure required.</p>
          </div>
        </div>

        <div className="bg-content2 rounded-large px-3 py-2 text-xs text-foreground-500">
          {statusLine}
          {value.email.provider !== 'none' && (
            <span className="block mt-1 text-foreground-400">
              (Live delivery-worker heartbeat monitoring isn&apos;t wired into this Phase 0 UI — this line reflects the
              saved configuration only.)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

export interface WaitlistTierTabProps {
  waitlist: WaitlistConfig;
  cancellationPolicy: CancellationPolicyConfig;
  priorityTiers: PriorityTierConfig;
  shiftReminders: ShiftReminderConfig;
  notificationDelivery: NotificationDeliveryConfig;
  eventTypes: string[];
  onChange: (update: {
    waitlist?: WaitlistConfig;
    cancellationPolicy?: CancellationPolicyConfig;
    priorityTiers?: PriorityTierConfig;
    shiftReminders?: ShiftReminderConfig;
    notificationDelivery?: NotificationDeliveryConfig;
  }) => void;
}

export function WaitlistTierTab({
  waitlist,
  cancellationPolicy,
  priorityTiers,
  shiftReminders,
  notificationDelivery,
  eventTypes,
  onChange,
}: WaitlistTierTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <WaitlistCard value={waitlist} onChange={(v) => onChange({ waitlist: v })} />
      <CancellationCard value={cancellationPolicy} onChange={(v) => onChange({ cancellationPolicy: v })} />
      <PriorityTiersCard value={priorityTiers} eventTypes={eventTypes} onChange={(v) => onChange({ priorityTiers: v })} />
      <ShiftRemindersCard
        value={shiftReminders}
        emailReady={notificationDelivery.email.enabled}
        onChange={(v) => onChange({ shiftReminders: v })}
      />
      <MemberCopyCard value={waitlist} onChange={(v) => onChange({ waitlist: v })} />
      <NotificationDeliveryCard value={notificationDelivery} onChange={(v) => onChange({ notificationDelivery: v })} />
    </div>
  );
}
