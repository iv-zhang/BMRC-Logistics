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
import type { Container, Shelf } from '@/app/types';

interface Props {
  container: Container | null;
  shelves: Shelf[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
}

/** Propagate a container rename to every inventory item that cached the old name. */
async function propagateContainerRename(containerId: string, newName: string) {
  try {
    const q = query(collection(db, 'inventory'), where('storageLocation.containerId', '==', containerId));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const chunk = docs.slice(i, i + 450);
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.update(doc(db, 'inventory', d.id), { 'storageLocation.containerName': newName });
      });
      await batch.commit();
    }
  } catch (e) {
    console.error('Failed to propagate container rename to inventory items', e);
  }
}

export default function ContainerEditor({ container, shelves, isOpen, onOpenChange, onSave }: Props) {
  const [name, setName] = useState('');
  const [shelfId, setShelfId] = useState<string | undefined>(undefined);
  const [barcode, setBarcode] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (container) {
      setName(container.name || '');
      setShelfId(container.shelfId || undefined);
      setBarcode(container.barcode ?? undefined);
    } else {
      setName('');
      setShelfId(undefined);
      setBarcode(undefined);
    }
  }, [container, isOpen]);

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Name is required');
      return;
    }
    setLoading(true);
    try {
      if (container && container.id) {
        const trimmedName = name.trim();
        const ref = doc(db, 'containers', container.id);
        await updateDoc(ref, {
          name: trimmedName,
          shelfId: shelfId || null,
          barcode: barcode || null,
          updatedAt: serverTimestamp(),
        } as any);

        if (trimmedName !== (container.name || '')) {
          await propagateContainerRename(container.id, trimmedName);
        }
      } else {
        await addDoc(collection(db, 'containers'), {
          name: name.trim(),
          shelfId: shelfId || null,
          barcode: barcode || null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } as any);
      }
      onSave();
    } catch (e) {
      console.error('Failed to save container', e);
      alert('Failed to save container');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm">
      <ModalContent className="max-w-md w-[95%]">
        <ModalHeader>
          <div className="text-lg font-semibold">{container ? 'Edit Container' : 'Add Container'}</div>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-600">Name</label>
              <Input value={name} onValueChange={(v) => setName(v)} />
            </div>

            <div>
              <Select label="Shelf" size="sm" selectedKeys={[shelfId ?? '']} onChange={(e) => setShelfId(e.target.value || undefined)}>
                <SelectItem key="">-- None --</SelectItem>
                {(
                  shelves.map(s => (
                    <SelectItem key={s.id}>{s.name}</SelectItem>
                  )) as unknown as any
                )}
              </Select>
            </div>

            <div>
              <label className="text-xs text-gray-600">Barcode</label>
              <Input value={barcode ?? ''} onValueChange={(v) => setBarcode(v || undefined)} />
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex items-center gap-2">
            <Button color="primary" isLoading={loading} onPress={handleSave}>{container ? 'Save' : 'Create'}</Button>
            <Button variant="flat" onPress={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
