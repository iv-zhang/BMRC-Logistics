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
import type { Shelf, StorageZone } from '@/app/types';

interface Props {
  shelf: Shelf | null;
  zones: StorageZone[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
}

/** Propagate a shelf rename to every inventory item that cached the old name. */
async function propagateShelfRename(shelfId: string, newName: string) {
  try {
    const q = query(collection(db, 'inventory'), where('storageLocation.shelfId', '==', shelfId));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const chunk = docs.slice(i, i + 450);
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.update(doc(db, 'inventory', d.id), { 'storageLocation.shelfName': newName });
      });
      await batch.commit();
    }
  } catch (e) {
    console.error('Failed to propagate shelf rename to inventory items', e);
  }
}

/** Propagate a shelf's zone reassignment to every inventory item stored on it. */
async function propagateShelfZoneChange(shelfId: string, newZoneId: string | null, newZoneName: string | null) {
  try {
    const q = query(collection(db, 'inventory'), where('storageLocation.shelfId', '==', shelfId));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const chunk = docs.slice(i, i + 450);
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.update(doc(db, 'inventory', d.id), {
          'storageLocation.zoneId': newZoneId,
          'storageLocation.zoneName': newZoneName,
        });
      });
      await batch.commit();
    }
  } catch (e) {
    console.error('Failed to propagate shelf zone reassignment to inventory items', e);
  }
}

export default function ShelfEditor({ shelf, zones, isOpen, onOpenChange, onSave }: Props) {
  const [name, setName] = useState('');
  const [zoneId, setZoneId] = useState<string | undefined>(undefined);
  const [capacity, setCapacity] = useState<number | undefined>(undefined);
  const [barcode, setBarcode] = useState<string | undefined>(undefined);
  const [numberOfLevels, setNumberOfLevels] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (shelf) {
      setName(shelf.name || '');
      setZoneId(shelf.zoneId || undefined);
      setCapacity(shelf.capacity ?? undefined);
      setBarcode(shelf.barcode ?? undefined);
      setNumberOfLevels(shelf.numberOfLevels ?? undefined);
    } else {
      setName('');
      setZoneId(undefined);
      setCapacity(undefined);
      setBarcode(undefined);
      setNumberOfLevels(undefined);
    }
  }, [shelf, isOpen]);

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Name is required');
      return;
    }
    setLoading(true);
    try {
      if (shelf && shelf.id) {
        const trimmedName = name.trim();
        const newZoneId = zoneId || null;
        const ref = doc(db, 'shelves', shelf.id);
        await updateDoc(ref, {
          name: trimmedName,
          zoneId: newZoneId,
          capacity: capacity ?? null,
          barcode: barcode || null,
          numberOfLevels: numberOfLevels ?? null,
          updatedAt: serverTimestamp(),
        } as any);

        if (trimmedName !== (shelf.name || '')) {
          await propagateShelfRename(shelf.id, trimmedName);
        }
        if (newZoneId !== (shelf.zoneId || null)) {
          const newZone = newZoneId ? zones.find((z) => z.id === newZoneId) : null;
          await propagateShelfZoneChange(shelf.id, newZoneId, newZone?.name || null);
        }
      } else {
        await addDoc(collection(db, 'shelves'), {
          name: name.trim(),
          zoneId: zoneId || null,
          capacity: capacity ?? null,
          barcode: barcode || null,
          numberOfLevels: numberOfLevels ?? null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } as any);
      }
      onSave();
    } catch (e) {
      console.error('Failed to save shelf', e);
      alert('Failed to save shelf');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent className="max-w-md w-[95%]">
        <ModalHeader>
          <div className="text-lg font-semibold">{shelf ? 'Edit Shelf' : 'Add Shelf'}</div>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-600">Name</label>
              <Input value={name} onValueChange={(v) => setName(v)} />
            </div>

            <div>
              <Select label="Zone" size="sm" selectedKeys={[zoneId ?? '']} onChange={(e) => setZoneId(e.target.value || undefined)}>
                <SelectItem key="">-- None --</SelectItem>
                {(
                  zones.map(z => (
                    <SelectItem key={z.id}>{z.name}</SelectItem>
                  )) as unknown as any
                )}
              </Select>
            </div>

            <div>
              <label className="text-xs text-gray-600">Capacity</label>
              <Input type="number" value={capacity != null ? String(capacity) : ''} onValueChange={(v) => setCapacity(v ? Number(v) : undefined)} />
            </div>

            <div>
              <label className="text-xs text-gray-600">Barcode</label>
              <Input value={barcode ?? ''} onValueChange={(v) => setBarcode(v || undefined)} />
            </div>

            <div>
              <label className="text-xs text-gray-600">Number of Levels</label>
              <Input
                type="number"
                placeholder="e.g., 4 for a 4-tier shelf"
                value={numberOfLevels != null ? String(numberOfLevels) : ''}
                onValueChange={(v) => setNumberOfLevels(v ? Number(v) : undefined)}
                description="How many levels/tiers does this shelf have?"
              />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex items-center gap-2">
            <Button color="primary" isLoading={loading} onPress={handleSave}>{shelf ? 'Save' : 'Create'}</Button>
            <Button variant="flat" onPress={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
