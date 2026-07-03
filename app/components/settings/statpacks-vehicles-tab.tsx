'use client';
import React from 'react';
import { Input, Select, SelectItem, Button, Switch } from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import type { StatpackTypeDef, PocketDef, VehicleDef } from '@/app/config/org-config';
import { newId } from './settings-utils';

// ---------------------------------------------------------------------------
// Statpack Types — statpackTypes: StatpackTypeDef[]
// ---------------------------------------------------------------------------

const POSITIONS: PocketDef['position'][] = ['center', 'front', 'left', 'right', 'top', 'bottom'];

interface StatpackTypesTabProps {
  statpackTypes: StatpackTypeDef[];
  onChange: (statpackTypes: StatpackTypeDef[]) => void;
}

export function StatpackTypesTab({ statpackTypes, onChange }: StatpackTypesTabProps) {
  const updateType = (id: string, patch: Partial<StatpackTypeDef>) => {
    onChange(statpackTypes.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const removeType = (id: string) => {
    if (!confirm('Remove this statpack type? Existing packs keep their type label, but it will disappear from dropdowns.')) return;
    onChange(statpackTypes.filter((t) => t.id !== id));
  };

  const addType = () => {
    onChange([
      ...statpackTypes,
      {
        id: newId('type'),
        name: 'New Type',
        pockets: [{ id: newId('pocket'), label: 'Main Pocket', icon: 'Package', position: 'center' }],
      },
    ]);
  };

  const addPocket = (typeId: string) => {
    const t = statpackTypes.find((x) => x.id === typeId);
    if (!t) return;
    updateType(typeId, {
      pockets: [...t.pockets, { id: newId('pocket'), label: 'New Pocket', icon: '', position: 'center' }],
    });
  };

  const updatePocket = (typeId: string, pocketId: string, patch: Partial<PocketDef>) => {
    const t = statpackTypes.find((x) => x.id === typeId);
    if (!t) return;
    updateType(typeId, {
      pockets: t.pockets.map((p) => (p.id === pocketId ? { ...p, ...patch } : p)),
    });
  };

  const removePocket = (typeId: string, pocketId: string) => {
    const t = statpackTypes.find((x) => x.id === typeId);
    if (!t) return;
    updateType(typeId, { pockets: t.pockets.filter((p) => p.id !== pocketId) });
  };

  return (
    <div className="flex flex-col gap-4">
      {statpackTypes.map((t) => (
        <div key={t.id} className="bg-content1 border border-divider rounded-large p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <Input
              label="Statpack type name"
              value={t.name}
              onValueChange={(v) => updateType(t.id, { name: v })}
              className="max-w-sm"
            />
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color="danger"
              className="flex-none mt-1"
              onPress={() => removeType(t.id)}
              aria-label="Remove statpack type"
            >
              <Trash2 size={16} />
            </Button>
          </div>

          <div className="bg-content2 rounded-large p-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2.5">
              Pockets
            </p>
            <div className="flex flex-col gap-2">
              {t.pockets.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 bg-content1 border border-divider rounded-medium p-2.5">
                  <Input
                    size="sm"
                    label="Label"
                    value={p.label}
                    onValueChange={(v) => updatePocket(t.id, p.id, { label: v })}
                    className="flex-1 min-w-[140px]"
                  />
                  <Select
                    size="sm"
                    label="Position"
                    selectedKeys={[p.position]}
                    onChange={(e) => {
                      const val = e.target.value as PocketDef['position'];
                      if (val) updatePocket(t.id, p.id, { position: val });
                    }}
                    className="w-36 flex-none"
                  >
                    {POSITIONS.map((pos) => (
                      <SelectItem key={pos} className="capitalize">
                        {pos}
                      </SelectItem>
                    ))}
                  </Select>
                  <Input
                    size="sm"
                    label="Icon (optional)"
                    placeholder="e.g., Package"
                    value={p.icon}
                    onValueChange={(v) => updatePocket(t.id, p.id, { icon: v })}
                    className="w-40 flex-none"
                  />
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    color="danger"
                    onPress={() => removePocket(t.id, p.id)}
                    aria-label="Remove pocket"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              {t.pockets.length === 0 && (
                <p className="text-xs text-foreground-400">No pockets yet.</p>
              )}
            </div>
            <Button size="sm" variant="flat" startContent={<Plus size={14} />} className="mt-3" onPress={() => addPocket(t.id)}>
              Add pocket
            </Button>
          </div>
        </div>
      ))}

      <Button color="primary" startContent={<Plus size={16} />} onPress={addType} className="self-start">
        Add statpack type
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vehicles — vehicles: VehicleDef[]
// ---------------------------------------------------------------------------

interface VehiclesTabProps {
  vehicles: VehicleDef[];
  onChange: (vehicles: VehicleDef[]) => void;
}

export function VehiclesTab({ vehicles, onChange }: VehiclesTabProps) {
  const updateVehicle = (id: string, patch: Partial<VehicleDef>) => {
    onChange(vehicles.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };

  const removeVehicle = (id: string) => {
    if (!confirm('Remove this vehicle type?')) return;
    onChange(vehicles.filter((v) => v.id !== id));
  };

  const addVehicle = () => {
    onChange([
      ...vehicles,
      { id: newId('vehicle'), name: 'New Vehicle', icon: 'Truck', hasStatpacks: false },
    ]);
  };

  return (
    <div className="flex flex-col gap-4">
      {vehicles.map((v) => (
        <div key={v.id} className="bg-content1 border border-divider rounded-large p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
              <Input
                label="Vehicle name"
                value={v.name}
                onValueChange={(val) => updateVehicle(v.id, { name: val })}
              />
              <Input
                label="Icon"
                placeholder="e.g., Ambulance"
                description="A Lucide icon name."
                value={v.icon}
                onValueChange={(val) => updateVehicle(v.id, { icon: val })}
              />
            </div>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color="danger"
              className="flex-none mt-1"
              onPress={() => removeVehicle(v.id)}
              aria-label="Remove vehicle"
            >
              <Trash2 size={16} />
            </Button>
          </div>

          <div className="flex items-center flex-wrap gap-4 mt-4 bg-content2 rounded-large p-3">
            <div className="flex items-center gap-2.5">
              <Switch
                size="sm"
                isSelected={v.hasStatpacks}
                onValueChange={(sel) => updateVehicle(v.id, { hasStatpacks: sel })}
              />
              <span className="text-sm font-medium text-foreground-600">Carries statpacks</span>
            </div>
            {v.hasStatpacks && (
              <Input
                type="number"
                min={0}
                size="sm"
                label="Max statpacks"
                value={String(v.maxStatpacks ?? 1)}
                onValueChange={(val) => {
                  const n = val === '' ? 0 : Number(val);
                  updateVehicle(v.id, { maxStatpacks: Number.isFinite(n) ? n : 0 });
                }}
                className="w-40"
              />
            )}
          </div>
        </div>
      ))}

      <Button color="primary" startContent={<Plus size={16} />} onPress={addVehicle} className="self-start">
        Add vehicle
      </Button>
    </div>
  );
}
