'use client';
import React from 'react';
import Link from 'next/link';
import { Input, Select, SelectItem, Button } from '@heroui/react';
import { Plus, Trash2, Info, ArrowUpRight } from 'lucide-react';
import type { LocationDef } from '@/app/config/org-config';
import { newId } from './settings-utils';

const LOCATION_TYPES: { key: LocationDef['type']; label: string }[] = [
  { key: 'headquarters', label: 'Headquarters' },
  { key: 'satellite', label: 'Satellite site' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'event', label: 'Event' },
  { key: 'other', label: 'Other' },
];

interface Props {
  locations: LocationDef[];
  onChange: (locations: LocationDef[]) => void;
}

export function SitesRoomsTab({ locations, onChange }: Props) {
  const updateLocation = (id: string, patch: Partial<LocationDef>) => {
    onChange(locations.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const removeLocation = (id: string) => {
    if (!confirm('Remove this site? Rooms and dropdown entries referencing it will disappear from new records.')) return;
    onChange(locations.filter((l) => l.id !== id));
  };

  const addLocation = () => {
    onChange([
      ...locations,
      { id: newId('site'), name: 'New Site', type: 'satellite', rooms: [] },
    ]);
  };

  const addRoom = (locId: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, {
      rooms: [...loc.rooms, { id: newId('room'), name: 'New Room' }],
    });
  };

  const updateRoom = (locId: string, roomId: string, name: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, {
      rooms: loc.rooms.map((r) => (r.id === roomId ? { ...r, name } : r)),
    });
  };

  const removeRoom = (locId: string, roomId: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, { rooms: loc.rooms.filter((r) => r.id !== roomId) });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 bg-primary-50 dark:bg-primary-900/20 border border-primary/20 rounded-large px-4 py-3">
        <Info size={16} className="text-primary flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          Physical shelves, containers, and floors live in Storage Management.{' '}
          <Link href="/storage" className="text-primary font-semibold hover:underline inline-flex items-center gap-1">
            Go to Storage <ArrowUpRight size={13} />
          </Link>
        </p>
      </div>

      <div className="flex items-start gap-2.5 bg-warning-50 dark:bg-warning-950/20 border border-warning/20 rounded-large px-4 py-3">
        <Info size={16} className="text-warning flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          Renaming a site here updates new records and dropdowns, but won&apos;t relabel items already saved under the old name.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {locations.map((loc) => (
          <div key={loc.id} className="bg-content1 border border-divider rounded-large p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                <Input
                  label="Site name"
                  value={loc.name}
                  onValueChange={(v) => updateLocation(loc.id, { name: v })}
                />
                <Select
                  label="Type"
                  size="md"
                  selectedKeys={[loc.type]}
                  onChange={(e) => {
                    const val = e.target.value as LocationDef['type'];
                    if (val) updateLocation(loc.id, { type: val });
                  }}
                >
                  {LOCATION_TYPES.map((t) => (
                    <SelectItem key={t.key}>{t.label}</SelectItem>
                  ))}
                </Select>
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                className="flex-none mt-1"
                onPress={() => removeLocation(loc.id)}
                aria-label="Remove site"
              >
                <Trash2 size={16} />
              </Button>
            </div>

            <div className="bg-content2 rounded-large p-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2.5">
                Rooms / Areas
              </p>
              <div className="flex flex-col gap-2">
                {loc.rooms.map((room) => (
                  <div key={room.id} className="flex items-center gap-2">
                    <Input
                      size="sm"
                      value={room.name}
                      onValueChange={(v) => updateRoom(loc.id, room.id, v)}
                      className="flex-1"
                    />
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="danger"
                      onPress={() => removeRoom(loc.id, room.id)}
                      aria-label="Remove room"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                {loc.rooms.length === 0 && (
                  <p className="text-xs text-foreground-400">No rooms — this site is tracked as a single area.</p>
                )}
              </div>
              <Button
                size="sm"
                variant="flat"
                startContent={<Plus size={14} />}
                className="mt-3"
                onPress={() => addRoom(loc.id)}
              >
                Add room
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Button color="primary" startContent={<Plus size={16} />} onPress={addLocation} className="self-start">
        Add site
      </Button>
    </div>
  );
}
