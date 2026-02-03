'use client';
import React, { useEffect, useState, useRef } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db, auth } from '@/firebase';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Select, SelectItem, Textarea, Chip } from '@heroui/react';
import type { InventoryItem } from '@/app/types';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import AssetHistory from '@/app/components/asset-history';
import { exportLabelsToPDF, DEFAULT_TEMPLATE } from '@/app/lib/print';
import LabelCard from '@/app/components/label-card';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { assignBarcode } from '@/app/lib/inventory';

interface AssetModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (payload: Partial<InventoryItem>) => Promise<void> | void;
  onUpdate: (id: string, payload: Partial<InventoryItem>) => Promise<void> | void;
  initial?: InventoryItem | null;
}

export default function AssetModal({ isOpen, onOpenChange, onAdd, onUpdate, initial }: AssetModalProps) {
  const [form, setForm] = useState<Partial<InventoryItem>>({});
  const [knownLocations, setKnownLocations] = useState<string[]>([]);
  const [useCustomLocation, setUseCustomLocation] = useState(false);
  const [statpacks, setStatpacks] = useState<Array<{ id: string; name: string }>>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historySerial, setHistorySerial] = useState<string>('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  
  // Scanner and barcode assignment state
  const [showScanner, setShowScanner] = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState<string>('');
  const [duplicateWarning, setDuplicateWarning] = useState<{
    show: boolean;
    barcode: string;
    duplicateItem?: { id: string; name: string; serial?: string };
  } | null>(null);
  const [assigningBarcode, setAssigningBarcode] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setForm(initial ? { ...initial } : { name: '', isAsset: true, assetStatus: 'Ready' });
      setValidationError(null);
      setSaving(false);
      setHistorySerial('');
    }
  }, [isOpen, initial]);

  // Populate known locations from statpacks and inventory currentLocation fields
  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    (async () => {
      try {
        const locSet = new Set<string>();
        const spSnap = await getDocs(collection(db, 'statpacks'));
        const spList: Array<{ id: string; name: string }> = [];
        spSnap.forEach(s => {
          const d = s.data() as any;
          if (d?.currentLocation) locSet.add(String(d.currentLocation));
          spList.push({ id: s.id, name: d?.name || s.id });
        });
        const invSnap = await getDocs(collection(db, 'inventory'));
        invSnap.forEach(s => { const d = s.data() as any; if (d?.currentLocation) locSet.add(String(d.currentLocation)); });
        const arr = Array.from(locSet).filter(Boolean);
        if (mounted) {
          setKnownLocations(arr);
          setStatpacks(spList);
        }
      } catch (e) {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [isOpen]);

  const tagValue = String((form.assetSerial ?? (form as any).assetTag ?? form.name) || '');

  const generateTag = () => {
    const id = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `asset_${Date.now()}`;
    // Auto-populate serial/tag as well as barcode and QR so newly-generated tags are scannable
    setForm((prev) => ({ ...(prev as any), assetSerial: id, assetTag: id, barcode: id, qr: id } as any));
  };

  // Generate previews when tag changes
  useEffect(() => {
    let mounted = true;
    if (!tagValue) { setQrDataUrl(''); if (svgRef.current) svgRef.current.innerHTML = ''; return; }
    (async () => {
      try {
        const dataUrl = await QRCode.toDataURL(tagValue, { width: 200 });
        if (mounted) setQrDataUrl(dataUrl);
      } catch (e) {
        if (mounted) setQrDataUrl('');
      }
      try {
        if (svgRef.current) {
          JsBarcode(svgRef.current, tagValue, { format: 'code128', displayValue: true, width: 2, height: 40 });
        }
      } catch (e) {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [tagValue]);

  const printTag = async () => {
    try {
      const barcodeSvg = svgRef.current ? svgRef.current.outerHTML : '';
      const content = `
        <html><head><title>Print Asset Tag</title></head><body style="display:flex;flex-direction:column;align-items:center;gap:8px;font-family:sans-serif;padding:20px;">
          <h3>${(form.name || '').toString().replace(/</g, '&lt;')}</h3>
          ${qrDataUrl ? `<img src="${qrDataUrl}" alt="qr" />` : ''}
          ${barcodeSvg}
          <div style="margin-top:8px;font-size:14px;">${tagValue}</div>
        </body></html>
      `;
      const w = window.open('', '_blank');
      if (!w) { alert('Unable to open print window'); return; }
      w.document.write(content);
      w.document.close();
      w.focus();
      setTimeout(() => { w.print(); w.close(); }, 500);
    } catch (e) {
      alert('Failed to prepare print');
    }
  };

  const printTagPDF = async () => {
    try {
      if (!svgRef.current || !qrDataUrl) {
        alert('Please generate a QR code and barcode first');
        return;
      }

      // Create a temporary container with the label card
      const tempContainer = document.createElement('div');
      tempContainer.style.position = 'absolute';
      tempContainer.style.left = '-9999px';
      tempContainer.style.width = '120px'; // approximate label width in px
      document.body.appendChild(tempContainer);

      // Render label card using a simple canvas approach
      const labelCardDiv = document.createElement('div');
      labelCardDiv.style.width = '120px';
      labelCardDiv.style.height = '75px';
      labelCardDiv.style.border = '1px solid #e5e7eb';
      labelCardDiv.style.padding = '4px';
      labelCardDiv.style.display = 'flex';
      labelCardDiv.style.flexDirection = 'column';
      labelCardDiv.style.justifyContent = 'space-between';
      labelCardDiv.style.alignItems = 'center';
      labelCardDiv.style.backgroundColor = '#ffffff';
      labelCardDiv.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      labelCardDiv.style.boxSizing = 'border-box';
      labelCardDiv.style.overflow = 'hidden';

      // Add QR image
      const qrImg = document.createElement('img');
      qrImg.src = qrDataUrl;
      qrImg.style.width = '60px';
      qrImg.style.height = '60px';
      qrImg.style.objectFit = 'contain';
      labelCardDiv.appendChild(qrImg);

      // Clone SVG barcode
      const barcodeSvgClone = svgRef.current.cloneNode(true) as SVGSVGElement;
      barcodeSvgClone.style.maxWidth = '100%';
      barcodeSvgClone.style.height = 'auto';
      labelCardDiv.appendChild(barcodeSvgClone);

      // Add name
      const nameDiv = document.createElement('div');
      nameDiv.style.fontSize = '7px';
      nameDiv.style.textAlign = 'center';
      nameDiv.style.lineHeight = '1';
      nameDiv.style.overflow = 'hidden';
      nameDiv.style.width = '100%';
      nameDiv.textContent = (form.name || '').substring(0, 15);
      labelCardDiv.appendChild(nameDiv);

      tempContainer.appendChild(labelCardDiv);

      // Export to PDF
      await exportLabelsToPDF([labelCardDiv], DEFAULT_TEMPLATE, `${form.name || 'label'}.pdf`);

      // Clean up
      document.body.removeChild(tempContainer);
    } catch (e) {
      console.error('Failed to export PDF:', e);
      alert('Failed to export PDF');
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      // Ensure there is a barcode or QR; if not present, generate one on-the-fly
      let payload: Partial<InventoryItem> = { ...form } as Partial<InventoryItem>;
      if (!payload.barcode && !payload.qr) {
        const gen = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `asset_${Date.now()}`;
        payload = { ...payload, assetSerial: gen, assetTag: gen, barcode: gen, qr: gen } as Partial<InventoryItem>;
      }

      setValidationError(null);

      const serialToCheck = String(payload.assetSerial || '').trim();
      const barcodeToCheck = String(payload.barcode || '').trim();
      const qrToCheck = String(payload.qr || '').trim();

      const checkDuplicate = async (field: 'assetSerial' | 'barcode' | 'qr', value: string) => {
        if (!value) return false;
        const q = query(collection(db, 'inventory'), where(field, '==', value));
        const snap = await getDocs(q);
        return snap.docs.some((docSnap) => docSnap.id !== initial?.id);
      };

      if (await checkDuplicate('assetSerial', serialToCheck)) {
        setValidationError('Serial/Tag is already in use by another asset. Please enter a unique value.');
        setSaving(false);
        return;
      }
      if (await checkDuplicate('barcode', barcodeToCheck)) {
        setValidationError('Barcode is already in use by another asset. Please enter a unique value.');
        setSaving(false);
        return;
      }
      if (await checkDuplicate('qr', qrToCheck)) {
        setValidationError('QR Code is already in use by another asset. Please enter a unique value.');
        setSaving(false);
        return;
      }

      if (initial && initial.id) {
        console.log('AssetModal: updating', initial.id, payload);
        await onUpdate(initial.id, { ...payload, updatedAt: new Date() } as Partial<InventoryItem>);
        console.log('AssetModal: update complete');
        if (typeof onOpenChange === 'function') onOpenChange(false);
      } else {
        console.log('AssetModal: adding', payload);
        await onAdd({ ...payload, isAsset: true } as Partial<InventoryItem>);
        console.log('AssetModal: add complete');
        if (typeof onOpenChange === 'function') onOpenChange(false);
      }
    } catch (e) {
      console.error('AssetModal: save error', e);
      // eslint-disable-next-line no-alert
      alert((e as any)?.message ? `Failed to save asset: ${(e as any).message}` : 'Failed to save asset');
    } finally {
      setSaving(false);
    }
  };

  const handleScanDetected = (code: string) => {
    setScannedBarcode(code);
    setShowScanner(false);
    // Populate the assignedBarcode field in the form preview
    setForm({ ...form, assignedBarcode: code } as any);
  };

  const handleAssignBarcode = async (allowDuplicate = false) => {
    if (!initial?.id) {
      alert('Please save the asset first before assigning a barcode tag.');
      return;
    }
    
    if (!scannedBarcode.trim()) {
      alert('Please scan a barcode first.');
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      alert('You must be logged in to assign barcodes.');
      return;
    }

    setAssigningBarcode(true);
    setValidationError(null);
    setDuplicateWarning(null);

    try {
      const result = await assignBarcode({
        itemId: initial.id,
        barcode: scannedBarcode,
        user: { id: user.uid, fullName: user.displayName || user.email || 'Unknown' },
        serial: historySerial || undefined,
        options: { allowDuplicate },
      });

      if (!result.success) {
        if (result.isDuplicate && !allowDuplicate) {
          // Show duplicate warning with override option
          setDuplicateWarning({
            show: true,
            barcode: scannedBarcode,
            duplicateItem: result.duplicateItem,
          });
        } else {
          setValidationError(result.message);
        }
      } else {
        // Success - update form to reflect new assigned barcode
        setForm({ ...form, assignedBarcode: scannedBarcode } as any);
        alert(result.message);
        setScannedBarcode('');
        setDuplicateWarning(null);
      }
    } catch (error: any) {
      setValidationError(error.message || 'Failed to assign barcode');
    } finally {
      setAssigningBarcode(false);
    }
  };

  const handleDuplicateOverride = () => {
    handleAssignBarcode(true);
  };

  const handleCancelDuplicate = () => {
    setDuplicateWarning(null);
    setScannedBarcode('');
  };

  return (
    <>
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{initial ? `Edit Asset: ${initial.name}` : 'Add Asset'}</ModalHeader>
        <ModalBody className="space-y-3">
          {validationError && (
            <div className="bg-red-50 border border-red-200 rounded p-2">
              <p className="text-red-700 text-sm">{validationError}</p>
            </div>
          )}
          
          <Input label="Name" value={String(form.name ?? '')} onValueChange={(v) => setForm({ ...form, name: v })} />
          <Select label="Category" selectedKeys={[String((form.assetCategory as any) ?? 'Generic')]} onChange={(e) => setForm({ ...form, assetCategory: e.target.value as any })}>
            <SelectItem key="Generic">Generic</SelectItem>
            <SelectItem key="AED">AED</SelectItem>
            <SelectItem key="O2">O2</SelectItem>
            <SelectItem key="Bike">Bike</SelectItem>
            <SelectItem key="Radio">Radio</SelectItem>
          </Select>
          <Input label="Model" value={String(form.assetModel ?? '')} onValueChange={(v) => setForm({ ...form, assetModel: v })} />

          <Select
            label="Assigned Statpack"
            selectedKeys={[String(form.assignedToId ?? '')]}
            onChange={(e) => setForm({ ...form, assignedToId: e.target.value || undefined })}
            description="Single-assignment: an asset can belong to only one statpack"
          >
            <SelectItem key="">Unassigned</SelectItem>
            {(statpacks.map(s => <SelectItem key={s.id}>{s.name}</SelectItem>) as any)}
          </Select>
          
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Input label="Serial / Tag" value={String(form.assetSerial ?? '')} onValueChange={(v) => setForm({ ...form, assetSerial: v })} />
            </div>
            <div className="flex flex-col gap-2">
              <Button size="sm" variant="light" onPress={generateTag}>Generate</Button>
              <Button size="sm" variant="light" onPress={printTag}>Print</Button>
              <Button size="sm" variant="flat" color="primary" onPress={printTagPDF}>PDF</Button>
            </div>
          </div>
          
          <div className="flex gap-4 items-center">
            <div>
              {qrDataUrl ? <img src={qrDataUrl} alt="qr-preview" width={120} height={120} /> : <div className="text-sm text-gray-500">No QR</div>}
            </div>
            <div>
              <svg ref={svgRef} />
            </div>
          </div>

          <Input 
            label="Barcode (optional)" 
            placeholder="e.g., code128, UPC barcode value"
            value={String(form.barcode ?? '')} 
            onValueChange={(v) => setForm({ ...form, barcode: v })} 
            description="Either Barcode or QR Code required for scanning checkout"
          />
          
          <Input 
            label="QR Code (optional)" 
            placeholder="e.g., QR code content"
            value={String(form.qr ?? '')} 
            onValueChange={(v) => setForm({ ...form, qr: v })} 
            description="Either Barcode or QR Code required for scanning checkout"
          />

          {/* Asset-specific fields: O2 tanks, AEDs, Epipens */}
          {(form.assetCategory === 'O2' || form.isOxygen) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="Oxygen PSI (current)"
                type="number"
                value={String((form.oxygenPsi ?? '') as any)}
                onValueChange={(v) => setForm({ ...form, oxygenPsi: v ? Number(v) : undefined })}
                description="Measured PSI at last check"
              />
              <Input
                label="Max Oxygen PSI"
                type="number"
                value={String((form.maxOxygenPsi ?? '') as any)}
                onValueChange={(v) => setForm({ ...form, maxOxygenPsi: v ? Number(v) : undefined })}
              />
            </div>
          )}

          {form.assetCategory === 'AED' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Select label="Battery Status" selectedKeys={[String((form.assetChecks?.batteryStatus) ?? '')]} onChange={(e) => setForm({ ...form, assetChecks: { ...(form.assetChecks || {}), batteryStatus: e.target.value as any } })}>
                <SelectItem key="">Unknown</SelectItem>
                <SelectItem key="Good">Good</SelectItem>
                <SelectItem key="Low">Low</SelectItem>
              </Select>
              <div>
                <Input
                  label="Battery Expiration"
                  type="date"
                  value={form.batteryExpiration ? new Date(form.batteryExpiration).toISOString().slice(0,10) : ''}
                  onValueChange={(v) => setForm({ ...form, batteryExpiration: v ? new Date(v) : undefined })}
                />
                <Input
                  label="Pads Expiration"
                  type="date"
                  value={form.padExpiration ? new Date(form.padExpiration).toISOString().slice(0,10) : ''}
                  onValueChange={(v) => setForm({ ...form, padExpiration: v ? new Date(v) : undefined })}
                />
              </div>
            </div>
          )}

          {/* Epipen / consumable expiration (many meds) */}
          {form.category === 'Meds' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="Item Expiration Date"
                type="date"
                value={form.expirationDate ? new Date(form.expirationDate).toISOString().slice(0,10) : ''}
                onValueChange={(v) => setForm({ ...form, expirationDate: v ? new Date(v) : undefined })}
                description="Set for individual consumable items (e.g., EpiPen)"
              />
            </div>
          )}

          {/* External Barcode Assignment Section */}
          <div className="border-t pt-4 mt-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">External Asset Tag</h4>
              {initial?.id && (
                <Button
                  size="sm"
                  color="secondary"
                  variant="flat"
                  onPress={() => setShowScanner(true)}
                >
                  Scan Tag
                </Button>
              )}
            </div>
            
            {(form as any).assignedBarcode && (
              <Chip color="success" variant="flat" className="mb-2">
                Current: {(form as any).assignedBarcode}
              </Chip>
            )}

            {scannedBarcode && (
              <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-2">
                <p className="text-sm font-medium text-blue-900 mb-1">Scanned: {scannedBarcode}</p>
                {initial?.id ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      color="primary"
                      onPress={() => handleAssignBarcode(false)}
                      isLoading={assigningBarcode}
                    >
                      Assign to Asset
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      onPress={() => setScannedBarcode('')}
                    >
                      Clear
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-blue-700">Save asset first to assign barcode</p>
                )}
              </div>
            )}

            {duplicateWarning?.show && (
              <div className="bg-yellow-50 border border-yellow-300 rounded p-3 mb-2">
                <p className="text-sm font-semibold text-yellow-900 mb-1">⚠️ Duplicate Barcode</p>
                <p className="text-sm text-yellow-800 mb-2">
                  This barcode is already assigned to{' '}
                  <strong>{duplicateWarning.duplicateItem?.name}</strong>
                  {duplicateWarning.duplicateItem?.serial && (
                    <span> (Serial: {duplicateWarning.duplicateItem.serial})</span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    color="warning"
                    onPress={handleDuplicateOverride}
                    isLoading={assigningBarcode}
                  >
                    Assign Anyway
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    onPress={handleCancelDuplicate}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {(form as any).barcodeHistory && (form as any).barcodeHistory.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-gray-600 mb-1">Assignment History:</p>
                <div className="space-y-1">
                  {(form as any).barcodeHistory.slice(-3).reverse().map((entry: any, idx: number) => (
                    <div key={idx} className="text-xs bg-gray-50 p-1 rounded">
                      <span className="font-mono">{entry.value}</span>
                      {' '}
                      <span className="text-gray-500">
                        by {entry.assignedBy?.name || 'Unknown'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-gray-500 mt-2">
              Scan purchased asset tags to assign unique tracking codes. Tags can be reassigned if they wear off.
            </p>
          </div>
          
          <Input label="Value (USD)" value={form.assetValue != null ? String(form.assetValue) : ''} onValueChange={(v) => setForm({ ...form, assetValue: v ? Number(v) : undefined })} />
          <div>
            <Select label="Current Location" selectedKeys={[String(form.currentLocation ?? (knownLocations[0] ?? ''))]} onChange={(e) => { setForm({ ...form, currentLocation: e.target.value }); setUseCustomLocation(e.target.value === 'Other'); }}>
              {(knownLocations.map(l => <SelectItem key={l}>{l}</SelectItem>) as any)}
              <SelectItem key="Other">Other</SelectItem>
            </Select>
            {useCustomLocation && <Input label="Custom Location" value={String(form.currentLocation ?? '')} onValueChange={(v) => setForm({ ...form, currentLocation: v })} />}
          </div>
          <Select label="Status" selectedKeys={[String(form.assetStatus ?? 'Ready')]} onChange={(e) => setForm({ ...form, assetStatus: e.target.value as any })}>
            <SelectItem key="Ready">Ready</SelectItem>
            <SelectItem key="In Use">In Use</SelectItem>
            <SelectItem key="Checked Out">Checked Out</SelectItem>
            <SelectItem key="Not Ready">Not Ready</SelectItem>
          </Select>
          <Textarea label="Notes" value={String((form as any).notes ?? '')} onValueChange={(v) => setForm({ ...form, notes: v } as any)} />
          
          {initial && initial.id && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Activity History</h4>
              {Array.isArray(initial.assets) && initial.assets.length > 0 && (
                <Select
                  label="Filter by Instance"
                  selectedKeys={historySerial ? [historySerial] : []}
                  onChange={(e) => setHistorySerial(e.target.value)}
                  className="mb-2"
                >
                  <SelectItem key="">All instances</SelectItem>
                  {(initial.assets.map(a => (
                    <SelectItem key={a.serial}>{a.assetTag || a.id || a.serial}</SelectItem>
                  )) as any)}
                </Select>
              )}
              <AssetHistory assetId={initial.id} maxRows={5} serialNumber={historySerial || undefined} />
            </div>
          )}
        </ModalBody>
          <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button color="primary" onPress={save} isLoading={saving}>{initial ? 'Save' : 'Add Asset'}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
    
    {/* Barcode Scanner Modal */}
    <BarcodeScanner
      isOpen={showScanner}
      onClose={() => setShowScanner(false)}
      onDetected={handleScanDetected}
    />
    </>
  );
}
