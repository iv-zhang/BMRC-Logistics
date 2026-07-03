'use client';

import React, { useMemo, useState } from 'react';
import { Select, SelectItem, Spinner, Input, Button } from '@heroui/react';
import { MapPin, X, Plus, Check } from 'lucide-react';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '@/firebase';
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
 *
 * Also supports creating a new zone/shelf/container inline ("+ New…")
 * so a user placing an item doesn't have to leave the flow to set up
 * a destination that doesn't exist yet.
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
    getZoneById,
    getShelfById,
  } = data;

  // --- Inline "+ New…" creation state ---
  const [creatingZone, setCreatingZone] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [savingZone, setSavingZone] = useState(false);

  const [creatingShelf, setCreatingShelf] = useState(false);
  const [newShelfName, setNewShelfName] = useState('');
  const [savingShelf, setSavingShelf] = useState(false);

  const [creatingContainer, setCreatingContainer] = useState(false);
  const [newContainerName, setNewContainerName] = useState('');
  const [savingContainer, setSavingContainer] = useState(false);

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

  // Full records for the currently selected zone/shelf (for description/level/capacity)
  const selectedZone = useMemo(
    () => (value?.zoneId ? getZoneById(value.zoneId) : undefined),
    [value?.zoneId, getZoneById]
  );
  const selectedShelf = useMemo(
    () => (value?.shelfId ? getShelfById(value.shelfId) : undefined),
    [value?.shelfId, getShelfById]
  );

  const levelLabelText = (level: 'upper' | 'lower') =>
    level === 'upper' ? 'Upper level (entrance)' : 'Lower level (main HQ)';

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

  // --- Inline creation handlers ---

  const handleCreateZone = async () => {
    const name = newZoneName.trim();
    if (!name || savingZone) return;
    setSavingZone(true);
    try {
      const ref = await addDoc(collection(db, 'storage_zones'), {
        name,
        // Minimal default; can be refined later in Storage Management.
        locationType: 'Other',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onChange({
        zoneId: ref.id,
        zoneName: name,
        shelfId: undefined,
        shelfName: undefined,
        level: undefined,
        containerId: undefined,
        containerName: undefined,
      });
      setNewZoneName('');
      setCreatingZone(false);
    } catch (e) {
      console.error('[StorageLocationPicker] Failed to create zone', e);
    } finally {
      setSavingZone(false);
    }
  };

  const handleCreateShelf = async () => {
    const name = newShelfName.trim();
    if (!name || !value?.zoneId || savingShelf) return;
    setSavingShelf(true);
    try {
      const ref = await addDoc(collection(db, 'shelves'), {
        name,
        zoneId: value.zoneId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onChange({
        ...value,
        shelfId: ref.id,
        shelfName: name,
        level: undefined,
        containerId: undefined,
        containerName: undefined,
      });
      setNewShelfName('');
      setCreatingShelf(false);
    } catch (e) {
      console.error('[StorageLocationPicker] Failed to create shelf', e);
    } finally {
      setSavingShelf(false);
    }
  };

  const handleCreateContainer = async () => {
    const name = newContainerName.trim();
    if (!name || !value?.shelfId || savingContainer) return;
    setSavingContainer(true);
    try {
      const ref = await addDoc(collection(db, 'containers'), {
        name,
        shelfId: value.shelfId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onChange({
        ...value,
        containerId: ref.id,
        containerName: name,
      });
      setNewContainerName('');
      setCreatingContainer(false);
    } catch (e) {
      console.error('[StorageLocationPicker] Failed to create container', e);
    } finally {
      setSavingContainer(false);
    }
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
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-1">
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
              className="flex-1"
            >
              {zones.map((z) => (
                <SelectItem key={z.id}>{z.name}</SelectItem>
              ))}
            </Select>
          </div>
          {selectedZone?.level && (
            <span className="text-tiny font-medium text-primary pl-1">
              {levelLabelText(selectedZone.level)}
            </span>
          )}
          {!disabled && !creatingZone && (
            <button
              type="button"
              onClick={() => setCreatingZone(true)}
              className="flex items-center gap-1 text-tiny text-primary hover:underline pl-1 w-fit"
            >
              <Plus size={11} /> New zone
            </button>
          )}
          {creatingZone && (
            <div className="flex items-center gap-1">
              <Input
                size="sm"
                placeholder="Zone name"
                value={newZoneName}
                onValueChange={setNewZoneName}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateZone();
                  if (e.key === 'Escape') {
                    setCreatingZone(false);
                    setNewZoneName('');
                  }
                }}
                className="flex-1"
                aria-label="New zone name"
              />
              <Button
                size="sm"
                isIconOnly
                color="primary"
                isLoading={savingZone}
                isDisabled={!newZoneName.trim()}
                onPress={handleCreateZone}
                aria-label="Create zone"
              >
                <Check size={14} />
              </Button>
              <Button
                size="sm"
                isIconOnly
                variant="light"
                isDisabled={savingZone}
                onPress={() => {
                  setCreatingZone(false);
                  setNewZoneName('');
                }}
                aria-label="Cancel new zone"
              >
                <X size={14} />
              </Button>
            </div>
          )}
        </div>

        {/* Shelf */}
        <div className="flex flex-col gap-1">
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
          {value?.zoneId && !disabled && !creatingShelf && (
            <button
              type="button"
              onClick={() => setCreatingShelf(true)}
              className="flex items-center gap-1 text-tiny text-primary hover:underline pl-1 w-fit"
            >
              <Plus size={11} /> New shelf
            </button>
          )}
          {creatingShelf && (
            <div className="flex items-center gap-1">
              <Input
                size="sm"
                placeholder="Shelf name"
                value={newShelfName}
                onValueChange={setNewShelfName}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateShelf();
                  if (e.key === 'Escape') {
                    setCreatingShelf(false);
                    setNewShelfName('');
                  }
                }}
                className="flex-1"
                aria-label="New shelf name"
              />
              <Button
                size="sm"
                isIconOnly
                color="primary"
                isLoading={savingShelf}
                isDisabled={!newShelfName.trim()}
                onPress={handleCreateShelf}
                aria-label="Create shelf"
              >
                <Check size={14} />
              </Button>
              <Button
                size="sm"
                isIconOnly
                variant="light"
                isDisabled={savingShelf}
                onPress={() => {
                  setCreatingShelf(false);
                  setNewShelfName('');
                }}
                aria-label="Cancel new shelf"
              >
                <X size={14} />
              </Button>
            </div>
          )}
        </div>

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
        {value?.shelfId && (
          <div className="flex flex-col gap-1">
            {containersForShelf.length > 0 && (
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
            {!disabled && !creatingContainer && (
              <button
                type="button"
                onClick={() => setCreatingContainer(true)}
                className="flex items-center gap-1 text-tiny text-primary hover:underline pl-1 w-fit"
              >
                <Plus size={11} /> New container
              </button>
            )}
            {creatingContainer && (
              <div className="flex items-center gap-1">
                <Input
                  size="sm"
                  placeholder="Container name"
                  value={newContainerName}
                  onValueChange={setNewContainerName}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateContainer();
                    if (e.key === 'Escape') {
                      setCreatingContainer(false);
                      setNewContainerName('');
                    }
                  }}
                  className="flex-1"
                  aria-label="New container name"
                />
                <Button
                  size="sm"
                  isIconOnly
                  color="primary"
                  isLoading={savingContainer}
                  isDisabled={!newContainerName.trim()}
                  onPress={handleCreateContainer}
                  aria-label="Create container"
                >
                  <Check size={14} />
                </Button>
                <Button
                  size="sm"
                  isIconOnly
                  variant="light"
                  isDisabled={savingContainer}
                  onPress={() => {
                    setCreatingContainer(false);
                    setNewContainerName('');
                  }}
                  aria-label="Cancel new container"
                >
                  <X size={14} />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Zone constraints: description + level, visible while placing an item */}
      {selectedZone && (selectedZone.description || selectedZone.level) && (
        <div className="pl-1 space-y-0.5">
          {selectedZone.description && (
            <p className="text-tiny text-default-500">{selectedZone.description}</p>
          )}
        </div>
      )}

      {/* Shelf fullness: capacity vs. containers already placed */}
      {selectedShelf && (
        <p className="text-tiny text-default-500 pl-1">
          {typeof selectedShelf.capacity === 'number' && selectedShelf.capacity > 0
            ? `${containersForShelf.length} of ${selectedShelf.capacity} spots used`
            : `${containersForShelf.length} container${containersForShelf.length === 1 ? '' : 's'} on this shelf`}
        </p>
      )}

      {/* Compact summary of selected location */}
      {value?.zoneName && (
        <p className="text-tiny text-default-400 pl-1">
          📍 {value.zoneName}
          {selectedZone?.level && ` (${selectedZone.level === 'upper' ? 'Upper' : 'Lower'})`}
          {value.shelfName && ` › ${value.shelfName}`}
          {value.level != null && ` › L${value.level}`}
          {value.containerName && ` › ${value.containerName}`}
        </p>
      )}
    </div>
  );
}
