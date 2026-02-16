'use client';

import React, { useMemo } from 'react';
import { Select, SelectItem, Spinner } from '@heroui/react';
import { MapPin, X } from 'lucide-react';
import type { StorageLocationRef } from '@/app/types';
import {
  useStorageLocations,
  type UseStorageLocationsReturn,
} from '@/app/hooks/useStorageLocations';

export interface StorageLocationPickerProps {
  /** Current value (controlled) */
  value?: StorageLocationRef;
  /** Called when the user changes any part of the location */
  onChange: (loc: StorageLocationRef | undefined) => void;
  /** Optional pre-fetched storage data (avoids duplicate listeners) */
  storageData?: UseStorageLocationsReturn;
  /** Whether the picker is disabled */
  disabled?: boolean;
  /** Label above the picker group */
  label?: string;
  /** Size variant passed to HeroUI Select */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Cascading location picker: Zone → Shelf → Level → Container.
 *
 * Each step is only enabled when the parent selection is made.
 * Changing a parent clears child selections.
 * Uses the `useStorageLocations` hook for real-time Firestore data
 * (or accepts pre-fetched data via `storageData` prop).
 */
export default function StorageLocationPicker({
  value,
  onChange,
  storageData,
  disabled = false,
  label = 'Storage Location',
  size = 'sm',
}: StorageLocationPickerProps) {
  // Use provided data or create own listener
  const ownData = useStorageLocations();
  const data = storageData ?? ownData;

  const {
    zones,
    loading,
    getShelvesForZone,
    getContainersForShelf,
    getLevelsForShelf,
    getLevelLabelsForShelf,
  } = data;

  // Derived lists based on current selections
  const shelvesForZone = useMemo(
    () => (value?.zoneId ? getShelvesForZone(value.zoneId) : []),
    [value?.zoneId, getShelvesForZone]
  );

  const levelsForShelf = useMemo(() => {
    if (!value?.shelfId) return 0;
    return getLevelsForShelf(value.shelfId);
  }, [value?.shelfId, getLevelsForShelf]);

  const levelLabels = useMemo(() => {
    if (!value?.shelfId) return [];
    return getLevelLabelsForShelf(value.shelfId);
  }, [value?.shelfId, getLevelLabelsForShelf]);

  const containersForShelf = useMemo(
    () => (value?.shelfId ? getContainersForShelf(value.shelfId) : []),
    [value?.shelfId, getContainersForShelf]
  );

  // --- Handlers ---

  const handleZoneChange = (zoneId: string) => {
    if (!zoneId) {
      onChange(undefined);
      return;
    }
    const zone = zones.find((z) => z.id === zoneId);
    onChange({
      zoneId,
      zoneName: zone?.name,
      // clear children
      shelfId: undefined,
      shelfName: undefined,
      level: undefined,
      containerId: undefined,
      containerName: undefined,
    });
  };

  const handleShelfChange = (shelfId: string) => {
    if (!shelfId || !value) {
      onChange(value ? { ...value, shelfId: undefined, shelfName: undefined, level: undefined, containerId: undefined, containerName: undefined } : undefined);
      return;
    }
    const shelf = shelvesForZone.find((s) => s.id === shelfId);
    onChange({
      ...value,
      shelfId,
      shelfName: shelf?.name,
      // clear children
      level: undefined,
      containerId: undefined,
      containerName: undefined,
    });
  };

  const handleLevelChange = (levelStr: string) => {
    if (!levelStr || !value) return;
    const lvl = parseInt(levelStr, 10);
    onChange({
      ...value,
      level: isNaN(lvl) ? undefined : lvl,
      // clear container when level changes
      containerId: undefined,
      containerName: undefined,
    });
  };

  const handleContainerChange = (containerId: string) => {
    if (!containerId || !value) return;
    const container = containersForShelf.find((c) => c.id === containerId);
    onChange({
      ...value,
      containerId,
      containerName: container?.name,
    });
  };

  const handleClear = () => {
    onChange(undefined);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner size="sm" />
        <span className="text-small text-default-500">Loading locations…</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header with label and clear */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-small font-medium text-default-700">
          <MapPin size={14} />
          {label}
        </div>
        {value?.zoneId && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1 text-tiny text-danger hover:underline"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Zone */}
        <Select
          label="Zone"
          placeholder="Select zone"
          size={size}
          selectedKeys={value?.zoneId ? [value.zoneId] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string | undefined;
            handleZoneChange(selected ?? '');
          }}
          isDisabled={disabled}
          aria-label="Storage zone"
        >
          {zones.map((z) => (
            <SelectItem key={z.id}>{z.name}</SelectItem>
          ))}
        </Select>

        {/* Shelf */}
        <Select
          label="Shelf"
          placeholder={value?.zoneId ? 'Select shelf' : '—'}
          size={size}
          selectedKeys={value?.shelfId ? [value.shelfId] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string | undefined;
            handleShelfChange(selected ?? '');
          }}
          isDisabled={disabled || !value?.zoneId || shelvesForZone.length === 0}
          aria-label="Shelf"
        >
          {shelvesForZone.map((s) => (
            <SelectItem key={s.id}>{s.name}</SelectItem>
          ))}
        </Select>

        {/* Level (only if shelf has >1 levels) */}
        {value?.shelfId && levelsForShelf > 1 && (
          <Select
            label="Level"
            placeholder="Select level"
            size={size}
            selectedKeys={value?.level != null ? [String(value.level)] : []}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string | undefined;
              handleLevelChange(selected ?? '');
            }}
            isDisabled={disabled}
            aria-label="Shelf level"
          >
            {Array.from({ length: levelsForShelf }, (_, i) => {
              const levelNum = i + 1;
              const labelText =
                levelLabels[i] || `Level ${levelNum}`;
              return (
                <SelectItem key={String(levelNum)}>
                  {labelText}
                </SelectItem>
              );
            })}
          </Select>
        )}

        {/* Container (optional) */}
        {value?.shelfId && containersForShelf.length > 0 && (
          <Select
            label="Container"
            placeholder="(optional)"
            size={size}
            selectedKeys={value?.containerId ? [value.containerId] : []}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string | undefined;
              handleContainerChange(selected ?? '');
            }}
            isDisabled={disabled}
            aria-label="Container"
          >
            {containersForShelf.map((c) => (
              <SelectItem key={c.id}>{c.name}</SelectItem>
            ))}
          </Select>
        )}
      </div>

      {/* Compact summary of selected location */}
      {value?.zoneName && (
        <p className="text-tiny text-default-400 pl-1">
          📍 {value.zoneName}
          {value.shelfName && ` › ${value.shelfName}`}
          {value.level != null && ` › L${value.level}`}
          {value.containerName && ` › ${value.containerName}`}
        </p>
      )}
    </div>
  );
}
