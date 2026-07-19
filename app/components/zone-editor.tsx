'use client';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Button,
  Select,
  SelectItem,
} from '@heroui/react';
import {
  addDoc,
  collection,
  doc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  getDocs,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { StorageZone, LocationType } from '@/app/types';
import { getLocationNames, getRoomNames } from '@/app/config/org-config';

interface Props {
  zone: StorageZone | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  /** Defaults applied only when creating a new zone (zone === null). */
  prefill?: { locationType?: string; room?: string };
}

const LEVEL_OPTIONS: { key: 'upper' | 'lower'; label: string }[] = [
  { key: 'upper', label: 'Upper (entrance)' },
  { key: 'lower', label: 'Lower (main HQ)' },
];

/** Propagate a zone rename to every inventory item that cached the old name. */
async function propagateZoneRename(zoneId: string, newName: string) {
  try {
    const q = query(collection(db, 'inventory'), where('storageLocation.zoneId', '==', zoneId));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const chunk = docs.slice(i, i + 450);
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.update(doc(db, 'inventory', d.id), { 'storageLocation.zoneName': newName });
      });
      await batch.commit();
    }
  } catch (e) {
    console.error('Failed to propagate zone rename to inventory items', e);
  }
}

export default function ZoneEditor({ zone, isOpen, onOpenChange, onSave, prefill }: Props) {
  const [name, setName] = useState('');
  const [locationType, setLocationType] = useState<string>('HQ');
  const [room, setRoom] = useState<string | undefined>(undefined);
  const [level, setLevel] = useState<'upper' | 'lower' | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const locationNames = getLocationNames();
  const roomNames = locationType === 'HQ' ? getRoomNames('hq') : [];

  useEffect(() => {
    if (zone) {
      setName(zone.name || '');
      setLocationType(zone.locationType || 'HQ');
      setRoom(zone.room || undefined);
      setLevel(zone.level || undefined);
      setDescription(zone.description || '');
    } else {
      setName('');
      setLocationType(prefill?.locationType || 'HQ');
      setRoom(prefill?.room || undefined);
      setLevel(undefined);
      setDescription('');
    }
  }, [zone, isOpen, prefill?.locationType, prefill?.room]);

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Name is required');
      return;
    }
    setLoading(true);
    try {
      const trimmedName = name.trim();
      if (zone && zone.id) {
        const ref = doc(db, 'storage_zones', zone.id);
        await updateDoc(ref, {
          name: trimmedName,
          locationType: locationType as LocationType,
          room: room || null,
          level: level || null,
          description: description || null,
          updatedAt: serverTimestamp(),
        } as any);

        if (trimmedName !== (zone.name || '')) {
          await propagateZoneRename(zone.id, trimmedName);
        }
      } else {
        await addDoc(collection(db, 'storage_zones'), {
          name: trimmedName,
          locationType: locationType as LocationType,
          room: room || null,
          level: level || null,
          description: description || null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } as any);
      }
      onSave();
    } catch (e) {
      console.error('Failed to save zone', e);
      alert('Failed to save zone');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent className="max-w-md w-[95%]">
        <ModalHeader>
          <div className="text-lg font-semibold">{zone ? 'Edit Storage Unit' : 'Add Storage Unit'}</div>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-foreground-500">Name</label>
              <Input value={name} onValueChange={(v) => setName(v)} placeholder="e.g., HQ / Back" />
            </div>

            <div>
              <Select
                label="Location Type"
                size="sm"
                selectedKeys={[locationType]}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocationType(val);
                  if (val !== 'HQ') setRoom(undefined);
                }}
              >
                {locationNames.map((n) => (
                  <SelectItem key={n}>{n}</SelectItem>
                ))}
              </Select>
            </div>

            {locationType === 'HQ' && (
              <div>
                <Select
                  label="Room"
                  size="sm"
                  selectedKeys={[room ?? '']}
                  onChange={(e) => setRoom(e.target.value || undefined)}
                >
                  {(
                    [
                      <SelectItem key="">-- None --</SelectItem>,
                      ...roomNames.map((r) => <SelectItem key={r}>{r}</SelectItem>),
                    ] as unknown as any
                  )}
                </Select>
              </div>
            )}

            <div>
              <Select
                label="Level (floor)"
                size="sm"
                selectedKeys={[level ?? '']}
                onChange={(e) => setLevel((e.target.value || undefined) as 'upper' | 'lower' | undefined)}
              >
                {(
                  [
                    <SelectItem key="">-- Unspecified --</SelectItem>,
                    ...LEVEL_OPTIONS.map((o) => <SelectItem key={o.key}>{o.label}</SelectItem>),
                  ] as unknown as any
                )}
              </Select>
            </div>

            <div>
              <label className="text-xs text-foreground-500">Description</label>
              <Input value={description} onValueChange={(v) => setDescription(v)} placeholder="Optional notes" />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex items-center gap-2">
            <Button color="primary" isLoading={loading} onPress={handleSave}>{zone ? 'Save' : 'Create'}</Button>
            <Button variant="flat" onPress={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
