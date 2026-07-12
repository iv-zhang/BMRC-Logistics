'use client';

import { useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
} from '@heroui/react';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { useUserRole } from '@/app/hooks/useUserRole';
import { addVehicle, updateVehicle } from '@/app/lib/vehicles';
import type { Vehicle } from '@/app/types';

interface VehicleEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Existing vehicle to edit; omit to create a new one */
  vehicle?: Vehicle | null;
}

export default function VehicleEditorModal({ isOpen, onClose, vehicle }: VehicleEditorModalProps) {
  const { vehicles: vehicleTypes } = useOrgConfig();
  const { user, fullName } = useUserRole();
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(vehicle?.name ?? '');
    setTypeId(vehicle?.typeId ?? vehicleTypes[0]?.id ?? '');
    setNotes(vehicle?.notes ?? '');
    setError(null);
  }, [isOpen, vehicle, vehicleTypes]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Vehicle name is required'); return; }
    if (!typeId) { setError('Select a vehicle type'); return; }
    setSaving(true);
    setError(null);
    try {
      if (vehicle?.id) {
        await updateVehicle(vehicle.id, { name, typeId, notes });
      } else {
        await addVehicle({ name, typeId, notes: notes || undefined }, {
          uid: user?.uid ?? 'unknown',
          name: fullName || user?.email || 'Unknown',
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save vehicle');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} placement="center">
      <ModalContent>
        <ModalHeader className="text-base font-semibold">
          {vehicle ? 'Edit vehicle' : 'Add vehicle'}
        </ModalHeader>
        <ModalBody className="gap-4">
          <Input
            label="Name"
            placeholder="Ambulance 2, UTV-1…"
            value={name}
            onValueChange={setName}
            isRequired
            autoFocus
          />
          <Select
            label="Vehicle type"
            selectedKeys={typeId ? [typeId] : []}
            onSelectionChange={(keys) => setTypeId(String(Array.from(keys)[0] ?? ''))}
            isRequired
          >
            {vehicleTypes.map((t) => (
              <SelectItem key={t.id}>{t.name}</SelectItem>
            ))}
          </Select>
          <Textarea
            label="Notes"
            placeholder="Optional — plate, quirks, storage spot…"
            value={notes}
            onValueChange={setNotes}
            minRows={2}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={onClose} isDisabled={saving}>Cancel</Button>
          <Button color="primary" onPress={handleSave} isLoading={saving}>
            {vehicle ? 'Save changes' : 'Add vehicle'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
