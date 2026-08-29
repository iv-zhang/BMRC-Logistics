'use client';

/** Manager-only create/edit modal for an Event, including its Teams editor
 *  (name + EMT count 2–4, clamped via `clampEmtCount`/`resizeEmtSlots`). */

import { useEffect, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Select, SelectItem, Switch } from '@heroui/react';
import { Plus, Trash2, Minus } from 'lucide-react';
import { createEvent, updateEvent, createEmptyTeam, resizeEmtSlots, clampEmtCount, type EventActor } from '@/app/lib/events';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import type { Event, EventTeam, EventStatus } from '@/app/types';
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

export default function EventEditorModal({ isOpen, onClose, event, actor, onSaved, onError }: EventEditorModalProps) {
  const { eventTypes, venues } = useOrgConfig();
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
  }, [isOpen, event]);

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
