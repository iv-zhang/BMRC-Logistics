'use client';

import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Input,
  Select,
  SelectItem,
} from '@heroui/react';
import { logRestockNeeded } from '@/app/lib/inventory';
import { AlertCircle } from 'lucide-react';

interface RestockAlertModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  itemName: string;
  currentQuantity: number;
  parLevel: number;
  locations?: { id: string; name: string }[];
  userId: string;
  userName: string;
  onComplete?: () => void;
}

/**
 * Modal for quickly logging restock needed alert.
 * 
 * Workflow:
 * 1. User notices stock is below par (or manually triggers restock)
 * 2. Opens modal, confirms item name and current count
 * 3. Selects location (optional)
 * 4. Submits alert to inventory_alerts collection
 * 5. Admin/quartermaster can review and act on alerts
 * 
 * Accountability: Tracks who reported low stock and when.
 */
export default function RestockAlertModal({
  isOpen,
  onOpenChange,
  itemId,
  itemName,
  currentQuantity,
  parLevel,
  locations,
  userId,
  userName,
  onComplete,
}: RestockAlertModalProps) {
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [confirmedCount, setConfirmedCount] = useState(String(currentQuantity));
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const count = parseInt(confirmedCount, 10) || currentQuantity;
      
      await logRestockNeeded({
        itemId,
        itemName,
        currentQuantity: count,
        parLevel,
        location: selectedLocation || 'HQ',
        userId,
        userName,
      });

      alert(`✓ Restock alert logged for ${itemName}. Par: ${parLevel}, Current: ${count}`);
      onComplete?.();
      handleClose();
    } catch (e) {
      console.error('Failed to log restock alert:', e);
      alert('Error logging restock alert. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedLocation('');
    setConfirmedCount(String(currentQuantity));
    onOpenChange(false);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <AlertCircle size={20} className="text-warning" />
          Restock Needed Alert
        </ModalHeader>

        <ModalBody className="gap-4">
          <Card className="bg-warning-100">
            <CardBody className="gap-2 py-3">
              <p className="font-semibold text-sm">{itemName}</p>
              <p className="text-xs text-default-600">
                Par Level: <span className="font-semibold">{parLevel}</span>
              </p>
            </CardBody>
          </Card>

          <div className="gap-3 flex flex-col">
            <Input
              type="number"
              label="Current Count"
              value={confirmedCount}
              onChange={e => setConfirmedCount(e.target.value)}
              description={`Par level is ${parLevel}. Current count is below par.`}
              min="0"
            />

            {locations && locations.length > 0 && (
              <Select
                label="Location"
                placeholder="Select location (optional)"
                value={selectedLocation}
                onChange={e => setSelectedLocation(e.target.value)}
                size="sm"
              >
                {locations.map(loc => (
                  <SelectItem key={loc.id} textValue={loc.name}>
                    {loc.name}
                  </SelectItem>
                ))}
              </Select>
            )}

            <Card className="bg-default-100">
              <CardBody className="py-2 text-sm gap-1">
                <p>Reported by: <span className="font-semibold">{userName}</span></p>
                <p>Item ID: <span className="text-xs text-default-500">{itemId}</span></p>
              </CardBody>
            </Card>
          </div>
        </ModalBody>

        <ModalFooter>
          <Button color="default" onPress={handleClose}>
            Cancel
          </Button>
          <Button
            color="warning"
            onPress={handleSubmit}
            isLoading={submitting}
            startContent={<AlertCircle size={16} />}
          >
            Log Restock Alert
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
