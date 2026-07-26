'use client';
import React from 'react';
import { Input, Button, Switch } from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import type { VenueDef } from '@/app/config/org-config';
import { newId } from './settings-utils';

interface EventsVenuesTabProps {
  venues: VenueDef[];
  eventTypes: string[];
  semesterStartDate: string;
  requireCertsForShiftSignup: boolean;
  onChange: (update: { venues?: VenueDef[]; eventTypes?: string[]; semesterStartDate?: string; requireCertsForShiftSignup?: boolean }) => void;
}

export function EventsVenuesTab({
  venues,
  eventTypes,
  semesterStartDate,
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

  // Semester start date handler
  const handleDateChange = (date: string) => {
    onChange({ semesterStartDate: date });
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

      {/* Semester Start Date Section */}
      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Semester Start Date</h2>
        <p className="text-sm text-foreground-500 mb-4">
          Used to filter &quot;this semester&quot; shift statistics. Update this at the start of each new term.
        </p>
        <Input
          type="date"
          size="md"
          label="Semester start date"
          value={semesterStartDate}
          onChange={(e) => handleDateChange(e.target.value)}
          className="max-w-xs"
        />
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
