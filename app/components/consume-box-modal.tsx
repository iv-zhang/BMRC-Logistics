'use client';

import { useState, useMemo } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Select,
  SelectItem,
  Input,
  Card,
  CardBody,
} from '@heroui/react';
import type { InventoryItem, InventoryBatch, PurchaseInfo } from '@/app/types';
import { consumeBox } from '@/app/lib/inventory';
import { auth } from '@/firebase';

interface ConsumeBoxModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: InventoryItem;
  onSuccess?: () => void;
}

export default function ConsumeBoxModal({
  isOpen,
  onClose,
  item,
  onSuccess,
}: ConsumeBoxModalProps) {
  const [boxCount, setBoxCount] = useState<number>(1);
  const [selectedBatchId, setSelectedBatchId] = useState<string>('new');
  const [notes, setNotes] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>('');
  
  // Purchase tracking fields
  const [supplierName, setSupplierName] = useState<string>('');
  const [pricePerUnit, setPricePerUnit] = useState<string>('');
  const [purchaseOrderId, setPurchaseOrderId] = useState<string>('');
  const [showPurchaseFields, setShowPurchaseFields] = useState(false);

  const currentUser = auth.currentUser;
  const itemsPerBox = item.itemsPerBox || 1;
  const currentUnopened = item.unopenedBoxes || 0;

  // Get existing open batches (batches with openDate or lotNumber='OPEN')
  const openBatches = useMemo(() => {
    return (item.batches || []).filter(
      b => b.openDate || b.lotNumber === 'OPEN' || b.lotNumber === ''
    );
  }, [item.batches]);

  const unitsToAdd = boxCount * itemsPerBox;
  const newUnopenedCount = currentUnopened - boxCount;

  const handleSubmit = async () => {
    if (boxCount < 1) {
      setError('Box count must be at least 1');
      return;
    }
    if (boxCount > currentUnopened) {
      setError(`Only ${currentUnopened} unopened boxes available`);
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const targetBatchId = selectedBatchId === 'new' ? undefined : selectedBatchId;
      
      const purchase: PurchaseInfo | undefined = (supplierName || pricePerUnit || purchaseOrderId) ? {
        supplierName: supplierName || undefined,
        pricePerUnit: pricePerUnit ? Number(pricePerUnit) : undefined,
        currency: 'USD',
        purchaseOrderId: purchaseOrderId || undefined,
        receivedAt: new Date(),
      } : undefined;
      
      await consumeBox(item.id, boxCount, {
        targetBatchId,
        openDate: new Date(),
        userId: currentUser?.uid || 'system',
        userName: currentUser?.displayName || currentUser?.email || 'Unknown',
        notes: notes || undefined,
        purchase,
      });

      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      console.error('Failed to consume box:', err);
      setError(err.message || 'Failed to consume box');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setBoxCount(1);
    setSelectedBatchId('new');
    setNotes('');
    setError('');
    setSupplierName('');
    setPricePerUnit('');
    setPurchaseOrderId('');
    setShowPurchaseFields(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="2xl">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          Consume Box — {item.name}
        </ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            {/* Info card */}
            <Card>
              <CardBody>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="font-semibold">Current unopened boxes:</span>{' '}
                    {currentUnopened}
                  </div>
                  <div>
                    <span className="font-semibold">Items per box:</span> {itemsPerBox}
                  </div>
                </div>
              </CardBody>
            </Card>

            {/* Box count input */}
            <Input
              type="number"
              label="Number of boxes to open"
              min={1}
              max={currentUnopened}
              value={String(boxCount)}
              onChange={(e) => setBoxCount(Math.max(1, parseInt(e.target.value) || 1))}
              description={`Opening ${boxCount} box(es) will add ${unitsToAdd} unit(s) to the selected batch`}
            />

            {/* Batch selection */}
            <Select
              label="Add opened units to"
              selectedKeys={[selectedBatchId]}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                setSelectedBatchId(selected || 'new');
              }}
              description="Choose an existing open batch or create a new one"
            >
              <SelectItem key="new">
                Create new open batch
              </SelectItem>
              {openBatches.map((batch) => (
                <SelectItem key={batch.id}>
                  {batch.lotNumber || 'OPEN'} — {batch.stock} units (opened{' '}
                  {batch.openDate
                    ? new Date(batch.openDate).toLocaleDateString()
                    : 'date unknown'}
                  )
                </SelectItem>
              )) as any}
            </Select>

            {/* Notes */}
            <Input
              label="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="E.g., Moving stock to forward staging for restocks"
            />
            
            {/* Purchase Info Toggle */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="flat"
                onPress={() => setShowPurchaseFields(!showPurchaseFields)}
              >
                {showPurchaseFields ? 'Hide' : 'Add'} Purchase Info
              </Button>
              <span className="text-xs text-gray-500">Track vendor and pricing for comparison</span>
            </div>
            
            {/* Purchase Info Fields */}
            {showPurchaseFields && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-200">
                <Input
                  size="sm"
                  label="Supplier Name"
                  placeholder="e.g., Medline, Henry Schein"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                />
                <Input
                  size="sm"
                  type="number"
                  label="Price Per Unit (USD)"
                  placeholder="0.00"
                  value={pricePerUnit}
                  onChange={(e) => setPricePerUnit(e.target.value)}
                />
                <Input
                  size="sm"
                  label="PO / Invoice #"
                  placeholder="PO-1234"
                  value={purchaseOrderId}
                  onChange={(e) => setPurchaseOrderId(e.target.value)}
                  className="md:col-span-2"
                />
              </div>
            )}

            {/* Preview */}
            <Card>
              <CardBody>
                <div className="text-sm space-y-1">
                  <div className="font-semibold">Preview:</div>
                  <div>
                    Unopened boxes: {currentUnopened} → {newUnopenedCount}
                  </div>
                  <div>
                    {selectedBatchId === 'new' ? (
                      <>New open batch will be created with {unitsToAdd} units</>
                    ) : (
                      <>
                        Batch {selectedBatchId} will increase by {unitsToAdd} units
                      </>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>

            {error && (
              <div className="text-danger text-sm bg-danger-50 p-3 rounded">
                {error}
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={handleClose}>
            Cancel
          </Button>
          <Button
            color="primary"
            onPress={handleSubmit}
            isLoading={isSubmitting}
            isDisabled={boxCount < 1 || boxCount > currentUnopened}
          >
            Consume {boxCount} Box{boxCount !== 1 ? 'es' : ''}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
