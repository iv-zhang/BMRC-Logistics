'use client';
import React, { useState, useCallback } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Textarea,
  Divider,
  Spinner,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Card,
  CardBody,
} from '@heroui/react';
import { AlertTriangle, Upload } from 'lucide-react';

import type { ParsedSheetRow } from '@/app/lib/statpack-import';
import { parseSheetPaste, normalizePocket } from '@/app/lib/statpack-import';
import type { StatpackItem } from '@/app/types';

interface StatpackImportModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  onImportComplete: (items: StatpackItem[]) => void;
}

type Step = 'paste' | 'preview';

export default function StatpackImportModal({ isOpen, onOpenChange, onImportComplete }: StatpackImportModalProps) {
  const [step, setStep] = useState<Step>('paste');
  const [pastedText, setPastedText] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedSheetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    setStep('paste');
    setPastedText('');
    setParsedRows([]);
    setError(null);
    onOpenChange();
  }, [onOpenChange]);

  const handleParse = useCallback(() => {
    setError(null);
    setLoading(true);
    try {
      const rows = parseSheetPaste(pastedText);
      if (rows.length === 0) {
        setError('No valid rows found. Paste tab-separated or comma-separated data.');
        setLoading(false);
        return;
      }

      setParsedRows(rows.map((r) => ({ ...r })));
      setStep('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse error');
    } finally {
      setLoading(false);
    }
  }, [pastedText]);

  const handleImport = useCallback(() => {
    setError(null);
    setLoading(true);
    try {
      const now = Date.now();
      const items: StatpackItem[] = parsedRows.map((r, i) => ({
        itemId: `imported-${now}-${i}`,
        requiredQuantity: r.quantity,
        currentQuantity: 0,
        pocket: normalizePocket(r.pocket),
        compartmentId: undefined,
        batchId: '',
        // minimal itemDetails to preserve display name
        itemDetails: {
          id: `imported-${now}-${i}`,
          name: r.rawName,
          category: 'Other',
          unopenedBoxes: 0,
          tracksExpiration: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      }));

      onImportComplete(items);
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  }, [parsedRows, onImportComplete, handleClose]);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" scrollBehavior="inside" backdrop="blur">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            <span>Import Statpack from Google Sheets</span>
          </div>
          <p className="text-xs font-normal text-default-500">Paste tab-separated data: [name] [qty] [optional cols] [pocket]</p>
        </ModalHeader>

        <ModalBody>
          {error && (
            <Card isBlurred className="bg-danger-50 border border-danger-200">
              <CardBody className="flex flex-row gap-3 py-3">
                <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                <p className="text-sm text-danger-700 whitespace-pre-wrap">{error}</p>
              </CardBody>
            </Card>
          )}

          {step === 'paste' && (
            <div className="space-y-4">
              <Textarea label="Paste Google Sheets Data" placeholder="Select data in Google Sheets, copy, and paste here..." value={pastedText} onValueChange={setPastedText} minRows={8} className="font-mono text-xs" />
              <p className="text-xs text-default-500">
                • Supports tab-separated or comma-separated format
                <br />• Expected columns: [Item Name] [Quantity] [... other cols ...] [Pocket]
                <br />• Pocket values: main, front, left, right (auto-normalized)
              </p>
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-4">
              <p className="text-sm font-semibold">Parsed {parsedRows.length} rows:</p>
              <Table aria-label="Parsed rows preview" classNames={{ table: 'text-xs', th: 'bg-default-100 text-xs font-semibold' }}>
                <TableHeader>
                  <TableColumn>Item Name</TableColumn>
                  <TableColumn align="center">Qty</TableColumn>
                  <TableColumn>Pocket</TableColumn>
                </TableHeader>
                <TableBody>
                  {parsedRows.map((row, idx) => (
                    <TableRow key={idx}>
                      <TableCell>{row.rawName}</TableCell>
                      <TableCell align="center">{row.quantity}</TableCell>
                      <TableCell>{row.rawPocket}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {loading && (
            <div className="flex justify-center py-4">
              <Spinner size="lg" />
            </div>
          )}
        </ModalBody>

        <Divider />

        <ModalFooter>
          <Button color="default" variant="light" onPress={handleClose}>
            Cancel
          </Button>

          {step === 'paste' && (
            <Button color="primary" isLoading={loading} onPress={handleParse}>
              Parse & Preview
            </Button>
          )}

          {step === 'preview' && (
            <>
              <Button color="default" onPress={() => setStep('paste')}>
                Back
              </Button>
              <Button color="success" isLoading={loading} onPress={handleImport}>
                Import Items
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}