'use client';

import React, { useEffect, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Select, SelectItem } from '@heroui/react';
import { AlertTriangle, Printer, ScanBarcode } from 'lucide-react';
import { useRouter } from 'next/navigation';
import ScannerInput from '@/app/components/scanner-input';
import { assignBarcode } from '@/app/lib/inventory';
import type { InventoryItem } from '@/app/types';

interface AssignBarcodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The inventory item (or asset-tracked instance's parent item) getting the tag. */
  item: InventoryItem | null;
  user: { id: string; fullName?: string } | null;
  /** Called after a successful assign/reassign, before the modal auto-closes. */
  onAssigned?: () => void;
}

/**
 * Shared "assign a barcode / QR / RFID tag to this item, or print its label"
 * flow. Used from both `/assets` and `/inventory` — any inventory item can
 * carry a tag, not only asset-tracked ones. Duplicate detection and the
 * actual write go through `assignBarcode` (`app/lib/inventory.ts`), which
 * keys off the `barcode_index` collection.
 */
export default function AssignBarcodeModal({ isOpen, onClose, item, user, onAssigned }: AssignBarcodeModalProps) {
  const router = useRouter();
  const [scannedCode, setScannedCode] = useState('');
  const [serial, setSerial] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState<{
    duplicateItem?: { id: string; name: string; serial?: string };
  } | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  const hasInstances = Array.isArray(item?.assets) && (item?.assets?.length ?? 0) > 0;

  useEffect(() => {
    if (isOpen) {
      setScannedCode('');
      setSerial(hasInstances ? item?.assets?.[0]?.serial || '' : '');
      setDuplicateWarning(null);
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.id]);

  if (!item) return null;

  async function doAssign(allowDuplicate: boolean) {
    if (!item || !user || !scannedCode.trim()) return;
    setAssigning(true);
    setResult(null);
    try {
      const res = await assignBarcode({
        itemId: item.id,
        barcode: scannedCode,
        user,
        serial: hasInstances ? serial || undefined : undefined,
        options: { allowDuplicate },
      });
      if (!res.success) {
        if (res.isDuplicate && !allowDuplicate) {
          setDuplicateWarning({ duplicateItem: res.duplicateItem });
        } else {
          setResult({ text: res.message, ok: false });
        }
      } else {
        setDuplicateWarning(null);
        setResult({ text: res.message, ok: true });
        onAssigned?.();
      }
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : 'Failed to assign barcode', ok: false });
    } finally {
      setAssigning(false);
    }
  }

  function printLabel() {
    if (!item) return;
    router.push(`/print-labels?ids=${item.id}`);
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <ScanBarcode size={18} className="text-primary" /> Assign barcode / print label
        </ModalHeader>
        <ModalBody className="pb-2 gap-4">
          <div className="bg-content2 rounded-large px-3 py-2 text-sm font-semibold text-foreground truncate">
            {item.name}
          </div>

          {hasInstances && (
            <Select
              size="sm"
              label="Instance / serial"
              selectedKeys={serial ? [serial] : []}
              onSelectionChange={(keys) => setSerial((Array.from(keys)[0] as string) || '')}
            >
              {(item.assets || []).map((a) => (
                <SelectItem key={a.serial}>{a.assetTag || a.serial}</SelectItem>
              ))}
            </Select>
          )}

          <ScannerInput
            onScan={(code) => { setScannedCode(code); setDuplicateWarning(null); setResult(null); }}
            placeholder="Scan or type a barcode/QR/RFID tag..."
            label="Barcode / QR / RFID tag"
          />

          <p className="text-xs text-foreground-400">
            A handheld USB/Bluetooth RFID or barcode reader works here too — focus the field
            above and scan; it registers the tag the same way as the camera or manual entry.
          </p>

          {duplicateWarning && (
            <div className="flex items-start gap-2 bg-warning-50 dark:bg-warning-950/20 border border-warning/30 rounded-large px-3 py-2.5">
              <AlertTriangle size={15} className="text-warning flex-none mt-0.5" />
              <div className="text-xs text-warning">
                <span className="font-semibold">Already assigned</span> to{' '}
                {duplicateWarning.duplicateItem?.name}
                {duplicateWarning.duplicateItem?.serial ? ` (Serial: ${duplicateWarning.duplicateItem.serial})` : ''}.
              </div>
            </div>
          )}

          {result && (
            <div className={`text-xs font-semibold ${result.ok ? 'text-success' : 'text-danger'}`}>
              {result.text}
            </div>
          )}
        </ModalBody>
        <ModalFooter className="flex items-center justify-between gap-3">
          <Button
            variant="light"
            size="sm"
            startContent={<Printer size={14} />}
            onPress={printLabel}
          >
            Print label
          </Button>
          <div className="flex items-center gap-2">
            {duplicateWarning ? (
              <>
                <Button variant="light" onPress={() => setDuplicateWarning(null)}>Cancel</Button>
                <Button color="warning" isLoading={assigning} onPress={() => doAssign(true)}>
                  Assign anyway
                </Button>
              </>
            ) : (
              <>
                <Button variant="light" onPress={onClose}>Close</Button>
                <Button
                  color="primary"
                  isDisabled={!scannedCode.trim() || !user}
                  isLoading={assigning}
                  onPress={() => doAssign(false)}
                >
                  Assign
                </Button>
              </>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
