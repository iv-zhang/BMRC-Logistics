'use client';
import React from 'react';
import { Input, Button, Switch } from '@heroui/react';
import { Plus, Trash2, Info, AlertTriangle } from 'lucide-react';
import type { VenueDef, TermDef } from '@/app/config/org-config';
import { newId } from './settings-utils';

interface EventsVenuesTabProps {
  venues: VenueDef[];
  eventTypes: string[];
  terms: TermDef[];
  requireCertsForShiftSignup: boolean;
  onChange: (update: { venues?: VenueDef[]; eventTypes?: string[]; terms?: TermDef[]; requireCertsForShiftSignup?: boolean }) => void;
}

export function EventsVenuesTab({
  venues,
  eventTypes,
  terms,
  requireCertsForShiftSignup,
  onChange,
}: EventsVenuesTabProps) {
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
