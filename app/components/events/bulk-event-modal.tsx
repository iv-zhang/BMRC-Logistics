'use client';

/**
 * [Phase 5b / waitlist plan §5.9, R5] "Add many events" — the bulk creation
 * modal opened from `/events` by a manager (`New event ▾ → Add many`, gated
 * by `isEventManagerRole` in the page, not here).
 *
 * Three steps, one modal:
 *   1. Repeat (template + recurrence-or-dates) or Paste (TSV/CSV) → produces
 *      `DraftEventRow[]` via the pure headless core in `app/lib/event-series.ts`.
 *   2. Review — NOT skippable. An editable grid with client-side conflict
 *      flags (`diagnoseDraftRows`) against the page's already-loaded `events`
 *      feed. No Firestore reads happen in this file.
 *   3. Create — `createEventsBulk` (never rejects; collects failures),
 *      with a retry for failed rows and a same-session, id-based undo.
 *
 * The one bug this whole feature exists to prevent (§5.9): a template's
 * `accessTierPreset` is LEAD DAYS, never an absolute date, and every row's
 * `accessTier` must be resolved from THAT row's own date. `expandEventSeries`
 * already does this once per row; the one place *this file* must repeat that
 * resolution is after an inline date edit in the Step 2 grid — see
 * `updateRowDate` below.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
  Tabs,
  Tab,
  Chip,
  Switch,
  ButtonGroup,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Spinner,
} from '@heroui/react';
import { Plus, Trash2, ChevronDown, AlertTriangle, Undo2, RotateCcw, Info } from 'lucide-react';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { FieldHint } from '@/app/components/field-hint';
import { toJsDate } from './event-utils';
import {
  expandEventSeries,
  formatSeriesName,
  resolveAccessTierForDate,
  parsePastedEvents,
  diagnoseDraftRows,
  draftRowToCreateInput,
  type EventSeriesSpec,
  type SeriesRecurrence,
  type DraftEventRow,
} from '@/app/lib/event-series';
import {
  createEventsBulk,
  deleteBulkCreatedEvents,
  type EventActor,
  type CreateEventInput,
  type BulkCreateResult,
} from '@/app/lib/events';
import type { Event, EventStatus } from '@/app/types';
import type { EventTemplateDef, EventTemplateTeamDef } from '@/app/config/org-config';
import { parseDateInputValue, toDateInputValue } from '@/app/lib/date-input';

// ---------------------------------------------------------------------------
// Pinned public contract — agent C wires against this exactly.
// ---------------------------------------------------------------------------

export interface BulkEventModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The page's already-loaded events feed. Used ONLY for client-side conflict
   *  flags — this modal performs no Firestore reads. */
  events: Event[];
  actor: EventActor;
  /** Called after a bulk run finishes (and after an undo), for the page's toast. */
  onDone: (ok: boolean, msg: string) => void;
}

// ---------------------------------------------------------------------------
// Local pure helpers
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_NAME_PATTERN = '{type} — {date:MMM d}';
const DEFAULT_FALLBACK_TEAMS: EventTemplateTeamDef[] = [{ name: 'Team 1', emtCount: 3, hasFtoIntern: true }];

/** Compact team-shape summary for the review grid, e.g. "1× FTO+3". Mirrors
 *  the same fallback `draftRowToCreateInput` applies to an empty team list,
 *  so the grid never shows "0 teams" for a row that will actually get one. */
function summarizeTeams(teams: EventTemplateTeamDef[]): string {
  const list = teams.length > 0 ? teams : DEFAULT_FALLBACK_TEAMS;
  const groups = new Map<string, number>();
  for (const t of list) {
    const key = `${t.emtCount}|${t.hasFtoIntern ? 1 : 0}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return Array.from(groups.entries())
    .map(([key, n]) => {
      const [emt, intern] = key.split('|');
      return `${n}× FTO${intern === '1' ? '+I' : ''}+${emt}`;
    })
    .join(', ');
}

type CreatedItem = BulkCreateResult['created'][number];
type FailedItem = BulkCreateResult['failed'][number];
type UndoResult = { deleted: string[]; kept: { id: string; name: string; reason: string }[] };

const STEP_LABELS: Record<1 | 2 | 3, string> = {
  1: 'What to create',
  2: 'Review',
  3: 'Create',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BulkEventModal({ isOpen, onClose, events, actor, onDone }: BulkEventModalProps) {
  const { eventTemplates, venues, eventTypes } = useOrgConfig();

  // ---- Step 1 state ----
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [activeTab, setActiveTab] = useState<'repeat' | 'paste'>('repeat');
  const [templateId, setTemplateId] = useState<string>('');
  const [namePattern, setNamePattern] = useState(DEFAULT_NAME_PATTERN);

  const [patternMode, setPatternMode] = useState<'recurrence' | 'dates'>('recurrence');
  const [everyNWeeksStr, setEveryNWeeksStr] = useState('1');
  const [weekdaySet, setWeekdaySet] = useState<Set<number>>(new Set());
  const [fromValue, setFromValue] = useState('');
  const [toValue, setToValue] = useState('');
  const [dateList, setDateList] = useState<string[]>(['']);

  // Repeat-tab inline fields — the "no template, fill it in yourself" path.
  const [eventTypeField, setEventTypeField] = useState('');
  const [venueField, setVenueField] = useState('');
  const [locationField, setLocationField] = useState('');
  const [callTimeField, setCallTimeField] = useState('');
  const [endTimeField, setEndTimeField] = useState('');
  const [descriptionField, setDescriptionField] = useState('');
  const [waitlistField, setWaitlistField] = useState(true);

  const [pasteText, setPasteText] = useState('');

  // ---- Step 2 state ----
  const [rows, setRows] = useState<DraftEventRow[]>([]);
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  // The template a batch was generated from, kept ONLY so an inline date edit
  // in the grid can re-resolve that row's accessTier from ITS OWN new date —
  // never so a whole-series value can be copied across rows. See
  // `updateRowDate`.
  const [templateForResolve, setTemplateForResolve] = useState<EventTemplateDef | undefined>(undefined);
  const [createStatus, setCreateStatus] = useState<EventStatus>('draft');

  // ---- Step 3 state ----
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [created, setCreated] = useState<CreatedItem[]>([]);
  const [failed, setFailed] = useState<FailedItem[]>([]);
  const [seriesIdState, setSeriesIdState] = useState<string | undefined>(undefined);
  const [undoing, setUndoing] = useState(false);
  const [undoUsed, setUndoUsed] = useState(false);
  const [undoResult, setUndoResult] = useState<UndoResult | null>(null);

  // Fresh state every time the modal opens — this is also what makes the
  // undo id list trustworthy: `created` only ever grows via this component's
  // own `runBatch` calls between one open and the next.
  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setActiveTab('repeat');
    setTemplateId('');
    setNamePattern(DEFAULT_NAME_PATTERN);
    setPatternMode('recurrence');
    setEveryNWeeksStr('1');
    setWeekdaySet(new Set());
    setFromValue('');
    setToValue('');
    setDateList(['']);
    setEventTypeField('');
    setVenueField('');
    setLocationField('');
    setCallTimeField('');
    setEndTimeField('');
    setDescriptionField('');
    setWaitlistField(true);
    setPasteText('');
    setRows([]);
    setIgnoredColumns([]);
    setParseWarnings([]);
    setTemplateForResolve(undefined);
    setCreateStatus('draft');
    setIsRunning(false);
    setProgress(null);
    setCreated([]);
    setFailed([]);
    setSeriesIdState(undefined);
    setUndoing(false);
    setUndoUsed(false);
    setUndoResult(null);
  }, [isOpen]);

  const selectedTemplate = useMemo(
    () => eventTemplates.find((t) => t.id === templateId),
    [eventTemplates, templateId],
  );

  const handleTemplateSelect = (id: string) => {
    setTemplateId(id);
    const t = eventTemplates.find((x) => x.id === id);
    if (t) {
      setEventTypeField(t.eventType ?? '');
      setVenueField(t.venue ?? '');
      setLocationField(t.location ?? '');
      setCallTimeField(t.callTime ?? '');
      setEndTimeField(t.endTime ?? '');
      setDescriptionField(t.description ?? '');
      setWaitlistField(t.waitlistEnabled ?? true);
    }
  };

  const handleVenueFieldChange = (name: string) => {
    setVenueField(name);
    const match = venues.find((v) => v.name === name);
    if (match?.location) setLocationField(match.location);
  };

  // ---- Step 1: preview + generation ----

  const overrides: EventSeriesSpec['overrides'] = {
    eventType: eventTypeField.trim() || undefined,
    venue: venueField.trim() || undefined,
    location: locationField.trim() || undefined,
    callTime: callTimeField.trim() || undefined,
    endTime: endTimeField.trim() || undefined,
    description: descriptionField.trim() || undefined,
    waitlistEnabled: waitlistField,
  };

  const previewDate = useMemo(() => {
    if (patternMode === 'dates') {
      for (const v of dateList) {
        const d = parseDateInputValue(v);
        if (d) return d;
      }
      return null;
    }
    return parseDateInputValue(fromValue);
  }, [patternMode, dateList, fromValue]);

  const previewName = previewDate
    ? formatSeriesName(namePattern, {
        date: previewDate,
        index: 0,
        eventType: overrides.eventType,
        venue: overrides.venue,
      })
    : null;

  const recurrenceValid =
    patternMode === 'recurrence'
      ? !!parseDateInputValue(fromValue) && !!parseDateInputValue(toValue) && weekdaySet.size > 0
      : dateList.some((v) => !!parseDateInputValue(v));

  const canGenerate = activeTab === 'repeat' ? recurrenceValid : pasteText.trim().length > 0;

  const toggleWeekday = (n: number) => {
    setWeekdaySet((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const handleGenerate = () => {
    const keyPrefix = `bulk_${Date.now()}`;
    if (activeTab === 'repeat') {
      const spec: EventSeriesSpec = {
        template: selectedTemplate,
        namePattern,
        overrides,
        ...(patternMode === 'dates'
          ? { dates: dateList.map(parseDateInputValue).filter((d): d is Date => !!d) }
          : {
              recurrence: {
                from: parseDateInputValue(fromValue) as Date,
                to: parseDateInputValue(toValue) as Date,
                weekdays: Array.from(weekdaySet).sort((a, b) => a - b),
                everyNWeeks: Number(everyNWeeksStr) || 1,
              } as SeriesRecurrence,
            }),
      };
      const generated = expandEventSeries(spec, { keyPrefix });
      setRows(generated);
      setIgnoredColumns([]);
      setParseWarnings([]);
    } else {
      const { rows: generated, ignoredColumns: ignored, warnings } = parsePastedEvents(pasteText, selectedTemplate, {
        namePattern,
        keyPrefix,
      });
      setRows(generated);
      setIgnoredColumns(ignored);
      setParseWarnings(warnings);
    }
    setTemplateForResolve(selectedTemplate);
    setStep(2);
  };

  // ---- Step 2: diagnosis + row editing ----

  const existing = useMemo(
    () => events.map((e) => ({ name: e.name, date: toJsDate(e.date) })),
    [events],
  );

  const diagnosis = useMemo(() => diagnoseDraftRows(rows, existing), [rows, existing]);

  const updateRowField = (key: string, patch: Partial<DraftEventRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  /**
   * §5.9's named worst-case bug, guarded here: an inline date edit must
   * re-resolve THIS row's `accessTier` from its OWN new date against the
   * template's lead-day preset — never carry the previous date's resolved
   * tier forward. Same call `expandEventSeries` makes per row, just invoked
   * again for the one row that changed.
   */
  const updateRowDate = (key: string, dateInputValue: string) => {
    const newDate = parseDateInputValue(dateInputValue);
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              date: newDate,
              accessTier: newDate ? resolveAccessTierForDate(templateForResolve?.accessTierPreset, newDate) : undefined,
            }
          : r,
      ),
    );
  };

  const deleteRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const totalRows = rows.length;
  const invalidCount = rows.filter((r) => diagnosis[r.key]?.blocked).length;
  const duplicateCount = rows.filter((r) => diagnosis[r.key]?.flags.includes('duplicate')).length;
  const creatableCount = totalRows - invalidCount;

  const summaryLine = [
    `${totalRows} event${totalRows === 1 ? '' : 's'}`,
    invalidCount > 0 ? `${invalidCount} needs attention` : null,
    duplicateCount > 0 ? `${duplicateCount} already exist?` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // ---- Step 3: create / retry / undo ----

  async function runBatch(rowsToRun: DraftEventRow[]) {
    if (rowsToRun.length === 0) return;
    setIsRunning(true);
    setProgress({ done: 0, total: rowsToRun.length });
    try {
      const bulkRows = rowsToRun.map((r) => ({
        key: r.key,
        input: { ...draftRowToCreateInput(r), status: createStatus } as CreateEventInput,
      }));
      const result = await createEventsBulk(bulkRows, actor, {
        seriesId: seriesIdState,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setSeriesIdState(result.seriesId);
      setCreated((prev) => [...prev, ...result.created]);
      setFailed((prev) => {
        const runKeys = new Set(rowsToRun.map((r) => r.key));
        return [...prev.filter((f) => !runKeys.has(f.key)), ...result.failed];
      });
      const ok = result.failed.length === 0;
      onDone(
        ok,
        ok
          ? `Created ${result.created.length} event${result.created.length === 1 ? '' : 's'}.`
          : `Created ${result.created.length} of ${rowsToRun.length} events — ${result.failed.length} failed.`,
      );
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  }

  const handleConfirmCreate = async () => {
    const creatable = rows.filter((r) => !diagnosis[r.key]?.blocked);
    if (creatable.length === 0) return;
    setStep(3);
    await runBatch(creatable);
  };

  const handleRetryFailed = async () => {
    const failedKeys = new Set(failed.map((f) => f.key));
    const retryRows = rows.filter((r) => failedKeys.has(r.key));
    await runBatch(retryRows);
  };

  const handleUndo = async () => {
    if (undoUsed || created.length === 0) return;
    setUndoing(true);
    try {
      // Exactly this session's created events: `created` is local state,
      // reset only when the modal opens (see the reset effect above) and
      // appended to only inside `runBatch`, which only this component ever
      // calls. Deleting by id — never by querying `seriesId` — is what keeps
      // this from being able to reach an earlier run's events.
      const ids = created.map((c) => c.id);
      const result = await deleteBulkCreatedEvents(ids);
      setUndoResult(result);
      setUndoUsed(true);
      const keptMsg = result.kept.length > 0 ? ` ${result.kept.length} kept.` : '';
      onDone(true, `Undo: deleted ${result.deleted.length} event${result.deleted.length === 1 ? '' : 's'}.${keptMsg}`);
    } finally {
      setUndoing(false);
    }
  };

  // ---------------------------------------------------------------------------

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !isRunning) onClose();
      }}
      placement="center"
      scrollBehavior="inside"
      size="5xl"
      isDismissable={!isRunning}
      isKeyboardDismissDisabled={isRunning}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span>Add many events</span>
          <span className="text-xs font-normal text-foreground-400">
            Step {step} of 3 — {STEP_LABELS[step]}
          </span>
        </ModalHeader>

        <ModalBody className="gap-4">
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {eventTemplates.length > 0 ? (
                  <Select
                    label="Template"
                    placeholder="No template — fill in the fields below"
                    selectedKeys={templateId ? [templateId] : []}
                    onSelectionChange={(keys) => handleTemplateSelect(String(Array.from(keys)[0] ?? ''))}
                  >
                    {eventTemplates.map((t) => (
                      <SelectItem key={t.id}>{t.name}</SelectItem>
                    ))}
                  </Select>
                ) : (
                  <div className="text-xs text-foreground-500 bg-content2 border border-divider rounded-medium p-3 flex items-start gap-2">
                    <Info size={14} className="flex-none mt-0.5 text-foreground-400" />
                    <span>
                      No templates yet. Add one at <strong>Settings → Events &amp; Venues → Event Templates</strong>, or
                      fill in the fields below to create events without one.
                    </span>
                  </div>
                )}
                <div>
                  <Input
                    label="Name pattern"
                    value={namePattern}
                    onValueChange={setNamePattern}
                    endContent={<FieldHint text="Unknown tokens are left as-is, so a typo shows up in the preview." />}
                  />
                  <p className="text-[11px] text-foreground-400 mt-1">
                    Tokens: <code>{'{date:MMM d}'}</code> · <code>{'{date:MMM d, yyyy}'}</code> ·{' '}
                    <code>{'{date:yyyy-MM-dd}'}</code> · <code>{'{n}'}</code> · <code>{'{type}'}</code> ·{' '}
                    <code>{'{venue}'}</code>
                  </p>
                  {previewName !== null && (
                    <p className="text-xs text-foreground-500 mt-1">
                      Preview: <span className="font-medium text-foreground">{previewName}</span>
                    </p>
                  )}
                </div>
              </div>

              <Tabs
                aria-label="Bulk creation method"
                selectedKey={activeTab}
                onSelectionChange={(k) => setActiveTab(k as 'repeat' | 'paste')}
                variant="underlined"
              >
                <Tab key="repeat" title="Repeat">
                  <div className="flex flex-col gap-4 pt-2">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={patternMode === 'recurrence' ? 'solid' : 'flat'}
                        color={patternMode === 'recurrence' ? 'primary' : 'default'}
                        onPress={() => setPatternMode('recurrence')}
                      >
                        Recurring pattern
                      </Button>
                      <Button
                        size="sm"
                        variant={patternMode === 'dates' ? 'solid' : 'flat'}
                        color={patternMode === 'dates' ? 'primary' : 'default'}
                        onPress={() => setPatternMode('dates')}
                      >
                        Hand-picked dates
                      </Button>
                    </div>

                    {patternMode === 'recurrence' ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-foreground-500">Every</span>
                          <Input
                            type="number"
                            min={1}
                            size="sm"
                            className="w-20"
                            value={everyNWeeksStr}
                            onValueChange={setEveryNWeeksStr}
                            aria-label="Every N weeks"
                          />
                          <span className="text-sm text-foreground-500">week(s) on</span>
                          <div className="flex gap-1">
                            {WEEKDAY_LABELS.map((label, i) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => toggleWeekday(i)}
                                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors duration-150 ${
                                  weekdaySet.has(i)
                                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 max-w-sm">
                          <Input label="From" type="date" size="sm" value={fromValue} onValueChange={setFromValue} />
                          <Input label="To" type="date" size="sm" value={toValue} onValueChange={setToValue} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {dateList.map((v, i) => (
                          <div key={i} className="flex items-center gap-2 max-w-xs">
                            <Input
                              type="date"
                              size="sm"
                              value={v}
                              onValueChange={(nv) => setDateList((prev) => prev.map((x, j) => (j === i ? nv : x)))}
                              aria-label={`Date ${i + 1}`}
                            />
                            <Button
                              size="sm"
                              variant="light"
                              isIconOnly
                              isDisabled={dateList.length <= 1}
                              onPress={() => setDateList((prev) => prev.filter((_, j) => j !== i))}
                              aria-label="Remove date"
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        ))}
                        <Button
                          size="sm"
                          variant="flat"
                          startContent={<Plus size={14} />}
                          className="w-fit"
                          onPress={() => setDateList((prev) => [...prev, ''])}
                        >
                          Add date
                        </Button>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-divider">
                      <div>
                        <Input
                          label="Event type"
                          list="bulk-event-type-options"
                          value={eventTypeField}
                          onValueChange={setEventTypeField}
                        />
                        <datalist id="bulk-event-type-options">
                          {eventTypes.map((t) => (
                            <option key={t} value={t} />
                          ))}
                        </datalist>
                      </div>
                      <div>
                        <Input label="Venue" list="bulk-venue-options" value={venueField} onValueChange={handleVenueFieldChange} />
                        <datalist id="bulk-venue-options">
                          {venues.map((v) => (
                            <option key={v.id} value={v.name} />
                          ))}
                        </datalist>
                      </div>
                      <Input label="Location" value={locationField} onValueChange={setLocationField} />
                      <Input label="Call time" type="time" value={callTimeField} onValueChange={setCallTimeField} isRequired />
                      <Input label="End time" type="time" value={endTimeField} onValueChange={setEndTimeField} />
                      <div className="flex items-center gap-2">
                        <Switch size="sm" isSelected={waitlistField} onValueChange={setWaitlistField} />
                        <span className="text-sm text-foreground-600">Waitlist enabled</span>
                      </div>
                      <Textarea
                        label="Description"
                        value={descriptionField}
                        onValueChange={setDescriptionField}
                        className="sm:col-span-3"
                        minRows={2}
                      />
                    </div>
                  </div>
                </Tab>

                <Tab key="paste" title="Paste">
                  <div className="flex flex-col gap-2 pt-2">
                    <Textarea
                      label="Paste from a spreadsheet"
                      placeholder={'Date\tName\tVenue\n9/6/2026\tHome opener\tZellerbach'}
                      value={pasteText}
                      onValueChange={setPasteText}
                      minRows={8}
                      className="font-mono text-xs"
                    />
                    <p className="text-[11px] text-foreground-400">
                      First row is the header. Recognised columns: Date, Name, Type, Venue, Location, Call time, End
                      time, Description (Notes also maps to Description). Missing fields fall back to the selected
                      template.
                    </p>
                  </div>
                </Tab>
              </Tabs>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              {ignoredColumns.length > 0 && (
                <div className="text-xs text-warning bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-medium p-2 flex items-start gap-2">
                  <AlertTriangle size={14} className="flex-none mt-0.5" />
                  <span>
                    Column{ignoredColumns.length === 1 ? '' : 's'} not recognized and ignored:{' '}
                    <strong>{ignoredColumns.join(', ')}</strong>
                  </span>
                </div>
              )}
              {parseWarnings.length > 0 && (
                <div className="text-xs text-warning bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-medium p-2 flex flex-col gap-1">
                  {parseWarnings.map((w, i) => (
                    <span key={i}>{w}</span>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{summaryLine}</span>
              </div>

              <div className="overflow-hidden rounded-large border border-divider bg-content1">
                <div className="overflow-auto" style={{ maxHeight: 360 }}>
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-divider bg-content2">
                        {['Date', 'Name', 'Type', 'Venue', 'Call', 'End', 'Teams', 'Status', ''].map((h) => (
                          <th
                            key={h}
                            className="whitespace-nowrap px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-foreground-400"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-divider">
                      {rows.map((row) => {
                        const diag = diagnosis[row.key];
                        return (
                          <tr key={row.key} className={diag?.blocked ? 'bg-danger-50/50 dark:bg-danger-900/10' : ''}>
                            <td className="p-1 min-w-[140px]">
                              <Input
                                type="date"
                                size="sm"
                                value={row.date ? toDateInputValue(row.date) : ''}
                                onValueChange={(v) => updateRowDate(row.key, v)}
                                aria-label="Date"
                              />
                            </td>
                            <td className="p-1 min-w-[180px]">
                              <Input
                                size="sm"
                                value={row.name}
                                onValueChange={(v) => updateRowField(row.key, { name: v })}
                                aria-label="Name"
                              />
                            </td>
                            <td className="p-1 min-w-[110px]">
                              <Input
                                size="sm"
                                value={row.eventType ?? ''}
                                onValueChange={(v) => updateRowField(row.key, { eventType: v || undefined })}
                                aria-label="Type"
                              />
                            </td>
                            <td className="p-1 min-w-[130px]">
                              <Input
                                size="sm"
                                value={row.venue ?? ''}
                                onValueChange={(v) => updateRowField(row.key, { venue: v || undefined })}
                                aria-label="Venue"
                              />
                            </td>
                            <td className="p-1 min-w-[95px]">
                              <Input
                                type="time"
                                size="sm"
                                value={row.callTime}
                                onValueChange={(v) => updateRowField(row.key, { callTime: v })}
                                aria-label="Call time"
                              />
                            </td>
                            <td className="p-1 min-w-[95px]">
                              <Input
                                type="time"
                                size="sm"
                                value={row.endTime ?? ''}
                                onValueChange={(v) => updateRowField(row.key, { endTime: v || undefined })}
                                aria-label="End time"
                              />
                            </td>
                            <td className="p-2 whitespace-nowrap text-xs text-foreground-500">
                              {summarizeTeams(row.teams)}
                            </td>
                            <td className="p-2 min-w-[160px]">
                              {diag && diag.flags.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                  {diag.flags.map((flag, i) => (
                                    <Chip
                                      key={flag}
                                      size="sm"
                                      variant="flat"
                                      color={flag === 'invalid' ? 'danger' : flag === 'duplicate' ? 'warning' : 'default'}
                                      className="text-[10px] h-5"
                                    >
                                      {diag.reasons[i]}
                                    </Chip>
                                  ))}
                                </div>
                              ) : (
                                <Chip size="sm" variant="flat" color="success" className="text-[10px] h-5">
                                  OK
                                </Chip>
                              )}
                            </td>
                            <td className="p-1">
                              <Button
                                size="sm"
                                variant="light"
                                color="danger"
                                isIconOnly
                                onPress={() => deleteRow(row.key)}
                                aria-label="Delete row"
                              >
                                <Trash2 size={14} />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={9} className="p-6 text-center text-sm text-foreground-400">
                            No rows. Go back and generate some.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-4">
              {isRunning && progress && (
                <div className="flex items-center gap-3 text-sm text-foreground-500">
                  <Spinner size="sm" />
                  <span>
                    Creating {progress.done} of {progress.total}…
                  </span>
                </div>
              )}

              {!isRunning && (created.length > 0 || failed.length > 0) && (
                <div className="flex flex-col gap-3">
                  <div className="text-sm">
                    <span className="font-medium text-success">{created.length} created</span>
                    {failed.length > 0 && (
                      <span className="font-medium text-danger ml-2">{failed.length} failed</span>
                    )}
                  </div>

                  {created.length > 0 && (
                    <ul className="text-xs text-foreground-500 max-h-32 overflow-auto flex flex-col gap-0.5">
                      {created.map((c) => (
                        <li key={c.id}>{c.name}</li>
                      ))}
                    </ul>
                  )}

                  {failed.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-medium p-2 text-xs text-danger flex flex-col gap-1 max-h-32 overflow-auto">
                        {failed.map((f) => (
                          <div key={f.key}>
                            <strong>{f.name || '(unnamed)'}</strong> — {f.error}
                          </div>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        startContent={<RotateCcw size={14} />}
                        className="w-fit"
                        onPress={handleRetryFailed}
                        isLoading={isRunning}
                      >
                        Retry {failed.length} failed
                      </Button>
                    </div>
                  )}

                  {created.length > 0 && !undoUsed && (
                    <Button
                      size="sm"
                      variant="bordered"
                      color="danger"
                      startContent={<Undo2 size={14} />}
                      className="w-fit"
                      onPress={handleUndo}
                      isLoading={undoing}
                    >
                      Undo — delete these {created.length} event{created.length === 1 ? '' : 's'}
                    </Button>
                  )}

                  {undoResult && (
                    <div className="text-xs text-foreground-500 bg-content2 border border-divider rounded-medium p-2 flex flex-col gap-1">
                      <span>{undoResult.deleted.length} deleted.</span>
                      {undoResult.kept.length > 0 && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-warning font-medium">
                            {undoResult.kept.length} kept — not safe to delete:
                          </span>
                          {undoResult.kept.map((k) => (
                            <span key={k.id}>
                              {k.name}: {k.reason}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          {step === 1 && (
            <>
              <Button variant="bordered" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" onPress={handleGenerate} isDisabled={!canGenerate}>
                Next: Review
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="bordered" onPress={() => setStep(1)}>
                Back
              </Button>
              <ButtonGroup>
                <Button color="primary" onPress={handleConfirmCreate} isDisabled={creatableCount === 0}>
                  {createStatus === 'draft' ? 'Create as draft' : 'Create as published'} ({creatableCount}
                  {invalidCount > 0 ? `, ${invalidCount} skipped` : ''})
                </Button>
                <Dropdown>
                  <DropdownTrigger>
                    <Button color="primary" isIconOnly aria-label="Creation status">
                      <ChevronDown size={14} />
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu
                    aria-label="Creation status"
                    selectionMode="single"
                    selectedKeys={[createStatus]}
                    onAction={(key) => setCreateStatus(key as EventStatus)}
                  >
                    <DropdownItem key="draft">Create as draft</DropdownItem>
                    <DropdownItem key="open">Create as published</DropdownItem>
                  </DropdownMenu>
                </Dropdown>
              </ButtonGroup>
            </>
          )}
          {step === 3 && (
            <Button color="primary" onPress={onClose} isDisabled={isRunning}>
              Done
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
