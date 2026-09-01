'use client';
import React from 'react';
import { Input, Button, Switch, Select, SelectItem, Textarea, Chip, Accordion, AccordionItem } from '@heroui/react';
import { Plus, Trash2, Info, AlertTriangle } from 'lucide-react';
import type { VenueDef, TermDef, EventTemplateDef, EventTemplateTeamDef, EventTemplateTierWindowDef, EventTemplateAccessTierPreset } from '@/app/config/org-config';
import { validateEventTemplate } from '@/app/config/org-config';
import { MIN_EMTS, MAX_EMTS, DEFAULT_EMTS, clampEmtCount } from '@/app/lib/events';
import { FieldHint } from '@/app/components/field-hint';
import { newId } from './settings-utils';
import { CriteriaEditor, useJoinDateCoverage, tenureGate, type TenureGate } from './criteria-editor';

interface EventsVenuesTabProps {
  venues: VenueDef[];
  eventTypes: string[];
  terms: TermDef[];
  requireCertsForShiftSignup: boolean;
  eventTemplates: EventTemplateDef[];
  onChange: (update: {
    venues?: VenueDef[];
    eventTypes?: string[];
    terms?: TermDef[];
    requireCertsForShiftSignup?: boolean;
    eventTemplates?: EventTemplateDef[];
  }) => void;
}

// ---------------------------------------------------------------------------
// [Phase 5b / waitlist plan §5.9, §10.2d] Event Templates section.
//
// A template is the reusable SHAPE a bulk event-creation run repeats (§5.9);
// it holds no dates of its own. `accessTierPreset` is LEAD DAYS, never an
// absolute date — the worst bug bulk creation can produce is every event in a
// series opening for signup on the same instant, which is exactly what
// storing a date here would cause. `resolveAccessTierForDate` (event-series.ts)
// resolves the lead days against each event's own date at creation time.
//
// The criteria editor is the shared `CriteriaEditor` from `./criteria-editor`
// — see that module's header for why it lives there instead of a per-file copy.
// ---------------------------------------------------------------------------

function TemplateWindowRow({
  window,
  eventTypes,
  tenureGate: gate,
  onChange,
  onRemove,
}: {
  window: EventTemplateTierWindowDef;
  eventTypes: string[];
  /** [Phase 2 / waitlist plan §3.7, §8] Roster coverage gate — see `tenureGate()`
   *  in `./criteria-editor`. Resolved once at the `EventsVenuesTab` level and
   *  threaded down here, not recomputed per window. */
  tenureGate: TenureGate;
  onChange: (patch: Partial<EventTemplateTierWindowDef>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-content1 border border-divider rounded-medium p-3 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
          <Input size="sm" label="Label" value={window.label} onValueChange={(v) => onChange({ label: v })} />
          <Input
            size="sm"
            type="number"
            min={1}
            label="Opens"
            value={String(window.leadDays)}
            onValueChange={(v) => onChange({ leadDays: Number(v) || 0 })}
            endContent={<span className="text-foreground-400 text-xs">days before event</span>}
          />
        </div>
        <Button isIconOnly size="sm" variant="light" color="danger" onPress={onRemove} aria-label="Remove window" className="flex-none">
          <Trash2 size={14} />
        </Button>
      </div>

      <CriteriaEditor criteria={window.criteria} eventTypes={eventTypes} tenureGate={gate} onChange={(criteria) => onChange({ criteria })} />
    </div>
  );
}

function TemplateTeamRow({
  team,
  onChange,
  onRemove,
  canRemove,
}: {
  team: EventTemplateTeamDef;
  onChange: (patch: Partial<EventTemplateTeamDef>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 bg-content2 border border-divider rounded-medium p-3">
      <Input
        size="sm"
        label="Team name"
        value={team.name}
        onValueChange={(v) => onChange({ name: v })}
        className="flex-1 min-w-[140px]"
      />
      <Input
        size="sm"
        type="number"
        min={MIN_EMTS}
        max={MAX_EMTS}
        label={`EMTs (${MIN_EMTS}–${MAX_EMTS})`}
        value={String(team.emtCount)}
        onValueChange={(v) => onChange({ emtCount: clampEmtCount(Number(v)) })}
        className="w-36 flex-none"
      />
      <div className="flex items-center gap-2 flex-none">
        <Switch isSelected={team.hasFtoIntern} onValueChange={(v) => onChange({ hasFtoIntern: v })} size="sm" />
        <span className="text-xs text-foreground-600">FTO intern slot (supernumerary — never counted in staffing)</span>
      </div>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        color="danger"
        onPress={onRemove}
        isDisabled={!canRemove}
        aria-label="Remove team"
        className="flex-none"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function summarizeTeams(teams: EventTemplateTeamDef[]): string {
  if (teams.length === 0) return 'no teams';
  const counts = teams.map((t) => t.emtCount);
  const allSame = counts.every((c) => c === counts[0]);
  if (allSame) return `${teams.length}× FTO+${counts[0]}`;
  return teams.map((t) => `FTO+${t.emtCount}`).join(', ');
}

function templateSummary(t: EventTemplateDef): string {
  const bits = [summarizeTeams(t.teams)];
  if (t.callTime) bits.push(t.callTime);
  if (t.venue) bits.push(t.venue);
  return bits.join(' · ');
}

export function EventsVenuesTab({
  venues,
  eventTypes,
  terms,
  requireCertsForShiftSignup,
  eventTemplates,
  onChange,
}: EventsVenuesTabProps) {
  // [Phase 2 / waitlist plan §3.7, §8] Roster join-date coverage gate for the
  // tenure inputs in every template's staged-release windows, resolved once
  // here — it's a roster-wide figure, not a per-template or per-window one
  // (same reasoning as the identical call in waitlist-tier-tab.tsx's
  // PriorityTiersCard) — and threaded down through TemplateWindowRow.
  const templateTenureCoverage = useJoinDateCoverage();
  const templateTenureGate = tenureGate(templateTenureCoverage);

  // Venues handlers
  const updateVenueAt = (idx: number, patch: Partial<VenueDef>) => {
    const next = [...venues];
    next[idx] = { ...next[idx], ...patch };
    onChange({ venues: next });
  };

  const removeVenueAt = (idx: number) => {
    onChange({ venues: venues.filter((_, i) => i !== idx) });
  };

  const addVenue = () => {
    onChange({ venues: [...venues, { id: newId('venue'), name: 'New Venue', location: '' }] });
  };

  // Event Types handlers
  const updateEventTypeAt = (idx: number, value: string) => {
    const next = [...eventTypes];
    next[idx] = value;
    onChange({ eventTypes: next });
  };

  const removeEventTypeAt = (idx: number) => {
    onChange({ eventTypes: eventTypes.filter((_, i) => i !== idx) });
  };

  const addEventType = () => {
    onChange({ eventTypes: [...eventTypes, 'New Event Type'] });
  };

  // Terms handlers — replaces the old standalone semesterStartDate setting.
  // `deriveJoinedOn` / `getSemesterStart` (app/lib/tenure.ts, org-config.ts)
  // derive tenure and "this semester" stats from this list — see D-15/§4.1.
  const updateTermAt = (idx: number, patch: Partial<TermDef>) => {
    const next = [...terms];
    next[idx] = { ...next[idx], ...patch };
    onChange({ terms: next });
  };

  const removeTermAt = (idx: number) => {
    onChange({ terms: terms.filter((_, i) => i !== idx) });
  };

  const addTerm = () => {
    onChange({ terms: [...terms, { id: newId('term'), label: 'New Term', startDate: '' }] });
  };

  const termIssues: string[] = [];
  {
    const seenLabels = new Set<string>();
    for (const t of terms) {
      const label = t.label.trim().toLowerCase();
      if (label && seenLabels.has(label)) {
        termIssues.push(`"${t.label}" is used by more than one term — labels must be unique (it's the key the roster join-date backfill matches on).`);
      }
      seenLabels.add(label);
    }
    const dates = terms.map((t) => t.startDate).filter(Boolean);
    const sorted = [...dates].sort();
    const isAscending = dates.every((d, i) => d === sorted[i]);
    if (!isAscending) {
      termIssues.push('Terms should be ordered by ascending start date.');
    }
  }

  // -------------------------------------------------------------------------
  // Event Templates handlers [Phase 5b / waitlist plan §5.9]
  // -------------------------------------------------------------------------
  const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(new Set());

  const updateTemplateAt = (idx: number, patch: Partial<EventTemplateDef>) => {
    const next = [...eventTemplates];
    next[idx] = { ...next[idx], ...patch };
    onChange({ eventTemplates: next });
  };

  const removeTemplateAt = (idx: number) => {
    if (!confirm('Remove this template?')) return;
    onChange({ eventTemplates: eventTemplates.filter((_, i) => i !== idx) });
  };

  const addTemplate = () => {
    const t: EventTemplateDef = {
      id: newId('tmpl'),
      name: 'New Template',
      callTime: '',
      teams: [{ name: 'Team 1', emtCount: DEFAULT_EMTS, hasFtoIntern: true }],
    };
    onChange({ eventTemplates: [...eventTemplates, t] });
    setExpandedKeys((prev) => new Set(prev).add(t.id));
  };

  const handleVenueChangeAt = (idx: number, name: string) => {
    const match = venues.find((v) => v.name === name);
    updateTemplateAt(idx, {
      venue: name || undefined,
      location: match?.location || eventTemplates[idx].location,
    });
  };

  const updateTeamAt = (tIdx: number, teamIdx: number, patch: Partial<EventTemplateTeamDef>) => {
    const t = eventTemplates[tIdx];
    const teamsNext = [...t.teams];
    teamsNext[teamIdx] = { ...teamsNext[teamIdx], ...patch };
    updateTemplateAt(tIdx, { teams: teamsNext });
  };

  const addTeamAt = (tIdx: number) => {
    const t = eventTemplates[tIdx];
    updateTemplateAt(tIdx, {
      teams: [...t.teams, { name: `Team ${t.teams.length + 1}`, emtCount: DEFAULT_EMTS, hasFtoIntern: true }],
    });
  };

  const removeTeamAt = (tIdx: number, teamIdx: number) => {
    const t = eventTemplates[tIdx];
    if (t.teams.length <= 1) return;
    updateTemplateAt(tIdx, { teams: t.teams.filter((_, i) => i !== teamIdx) });
  };

  // Staged signup release (accessTierPreset) — LEAD DAYS ONLY, see file header comment.
  const toggleStagedReleaseAt = (tIdx: number, on: boolean) => {
    const t = eventTemplates[tIdx];
    if (on) {
      updateTemplateAt(tIdx, {
        accessTierPreset: t.accessTierPreset ?? { windows: [], generalLeadDays: 7, rationale: '' },
      });
    } else {
      updateTemplateAt(tIdx, { accessTierPreset: undefined });
    }
  };

  const updatePresetAt = (tIdx: number, patch: Partial<EventTemplateAccessTierPreset>) => {
    const t = eventTemplates[tIdx];
    if (!t.accessTierPreset) return;
    updateTemplateAt(tIdx, { accessTierPreset: { ...t.accessTierPreset, ...patch } });
  };

  const addWindowAt = (tIdx: number) => {
    const preset = eventTemplates[tIdx].accessTierPreset;
    if (!preset) return;
    updatePresetAt(tIdx, {
      windows: [...preset.windows, { label: 'New window', leadDays: preset.generalLeadDays + 7, criteria: { combine: 'any' } }],
    });
  };

  const updateWindowAt = (tIdx: number, wIdx: number, patch: Partial<EventTemplateTierWindowDef>) => {
    const preset = eventTemplates[tIdx].accessTierPreset;
    if (!preset) return;
    const windowsNext = [...preset.windows];
    windowsNext[wIdx] = { ...windowsNext[wIdx], ...patch };
    updatePresetAt(tIdx, { windows: windowsNext });
  };

  const removeWindowAt = (tIdx: number, wIdx: number) => {
    const preset = eventTemplates[tIdx].accessTierPreset;
    if (!preset) return;
    updatePresetAt(tIdx, { windows: preset.windows.filter((_, i) => i !== wIdx) });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Venues Section */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Venues</h2>
        <p className="text-sm text-foreground-500 mb-4">
          Locations where events can be staffed. Selecting a venue auto-fills the event location.
        </p>
        <div className="flex flex-col gap-3">
          {venues.map((venue, idx) => (
            <div key={venue.id} className="flex items-end gap-3">
              <Input
                size="sm"
                label="Venue name"
                value={venue.name}
                onValueChange={(v) => updateVenueAt(idx, { name: v })}
                className="flex-1"
              />
              <Input
                size="sm"
                label="Location (address/area)"
                value={venue.location || ''}
                onValueChange={(v) => updateVenueAt(idx, { location: v })}
                className="flex-1"
              />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                onPress={() => removeVenueAt(idx)}
                aria-label="Remove venue"
                className="flex-none"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {venues.length === 0 && (
            <p className="text-xs text-foreground-400">No venues yet.</p>
          )}
        </div>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          startContent={<Plus size={14} />}
          className="mt-3"
          onPress={addVenue}
        >
          Add venue
        </Button>
      </div>

      {/* Event Types Section */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Event Types</h2>
        <p className="text-sm text-foreground-500 mb-4">
          Categories used to classify events (Concert, Sporting Event, Training, etc.).
        </p>
        <div className="flex flex-col gap-2">
          {eventTypes.map((type, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                size="sm"
                value={type}
                onValueChange={(v) => updateEventTypeAt(idx, v)}
                className="flex-1 max-w-sm"
              />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                onPress={() => removeEventTypeAt(idx)}
                aria-label="Remove event type"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {eventTypes.length === 0 && (
            <p className="text-xs text-foreground-400">No event types yet.</p>
          )}
        </div>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          startContent={<Plus size={14} />}
          className="mt-3"
          onPress={addEventType}
        >
          Add event type
        </Button>
      </div>

      {/* Terms Section */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Terms</h2>
        <p className="text-sm text-foreground-500 mb-4">
          The org&apos;s academic terms. Drives &quot;this semester&quot; shift statistics (the current term is whichever
          one&apos;s start date has most recently passed) and is the source a member&apos;s join date is derived from for
          tenure-based priority rules. Add next year&apos;s term here before it starts.
        </p>

        <div className="flex items-start gap-2.5 bg-content2 rounded-large px-4 py-3 mb-4">
          <Info size={16} className="text-foreground-400 flex-none mt-0.5" />
          <p className="text-xs text-foreground-500">
            A term&apos;s label is what members pick when their join term is recorded on the roster, and is the key the
            join-date backfill matches on — keep labels unique.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {terms.map((term, idx) => (
            <div key={term.id} className="flex flex-wrap items-end gap-3 bg-content2 border border-divider rounded-medium p-3">
              <Input
                size="sm"
                label="Label"
                placeholder="e.g., Fall 2025"
                value={term.label}
                onValueChange={(v) => updateTermAt(idx, { label: v })}
                className="flex-1 min-w-[160px]"
              />
              <Input
                size="sm"
                type="date"
                label="Start date"
                value={term.startDate}
                onChange={(e) => updateTermAt(idx, { startDate: e.target.value })}
                className="flex-1 min-w-[160px]"
              />
              <Input
                size="sm"
                type="date"
                label="End date (optional)"
                value={term.endDate || ''}
                onChange={(e) => updateTermAt(idx, { endDate: e.target.value || undefined })}
                className="flex-1 min-w-[160px]"
              />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                onPress={() => removeTermAt(idx)}
                aria-label="Remove term"
                className="flex-none"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {terms.length === 0 && <p className="text-xs text-foreground-400">No terms yet.</p>}
        </div>

        {termIssues.length > 0 && (
          <div className="flex flex-col gap-1 mt-3">
            {termIssues.map((issue, i) => (
              <p key={i} className="text-xs text-warning flex items-start gap-1">
                <AlertTriangle size={12} className="flex-none mt-0.5" />
                <span>{issue}</span>
              </p>
            ))}
          </div>
        )}

        <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} className="mt-3" onPress={addTerm}>
          Add term
        </Button>
      </div>

      {/* Event Templates Section [Phase 5b / waitlist plan §5.9] */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Event Templates</h2>
        <p className="text-sm text-foreground-500 mb-4">
          Reusable event shapes for bulk event creation (Events → New event → Add many). A template holds no dates of
          its own — only the type, venue, times, team layout, and (optionally) a staged signup release, all applied
          per event when a batch is created.
        </p>

        {eventTemplates.length === 0 ? (
          <p className="text-xs text-foreground-400 mb-3">No templates yet.</p>
        ) : (
          <Accordion
            variant="light"
            selectionMode="multiple"
            selectedKeys={expandedKeys}
            onSelectionChange={(keys) => {
              if (keys === 'all') {
                setExpandedKeys(new Set(eventTemplates.map((t) => t.id)));
              } else {
                setExpandedKeys(new Set(Array.from(keys).map(String)));
              }
            }}
            className="px-0"
          >
            {eventTemplates.map((t, idx) => {
              const issues = validateEventTemplate(t, eventTemplates);
              const eventTypeOptions = t.eventType && !eventTypes.includes(t.eventType) ? [...eventTypes, t.eventType] : eventTypes;
              const venueOptions = t.venue && !venues.some((v) => v.name === t.venue) ? [...venues, { id: '__custom__', name: t.venue }] : venues;

              return (
                <AccordionItem
                  key={t.id}
                  aria-label={t.name || 'Untitled template'}
                  title={
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{t.name || 'Untitled template'}</span>
                      <span className="text-xs text-foreground-400">{templateSummary(t)}</span>
                      {issues.length > 0 && (
                        <Chip size="sm" color="warning" variant="flat" startContent={<AlertTriangle size={12} />}>
                          {issues.length}
                        </Chip>
                      )}
                    </div>
                  }
                  classNames={{ content: 'pt-1 pb-4' }}
                >
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Input size="sm" label="Name" isRequired value={t.name} onValueChange={(v) => updateTemplateAt(idx, { name: v })} />
                      <Select
                        size="sm"
                        label="Event type"
                        placeholder="None"
                        selectedKeys={t.eventType ? [t.eventType] : []}
                        onSelectionChange={(keys) => updateTemplateAt(idx, { eventType: String(Array.from(keys)[0] ?? '') || undefined })}
                      >
                        {eventTypeOptions.map((type) => (
                          <SelectItem key={type}>{type}</SelectItem>
                        ))}
                      </Select>
                      <Select
                        size="sm"
                        label="Venue"
                        placeholder="None"
                        selectedKeys={t.venue ? [t.venue] : []}
                        onSelectionChange={(keys) => handleVenueChangeAt(idx, String(Array.from(keys)[0] ?? ''))}
                      >
                        {venueOptions.map((v) => (
                          <SelectItem key={v.name}>{v.name}</SelectItem>
                        ))}
                      </Select>
                      <Input
                        size="sm"
                        label="Location"
                        placeholder="Address / area"
                        value={t.location ?? ''}
                        onValueChange={(v) => updateTemplateAt(idx, { location: v || undefined })}
                      />
                      <Input
                        size="sm"
                        type="time"
                        label="Call time"
                        isRequired
                        value={t.callTime}
                        onValueChange={(v) => updateTemplateAt(idx, { callTime: v })}
                      />
                      <Input
                        size="sm"
                        type="time"
                        label="End time"
                        value={t.endTime ?? ''}
                        onValueChange={(v) => updateTemplateAt(idx, { endTime: v || undefined })}
                      />
                    </div>

                    <Textarea
                      size="sm"
                      label="Description"
                      value={t.description ?? ''}
                      onValueChange={(v) => updateTemplateAt(idx, { description: v || undefined })}
                      minRows={2}
                    />

                    <div className="flex items-start gap-3">
                      <Switch
                        isSelected={t.waitlistEnabled !== false}
                        onValueChange={(v) => updateTemplateAt(idx, { waitlistEnabled: v })}
                        size="sm"
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium text-foreground">Enable waitlist</p>
                        <p className="text-xs text-foreground-500">
                          Applied to every event created from this template. On (the default) means a member requesting a
                          full slot joins a queue instead of being blocked.
                        </p>
                      </div>
                    </div>

                    {/* Teams */}
                    <div className="pt-2 border-t border-divider">
                      <p className="text-xs font-semibold text-foreground-500 mb-2">Teams (at least one required)</p>
                      <div className="flex flex-col gap-2">
                        {t.teams.map((team, teamIdx) => (
                          <TemplateTeamRow
                            key={teamIdx}
                            team={team}
                            onChange={(patch) => updateTeamAt(idx, teamIdx, patch)}
                            onRemove={() => removeTeamAt(idx, teamIdx)}
                            canRemove={t.teams.length > 1}
                          />
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="flat"
                        startContent={<Plus size={14} />}
                        className="mt-2"
                        onPress={() => addTeamAt(idx)}
                      >
                        Add team
                      </Button>
                    </div>

                    {/* Staged signup release (accessTierPreset) — lead days only */}
                    <div className="pt-2 border-t border-divider">
                      <div className="flex items-start gap-3 mb-3">
                        <Switch
                          isSelected={!!t.accessTierPreset}
                          onValueChange={(v) => toggleStagedReleaseAt(idx, v)}
                          size="sm"
                          className="mt-0.5"
                        />
                        <p className="text-sm font-medium text-foreground">
                          Staged signup release
                          <FieldHint text="Lead days here are resolved against each event's own date when the batch of events is created — not a fixed calendar date, so every event in a series opens on its own schedule." />
                        </p>
                      </div>

                      {t.accessTierPreset && (
                        <div className="flex flex-col gap-3 pl-1">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <Input
                              size="sm"
                              type="number"
                              min={1}
                              label="Opens to everyone"
                              value={String(t.accessTierPreset.generalLeadDays)}
                              onValueChange={(v) => updatePresetAt(idx, { generalLeadDays: Number(v) || 0 })}
                              endContent={<span className="text-foreground-400 text-xs">days before event</span>}
                            />
                          </div>
                          <Textarea
                            size="sm"
                            label="Rationale"
                            description="Shown to members before they hit the restriction, explaining who gets in early and why."
                            value={t.accessTierPreset.rationale}
                            onValueChange={(v) => updatePresetAt(idx, { rationale: v })}
                            minRows={2}
                          />

                          <div className="flex flex-col gap-2">
                            {t.accessTierPreset.windows.map((w, wIdx) => (
                              <TemplateWindowRow
                                key={wIdx}
                                window={w}
                                eventTypes={eventTypes}
                                tenureGate={templateTenureGate}
                                onChange={(patch) => updateWindowAt(idx, wIdx, patch)}
                                onRemove={() => removeWindowAt(idx, wIdx)}
                              />
                            ))}
                            {t.accessTierPreset.windows.length === 0 && (
                              <p className="text-xs text-foreground-400">No priority windows yet.</p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="flat"
                            startContent={<Plus size={14} />}
                            className="self-start"
                            onPress={() => addWindowAt(idx)}
                          >
                            Add window
                          </Button>
                        </div>
                      )}
                    </div>

                    {issues.length > 0 && (
                      <div className="flex flex-col gap-1 pt-2 border-t border-divider">
                        {issues.map((issue, i) => (
                          <p key={i} className="text-xs text-warning flex items-start gap-1">
                            <AlertTriangle size={12} className="flex-none mt-0.5" />
                            <span>{issue}</span>
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="flex justify-end pt-2 border-t border-divider">
                      <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        startContent={<Trash2 size={13} />}
                        onPress={() => removeTemplateAt(idx)}
                      >
                        Remove template
                      </Button>
                    </div>
                  </div>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}

        <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} className="mt-3" onPress={addTemplate}>
          Add template
        </Button>
      </div>

      {/* Member Eligibility Section */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Member Eligibility</h2>
        <div className="flex items-start gap-3">
          <Switch
            isSelected={requireCertsForShiftSignup}
            onValueChange={(value) => onChange({ requireCertsForShiftSignup: value })}
            size="sm"
            className="mt-0.5"
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">Require valid certifications to sign up for shifts</p>
            <p className="text-xs text-foreground-500 mt-1">
              When on, members need current EMT + CPR certifications on file to request a shift. Turn off during rollout before certs are entered.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
