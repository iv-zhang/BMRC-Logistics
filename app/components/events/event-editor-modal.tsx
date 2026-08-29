'use client';

/** Manager-only create/edit modal for an Event, including its Teams editor
 *  (name + EMT count 2–4, clamped via `clampEmtCount`/`resizeEmtSlots`) and
 *  the [Phase 2 / waitlist plan §2.2] "Priority access" section — staged
 *  tier windows + the per-event waitlist kill switch. */

import { useEffect, useState, type ReactNode } from 'react';
import { Timestamp } from 'firebase/firestore';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Select, SelectItem, Switch, Chip,
} from '@heroui/react';
import { Plus, Trash2, Minus, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { createEvent, updateEvent, createEmptyTeam, resizeEmtSlots, clampEmtCount, type EventActor } from '@/app/lib/events';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import type { Event, EventTeam, EventStatus, EventAccessTier, TierWindow, TierCriteria } from '@/app/types';
import { toJsDate } from './event-utils';

interface EventEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  event?: Event | null;
  actor: EventActor;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}

const STATUS_OPTIONS: { key: EventStatus; label: string }[] = [
  { key: 'draft', label: 'Draft' },
  { key: 'open', label: 'Open for signups' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
];

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a "YYYY-MM-DD" `<input type="date">` value as a local calendar day
 *  (never `new Date(str)`, which parses as UTC and can shift the day). */
function parseDateInputValue(v: string): Date | null {
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDays(d: Date, delta: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + delta);
  return r;
}

// [Phase 2 / waitlist plan §2.2] Same id-generation idiom as `createEmptyTeam`
// (app/lib/events.ts) — a short random suffix, no crypto dependency.
function newTierWindowId(): string {
  return `tier_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * [Phase 2 / waitlist plan §2.2] One `TierWindow` as edited in this modal.
 * `opensAtValue` is the `<input type="date">` string (converted to a
 * `Timestamp` only at save). `leadDays` is the org-config lead-days this
 * window was PREFILLED from, kept around only so a later event-date change
 * can re-resolve `opensAtValue` (see the `dateValue` effect below) — it is
 * cleared to `undefined` for any window the author added by hand, which has
 * no config anchor to recompute from, and is irrelevant once the section is
 * "touched" (see `tierTouched`).
 */
interface EditableTierWindow {
  id: string;
  label: string;
  opensAtValue: string;
  criteria: TierCriteria;
  leadDays?: number;
}

const ACCESS_ROLE_OPTIONS: { label: string; value: NonNullable<TierCriteria['roles']>[number] }[] = [
  { label: 'FTO', value: 'FTO' },
  { label: 'FTO Intern', value: 'fto_intern' },
  { label: 'Member', value: 'member' },
  { label: 'MedOps', value: 'medops' },
  { label: 'Quartermaster', value: 'quartermaster' },
  { label: 'Inventory Helper', value: 'inventory_helper' },
  { label: 'Admin', value: 'admin' },
];

const ACCESS_MEMBER_STATUS_OPTIONS: { label: string; value: NonNullable<TierCriteria['memberStatus']>[number] }[] = [
  { label: 'New', value: 'new' },
  { label: 'Probationary', value: 'probationary' },
  { label: 'General', value: 'general' },
];

function toggleInArray<T>(arr: T[] | undefined, v: T): T[] {
  const cur = arr ?? [];
  return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
}

function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-warning flex items-start gap-1 mt-1">
      <AlertTriangle size={12} className="flex-none mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

/**
 * [Phase 2 / waitlist plan §2.2, §3] Mirrors `waitlist-tier-tab.tsx`'s
 * `CriteriaEditor` idiom exactly (same controls, same disabled-tenure
 * treatment) rather than inventing a second visual language for the same
 * `TierCriteria` shape. Duplicated locally rather than imported since that
 * file's internals aren't exported for reuse.
 */
function TierCriteriaEditor({
  criteria,
  eventTypeOptions,
  onChange,
}: {
  criteria: TierCriteria;
  eventTypeOptions: readonly string[];
  onChange: (c: TierCriteria) => void;
}) {
  const [newTypeKey, setNewTypeKey] = useState(eventTypeOptions[0] ?? '');
  const [newTypeVal, setNewTypeVal] = useState('1');
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
          {ACCESS_ROLE_OPTIONS.map((r) => {
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
          {ACCESS_MEMBER_STATUS_OPTIONS.map((s) => {
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          <Select
            size="sm"
            label="Event type"
            className="max-w-[160px]"
            selectedKeys={newTypeKey ? [newTypeKey] : []}
            onChange={(e) => setNewTypeKey(e.target.value)}
          >
            {eventTypeOptions.map((t) => (
              <SelectItem key={t}>{t}</SelectItem>
            ))}
          </Select>
          <Input size="sm" type="number" min={1} label="Min shifts" className="max-w-[100px]" value={newTypeVal} onValueChange={setNewTypeVal} />
          <Button size="sm" variant="flat" isIconOnly onPress={addShiftsByType} aria-label="Add">
            <Plus size={14} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-2 border-t border-divider">
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
        Tenure fields are disabled until the roster join-date backfill runs (Phase 2 sequencing: configure Terms →
        backfill joined-on dates → enable tenure criteria).
      </p>
    </div>
  );
}

/** One repeatable tier-window row: label, opens-on date, criteria, reorder/remove. */
function AccessTierWindowRow({
  window,
  eventTypeOptions,
  eventDate,
  onChange,
  onOpensAtChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  window: EditableTierWindow;
  eventTypeOptions: readonly string[];
  eventDate: Date | null;
  onChange: (patch: Partial<EditableTierWindow>) => void;
  onOpensAtChange: (v: string) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const opensAt = parseDateInputValue(window.opensAtValue);
  const opensAfterEventDate = !!opensAt && !!eventDate && opensAt.getTime() > eventDate.getTime();

  return (
    <div className="bg-content2 border border-divider rounded-large p-3 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
          <Input size="sm" label="Label" value={window.label} onValueChange={(v) => onChange({ label: v })} isRequired />
          <Input
            size="sm"
            type="date"
            label="Opens"
            value={window.opensAtValue}
            onValueChange={onOpensAtChange}
            isRequired
          />
        </div>
        <div className="flex flex-col gap-1 flex-none">
          <Button isIconOnly size="sm" variant="light" onPress={onMoveUp} isDisabled={!canMoveUp} aria-label="Move up">
            <ArrowUp size={14} />
          </Button>
          <Button isIconOnly size="sm" variant="light" onPress={onMoveDown} isDisabled={!canMoveDown} aria-label="Move down">
            <ArrowDown size={14} />
          </Button>
          <Button isIconOnly size="sm" variant="light" color="danger" onPress={onRemove} aria-label="Remove window">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      {opensAfterEventDate && (
        <InlineWarning>This window opens after the event date — unusual, but allowed.</InlineWarning>
      )}

      <TierCriteriaEditor criteria={window.criteria} eventTypeOptions={eventTypeOptions} onChange={(criteria) => onChange({ criteria })} />
    </div>
  );
}

export default function EventEditorModal({ isOpen, onClose, event, actor, onSaved, onError }: EventEditorModalProps) {
  const { eventTypes, venues, priorityTiers } = useOrgConfig();
  const [name, setName] = useState('');
  const [dateValue, setDateValue] = useState('');
  const [eventType, setEventType] = useState('');
  const [venue, setVenue] = useState('');
  const [location, setLocation] = useState('');
  const [callTime, setCallTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<EventStatus>('draft');
  const [teams, setTeams] = useState<EventTeam[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- [Phase 2 / waitlist plan §2.2] Priority access + waitlist state ---
  const isNewEvent = !event?.id;
  const [tierEnabled, setTierEnabled] = useState(false);
  const [tierWindows, setTierWindows] = useState<EditableTierWindow[]>([]);
  const [generalOpensAtValue, setGeneralOpensAtValue] = useState('');
  const [generalLeadDays, setGeneralLeadDays] = useState<number | undefined>(undefined);
  const [tierRationale, setTierRationale] = useState('');
  // True once the author hand-edits any opens-on date in this section. While
  // false (a fresh, untouched prefill on a NEW event), changing the event
  // date re-resolves every window's date from its remembered `leadDays`; once
  // true, the event date can change freely without silently overwriting a
  // hand-typed date (plan §2.2).
  const [tierTouched, setTierTouched] = useState(false);
  const [waitlistOn, setWaitlistOn] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setName(event?.name ?? '');
    const d = toJsDate(event?.date) ?? new Date();
    setDateValue(toDateInputValue(d));
    setEventType(event?.eventType ?? '');
    setVenue(event?.venue ?? '');
    setLocation(event?.location ?? '');
    // For new events, default to 08:00. For existing events (even legacy ones without
    // callTime), use the stored value or empty string if missing.
    setCallTime(event ? (event.callTime ?? '') : '08:00');
    setEndTime(event?.endTime ?? '');
    setDescription(event?.description ?? '');
    setStatus(event?.status ?? 'draft');
    setTeams(event?.teams && event.teams.length > 0 ? event.teams.map((t) => ({ ...t })) : [createEmptyTeam('Team 1')]);
    setError(null);

    // Editing an existing event: load `accessTier` AS-IS, never re-derived
    // from org config — that's the whole point of the copy (org-config.ts,
    // `EventPolicyOverride` doc comment). A new event starts untiered; the
    // prefill only happens when the author flips the switch on (see
    // `handleTierEnabledChange`).
    if (event?.accessTier) {
      setTierEnabled(!!event.accessTier.enabled);
      setTierWindows(
        (event.accessTier.tiers ?? []).map((t) => ({
          id: t.id,
          label: t.label,
          opensAtValue: toDateInputValue(toJsDate(t.opensAt) ?? d),
          criteria: { ...t.criteria },
        })),
      );
      setGeneralOpensAtValue(toDateInputValue(toJsDate(event.accessTier.generalOpensAt) ?? d));
      setGeneralLeadDays(undefined);
      setTierRationale(event.accessTier.rationale ?? '');
      // Existing events never auto-recompute from the event date.
      setTierTouched(true);
    } else {
      setTierEnabled(false);
      setTierWindows([]);
      setGeneralOpensAtValue('');
      setGeneralLeadDays(undefined);
      setTierRationale('');
      setTierTouched(false);
    }
    setWaitlistOn(event ? event.waitlistEnabled !== false : true);
  }, [isOpen, event]);

  /** Full prefill from `org_settings.priorityTiers`, resolved against `base`
   *  (the event date). [Phase 2 / waitlist plan §2.2] Only ever called for a
   *  NEW event, and only once (when the master switch is first turned on
   *  with no existing window data) — see `handleTierEnabledChange`. */
  const prefillTiersFromConfig = (base: Date) => {
    setTierWindows(
      priorityTiers.defaultTiers.map((t) => ({
        id: newTierWindowId(),
        label: t.label,
        opensAtValue: toDateInputValue(addDays(base, -t.leadDays)),
        criteria: { ...t.criteria },
        leadDays: t.leadDays,
      })),
    );
    setGeneralOpensAtValue(toDateInputValue(addDays(base, -priorityTiers.defaultGeneralLeadDays)));
    setGeneralLeadDays(priorityTiers.defaultGeneralLeadDays);
    setTierRationale(priorityTiers.defaultRationale);
    setTierTouched(false);
  };

  const handleTierEnabledChange = (on: boolean) => {
    setTierEnabled(on);
    if (on && isNewEvent && tierWindows.length === 0) {
      prefillTiersFromConfig(parseDateInputValue(dateValue) ?? new Date());
    }
  };

  // Re-resolve prefilled (leadDays-anchored) dates when the event date
  // changes, but only for a NEW event whose tier section hasn't been
  // hand-edited yet (plan §2.2) — never for an existing event's accessTier.
  useEffect(() => {
    if (!isOpen || !isNewEvent || !tierEnabled || tierTouched) return;
    const date = parseDateInputValue(dateValue);
    if (!date) return;
    setTierWindows((prev) =>
      prev.map((w) => (w.leadDays !== undefined ? { ...w, opensAtValue: toDateInputValue(addDays(date, -w.leadDays)) } : w)),
    );
    if (generalLeadDays !== undefined) {
      setGeneralOpensAtValue(toDateInputValue(addDays(date, -generalLeadDays)));
    }
    // Only the event date should re-trigger this resolution; `tierEnabled`/
    // `tierTouched` are read as guards, not re-run triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateValue]);

  const updateTierWindow = (id: string, patch: Partial<EditableTierWindow>) => {
    setTierWindows((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };

  const updateTierWindowOpensAt = (id: string, v: string) => {
    setTierTouched(true);
    setTierWindows((prev) => prev.map((w) => (w.id === id ? { ...w, opensAtValue: v } : w)));
  };

  const addTierWindow = () => {
    setTierWindows((prev) => [
      ...prev,
      { id: newTierWindowId(), label: 'New window', opensAtValue: '', criteria: { combine: 'any' } },
    ]);
  };

  const removeTierWindow = (id: string) => {
    setTierWindows((prev) => prev.filter((w) => w.id !== id));
  };

  const moveTierWindow = (id: string, dir: -1 | 1) => {
    setTierWindows((prev) => {
      const idx = prev.findIndex((w) => w.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const updateGeneralOpensAt = (v: string) => {
    setTierTouched(true);
    setGeneralOpensAtValue(v);
  };

  const updateTeam = (teamId: string, patch: Partial<EventTeam>) => {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, ...patch } : t)));
  };

  const changeEmtCount = (teamId: string, delta: number) => {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const count = clampEmtCount(t.emtCount + delta);
        return { ...t, emtCount: count, emtSlots: resizeEmtSlots(t.emtSlots, count) };
      }),
    );
  };

  const toggleFtoIntern = (teamId: string, on: boolean) => {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        // Turning off clears any stale assignment; turning on ensures the slot
        // exists without clobbering one that was already there.
        const ftoInternSlot = on ? (t.ftoInternSlot ?? {}) : {};
        return { ...t, hasFtoIntern: on, ftoInternSlot };
      }),
    );
  };

  const addTeam = () => {
    setTeams((prev) => [...prev, createEmptyTeam(`Team ${prev.length + 1}`)]);
  };

  const removeTeam = (teamId: string) => {
    setTeams((prev) => (prev.length <= 1 ? prev : prev.filter((t) => t.id !== teamId)));
  };

  // Always include the current value as an option even if it's not in the
  // configured list, so editing an old event doesn't silently drop its data.
  const eventTypeOptions = eventType && !eventTypes.includes(eventType) ? [...eventTypes, eventType] : eventTypes;
  const venueOptions = venue && !venues.some((v) => v.name === venue) ? [...venues, { id: '__custom__', name: venue }] : venues;

  const handleVenueChange = (name: string) => {
    setVenue(name);
    const match = venues.find((v) => v.name === name);
    if (match?.location) setLocation(match.location);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Event name is required');
      return;
    }
    const date = parseDateInputValue(dateValue);
    if (!date) {
      setError('Event date is required');
      return;
    }
    if (!callTime.trim()) {
      setError('Call time is required — it sets when the shift starts, and drives reminders and lateness.');
      return;
    }

    // [Phase 2 / waitlist plan §2.2] Priority-access validation, surfaced
    // through the same inline `error` state as everything above it — no
    // second error mechanism.
    let accessTier: EventAccessTier;
    if (tierEnabled) {
      if (!generalOpensAtValue) {
        setError('Priority access is on, but "Opens to everyone" has no date.');
        return;
      }
      const generalDate = parseDateInputValue(generalOpensAtValue);
      if (!generalDate) {
        setError('"Opens to everyone" date is invalid.');
        return;
      }
      for (const w of tierWindows) {
        if (!w.label.trim()) {
          setError('Every priority window needs a label.');
          return;
        }
        if (!w.opensAtValue) {
          setError(`Priority window "${w.label}" needs an opens-on date.`);
          return;
        }
      }
      const resolvedWindows = tierWindows.map((w) => ({
        id: w.id,
        label: w.label.trim(),
        opensAtDate: parseDateInputValue(w.opensAtValue) as Date,
        criteria: w.criteria,
      }));
      const deadWindow = resolvedWindows.find((w) => w.opensAtDate.getTime() >= generalDate.getTime());
      if (deadWindow) {
        setError(
          `"${deadWindow.label}" opens on or after general access (${generalOpensAtValue}) — a priority window ` +
            'that opens after general access is dead code, since everyone already has access by then.',
        );
        return;
      }
      // Saved sorted ascending by opensAt regardless of row order, so the
      // member-facing schedule (drawer) never renders out of order.
      const sortedWindows: TierWindow[] = [...resolvedWindows]
        .sort((a, b) => a.opensAtDate.getTime() - b.opensAtDate.getTime())
        .map((w) => ({ id: w.id, label: w.label, opensAt: Timestamp.fromDate(w.opensAtDate), criteria: w.criteria }));
      accessTier = {
        enabled: true,
        tiers: sortedWindows,
        generalOpensAt: Timestamp.fromDate(generalDate),
        rationale: tierRationale.trim(),
      };
    } else {
      // Explicit `enabled: false` object rather than omitting the field:
      // `updateEvent`'s patch only touches a key when it is `!== undefined`,
      // so omitting `accessTier` on an edit would silently leave a
      // previously-tiered event's old accessTier in place instead of turning
      // tiering off. `generalOpensAt`/`rationale` are unused dead values here
      // (every read path checks `enabled` first) but the type requires them.
      accessTier = { enabled: false, tiers: [], generalOpensAt: Timestamp.fromDate(date), rationale: '' };
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        date,
        eventType: eventType || undefined,
        venue: venue || undefined,
        location: location || undefined,
        callTime,
        endTime: endTime || undefined,
        description: description || undefined,
        status,
        teams,
        accessTier,
        waitlistEnabled: waitlistOn,
      };
      if (event?.id) {
        await updateEvent(event.id, payload);
        onSaved('Event updated');
      } else {
        await createEvent(payload, actor);
        onSaved('Event created');
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save event';
      setError(msg);
      onError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} placement="center" scrollBehavior="inside" size="2xl">
      <ModalContent>
        <ModalHeader className="text-base font-semibold">{event ? 'Edit event' : 'New event'}</ModalHeader>
        <ModalBody className="gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Name" placeholder="Spring Concert" value={name} onValueChange={setName} isRequired autoFocus />
            <Input label="Date" type="date" value={dateValue} onValueChange={setDateValue} isRequired />
            <Select
              label="Event type"
              placeholder="Select a type"
              selectedKeys={eventType ? [eventType] : []}
              onSelectionChange={(keys) => setEventType(String(Array.from(keys)[0] ?? ''))}
            >
              {eventTypeOptions.map((t) => (
                <SelectItem key={t}>{t}</SelectItem>
              ))}
            </Select>
            <Select
              label="Status"
              selectedKeys={[status]}
              onSelectionChange={(keys) => setStatus(String(Array.from(keys)[0] ?? 'draft') as EventStatus)}
            >
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.key}>{s.label}</SelectItem>
              ))}
            </Select>
            <Select
              label="Venue"
              placeholder="Select a venue"
              selectedKeys={venue ? [venue] : []}
              onSelectionChange={(keys) => handleVenueChange(String(Array.from(keys)[0] ?? ''))}
            >
              {venueOptions.map((v) => (
                <SelectItem key={v.name}>{v.name}</SelectItem>
              ))}
            </Select>
            <Input label="Location" placeholder="Address / area" value={location} onValueChange={setLocation} />
            <Input label="Call time" type="time" value={callTime} onValueChange={setCallTime} isRequired />
            <Input label="End time" type="time" value={endTime} onValueChange={setEndTime} />
          </div>
          <Textarea label="Description" value={description} onValueChange={setDescription} minRows={2} />

          {/* [Phase 2 / waitlist plan §2.2] Waitlist kill switch + staged
              priority-access tiers. The waitlist switch is the "prominent
              per-event switch" the plan calls for, so it stays visible; the
              tier section collapses to just its switch when off, to keep this
              already-long modal scannable. */}
          <div className="border border-divider rounded-large p-4 flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
              Waitlist &amp; priority access
            </span>

            <div className="flex items-start gap-3">
              <Switch isSelected={waitlistOn} onValueChange={setWaitlistOn} size="sm" className="mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Enable waitlist</p>
                <p className="text-xs text-foreground-500 mt-1">
                  When a team fills up, members can join a queue instead of seeing &quot;Full.&quot;
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 pt-3 border-t border-divider">
              <div className="flex items-start gap-3">
                <Switch isSelected={tierEnabled} onValueChange={handleTierEnabledChange} size="sm" className="mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">Priority access tiers</p>
                  <p className="text-xs text-foreground-500 mt-1">
                    Stage sign-up so members who meet a window&apos;s criteria can sign up before everyone else. Off = open
                    to everyone immediately.
                  </p>
                </div>
              </div>

              {tierEnabled && (
                <div className="flex flex-col gap-3 pl-1">
                  <div className="flex flex-col gap-3">
                    {tierWindows.map((w, idx) => (
                      <AccessTierWindowRow
                        key={w.id}
                        window={w}
                        eventTypeOptions={eventTypeOptions}
                        eventDate={parseDateInputValue(dateValue)}
                        onChange={(patch) => updateTierWindow(w.id, patch)}
                        onOpensAtChange={(v) => updateTierWindowOpensAt(w.id, v)}
                        onRemove={() => removeTierWindow(w.id)}
                        onMoveUp={() => moveTierWindow(w.id, -1)}
                        onMoveDown={() => moveTierWindow(w.id, 1)}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < tierWindows.length - 1}
                      />
                    ))}
                    {tierWindows.length === 0 && (
                      <p className="text-xs text-foreground-400">No priority windows — everyone signs up starting on the date below.</p>
                    )}
                  </div>

                  <Button size="sm" variant="flat" color="primary" startContent={<Plus size={14} />} className="self-start" onPress={addTierWindow}>
                    Add window
                  </Button>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-divider">
                    <Input
                      type="date"
                      label="Opens to everyone"
                      value={generalOpensAtValue}
                      onValueChange={updateGeneralOpensAt}
                      isRequired
                    />
                  </div>
                  <Textarea
                    label="Rationale"
                    description="Shown to a member BEFORE they hit the restriction, explaining who gets in early and why."
                    value={tierRationale}
                    onValueChange={setTierRationale}
                    minRows={2}
                    isRequired
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Teams</span>
              <Button size="sm" variant="flat" color="primary" startContent={<Plus size={14} />} onPress={addTeam}>
                Add team
              </Button>
            </div>
            {teams.map((team) => (
              <div key={team.id} className="border border-divider rounded-large p-3 flex items-center gap-3 flex-wrap">
                <Input
                  size="sm"
                  className="flex-1 min-w-[140px]"
                  value={team.name}
                  onValueChange={(v) => updateTeam(team.id, { name: v })}
                  label="Team name"
                />
                <div className="flex items-center gap-2 flex-none">
                  <span className="text-xs text-foreground-500">EMTs</span>
                  <Button size="sm" isIconOnly variant="bordered" onPress={() => changeEmtCount(team.id, -1)} aria-label="Fewer EMTs">
                    <Minus size={13} />
                  </Button>
                  <span className="font-mono text-sm font-semibold tabular-nums w-4 text-center">{team.emtCount}</span>
                  <Button size="sm" isIconOnly variant="bordered" onPress={() => changeEmtCount(team.id, 1)} aria-label="More EMTs">
                    <Plus size={13} />
                  </Button>
                </div>
                <div className="flex items-center gap-2 flex-none">
                  <Switch
                    size="sm"
                    isSelected={!!team.hasFtoIntern}
                    onValueChange={(on) => toggleFtoIntern(team.id, on)}
                    aria-label="FTO intern"
                  >
                    <span className="text-xs text-foreground-500">
                      FTO intern
                      <span className="block text-[10px] text-foreground-400 leading-tight">
                        Supervised trainee — not counted toward headcount
                      </span>
                    </span>
                  </Switch>
                </div>
                <Button
                  size="sm"
                  variant="light"
                  color="danger"
                  isIconOnly
                  isDisabled={teams.length <= 1}
                  onPress={() => removeTeam(team.id)}
                  aria-label="Remove team"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={onClose} isDisabled={saving}>
            Cancel
          </Button>
          <Button color="primary" onPress={handleSave} isLoading={saving}>
            {event ? 'Save changes' : 'Create event'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
