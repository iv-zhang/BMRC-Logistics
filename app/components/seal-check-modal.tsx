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
  Divider,
} from '@heroui/react';
import { checkBoxSeal, fetchContainerById } from '@/app/lib/inventory';
import type { Container } from '@/app/types';

interface SealCheckModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  boxBarcode: string;
  onSealCheckComplete?: (sealIntact: boolean) => void;
}

/**
 * Modal for scanning a sealed box barcode and verifying seal integrity.
 * 
 * Workflow:
 * 1. User scans box barcode (already provided via props)
 * 2. Modal shows: "Is the seal intact?"
 * 3. Yes: Log check, assume box contents unchanged, close modal
 * 4. No: Ask user to manually count contents, log with actual counts, close modal
 */
export default function SealCheckModal({
  isOpen,
  onOpenChange,
  boxBarcode,
  onSealCheckComplete,
}: SealCheckModalProps) {
  const [box, setBox] = useState<Container | null>(null);
  const [loading, setLoading] = useState(false);
  const [sealStatus, setSealStatus] = useState<'pending' | 'intact' | 'broken'>(
    'pending'
  );
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [currentUser, setCurrentUser] = useState<{
    uid: string;
    displayName: string;
  } | null>(null);

  // Load box details when modal opens
  React.useEffect(() => {
    if (isOpen && boxBarcode) {
      loadBoxDetails();
    }
  }, [isOpen, boxBarcode]);

  const loadBoxDetails = async () => {
    setLoading(true);
    try {
      // Try to find container by barcode
      const container = await fetchContainerById(boxBarcode);
      if (container) {
        setBox(container);
      } else {
        alert(`Box not found: ${boxBarcode}`);
      }
    } catch (e) {
      console.error('Failed to load box:', e);
      alert('Error loading box details');
    } finally {
      setLoading(false);
    }
  };

  const handleSealIntact = async () => {
    setSealStatus('intact');
    try {
      await checkBoxSeal({
        containerId: box?.id || boxBarcode,
        userId: currentUser?.uid || 'unknown',
        userName: currentUser?.displayName || 'Unknown',
        sealIntact: true,
        notes: 'Seal verified intact during inventory check',
      });

      alert(`✓ Seal intact. Box contents assumed unchanged.`);
      onSealCheckComplete?.(true);
      resetAndClose();
    } catch (e) {
      console.error('Failed to log seal check:', e);
      alert('Error logging seal check');
      setSealStatus('pending');
    }
  };

  const handleSealBroken = () => {
    setSealStatus('broken');
    // User will now be asked to manually count contents
  };

  const handleManualCountSubmit = async () => {
    try {
      await checkBoxSeal({
        containerId: box?.id || boxBarcode,
        userId: currentUser?.uid || 'unknown',
        userName: currentUser?.displayName || 'Unknown',
        sealIntact: false,
        itemsCounted: itemCounts,
        notes,
      });

      alert('✗ Seal broken. Count logged for reconciliation.');
      onSealCheckComplete?.(false);
      resetAndClose();
    } catch (e) {
      console.error('Failed to log seal break:', e);
      alert('Error logging seal break');
    }
  };

  const resetAndClose = () => {
    setSealStatus('pending');
    setItemCounts({});
    setNotes('');
    onOpenChange(false);
  };

  const handleCountChange = (itemId: string, count: number) => {
    setItemCounts(prev => ({
      ...prev,
      [itemId]: count,
    }));
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} backdrop="blur" size="lg">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          Sealed Box Inventory Check
        </ModalHeader>

        <ModalBody>
          {loading ? (
            <p>Loading box details...</p>
          ) : !box ? (
            <p className="text-danger">Box not found. Check barcode and retry.</p>
          ) : (
            <>
              <Card className="bg-default-100">
                <CardBody className="gap-3">
                  <div className="font-semibold">{box.name}</div>
                  <div className="text-sm text-default-500">
                    ID: {box.id}
                  </div>
                  {box.isSealed && (
                    <div className="text-sm">
                      <span className="font-semibold">Seal #:</span> {box.sealNumber}
                    </div>
                  )}
                  {box.boxContents && box.boxContents.length > 0 && (
                    <div className="text-sm">
                      <span className="font-semibold">Expected Contents:</span>
                      <ul className="list-disc list-inside mt-2">
                        {box.boxContents.map(content => (
                          <li key={`${content.itemId}-${content.batchId}`}>
                            Item {content.itemId}: {content.quantity}x
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardBody>
              </Card>

              <Divider />

              {sealStatus === 'pending' && (
                <div className="gap-3 flex flex-col">
                  <p className="text-lg font-semibold">
                    Is the seal intact?
                  </p>
                  <div className="flex gap-2">
                    <Button
                      color="success"
                      size="lg"
                      onPress={handleSealIntact}
                      className="flex-1"
                    >
                      ✓ Yes, Seal Intact
                    </Button>
                    <Button
                      color="danger"
                      size="lg"
                      variant="bordered"
                      onPress={handleSealBroken}
                      className="flex-1"
                    >
                      ✗ No, Broken/Tampered
                    </Button>
                  </div>
                </div>
              )}

              {sealStatus === 'broken' && (
                <div className="gap-3 flex flex-col">
                  <p className="text-warning font-semibold">
                    Seal is broken. Please manually count contents below.
                  </p>

                  {box.boxContents && box.boxContents.length > 0 && (
                    <Card className="bg-default-100">
                      <CardBody className="gap-3">
                        <p className="font-semibold text-sm">Manual Counts:</p>
                        {box.boxContents.map(content => (
                          <div
                            key={`${content.itemId}-${content.batchId}`}
                            className="flex gap-2 items-center"
                          >
                            <label className="flex-1 text-sm">
                              Item {content.itemId} (expected: {content.quantity})
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={itemCounts[content.itemId] || ''}
                              onChange={e =>
                                handleCountChange(
                                  content.itemId,
                                  parseInt(e.target.value, 10) || 0
                                )
                              }
                              className="w-20 px-2 py-1 border rounded"
                              placeholder="Count"
                            />
                          </div>
                        ))}
                      </CardBody>
                    </Card>
                  )}

                  <div className="flex flex-col gap-1">
                    <label htmlFor="break-notes" className="text-sm font-semibold">
                      Notes (optional):
                    </label>
                    <textarea
                      id="break-notes"
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      placeholder="e.g., Evidence of tampering, items scattered..."
                      className="px-2 py-1 border rounded text-sm"
                      rows={3}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </ModalBody>

        <ModalFooter>
          {sealStatus === 'pending' ? (
            <Button color="default" onPress={() => resetAndClose()}>
              Cancel
            </Button>
          ) : sealStatus === 'broken' ? (
            <>
              <Button
                color="default"
                variant="light"
                onPress={() => setSealStatus('pending')}
              >
                Back
              </Button>
              <Button
                color="danger"
                onPress={handleManualCountSubmit}
              >
                Log Broken Seal & Counts
              </Button>
            </>
          ) : null}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
