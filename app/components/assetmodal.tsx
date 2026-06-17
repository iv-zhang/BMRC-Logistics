'use client';
import React, { useEffect, useState, useRef } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db, auth } from '@/firebase';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Select, SelectItem, Textarea, Chip, Switch } from '@heroui/react';
import BarcodeScanner from './barcode-scanner';
import type { InventoryItem } from '@/app/types';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import AssetHistory from '@/app/components/asset-history';
import { exportLabelsToPDF, DEFAULT_TEMPLATE } from '@/app/lib/print';
import LabelCard from '@/app/components/label-card';
import ScannerInput from '@/app/components/scanner-input';
import { assignBarcode } from '@/app/lib/inventory';
import { ASSET_CATEGORIES_CONFIG, ITEM_CATEGORIES } from '@/app/config/org-config';

type ExpirationPrecision = 'day' | 'month';

function formatExpirationInput(date: Date | undefined, precision: ExpirationPrecision) {
  if (!date) return '';
  const normalized = new Date(date);
  const year = normalized.getUTCFullYear();
  const month = String(normalized.getUTCMonth() + 1).padStart(2, '0');
  if (precision === 'month') return `${year}/${month}`;
  const day = String(normalized.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function parseExpirationInput(rawValue: string, precision: ExpirationPrecision) {
  const value = rawValue.trim();
  if (!value) return undefined;

  const normalized = value.replace(/[-.]/g, '/');

  if (precision === 'month') {
    const match = normalized.match(/^(\d{4})\/(\d{1,2})$/) || normalized.match(/^(\d{1,2})\/(\d{4})$/);
    if (!match) return undefined;
    const year = Number(match[1].length === 4 ? match[1] : match[2]);
    const month = Number(match[1].length === 4 ? match[2] : match[1]);
    if (!year || !month || month < 1 || month > 12) return undefined;
    return new Date(Date.UTC(year, month - 1, 1));
  }

  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/) || normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const year = Number(match[1].length === 4 ? match[1] : match[3]);
  const month = Number(match[1].length === 4 ? match[2] : match[1]);
  const day = Number(match[1].length === 4 ? match[3] : match[2]);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }

  return parsed;
}

interface AssetModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (payload: Partial<InventoryItem>) => Promise<void> | void;
  onUpdate: (id: string, payload: Partial<InventoryItem>) => Promise<void> | void;
  initial?: InventoryItem | null;
}

export default function AssetModal({ isOpen, onOpenChange, onAdd, onUpdate, initial }: AssetModalProps) {
  const [form, setForm] = useState<Partial<InventoryItem>>({});
  const [expirationInput, setExpirationInput] = useState('');
  const [knownLocations, setKnownLocations] = useState<string[]>([]);
  const [useCustomLocation, setUseCustomLocation] = useState(false);
  const [statpacks, setStatpacks] = useState<Array<{ id: string; name: string }>>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historySerial, setHistorySerial] = useState<string>('');
  const [showTopScanner, setShowTopScanner] = useState(false);
  const [scannedTopCode, setScannedTopCode] = useState<string>('');
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
      // Normalize Firestore Timestamp fields to JS Date for form controls
      if (initial) {
        const norm: any = { ...initial };
        if ((initial as any).expirationDate && typeof (initial as any).expirationDate.toDate === 'function') {
          norm.expirationDate = (initial as any).expirationDate.toDate();
        }
        if ((initial as any).batteryExpiration && typeof (initial as any).batteryExpiration.toDate === 'function') {
          norm.batteryExpiration = (initial as any).batteryExpiration.toDate();
        }
        if ((initial as any).padExpiration && typeof (initial as any).padExpiration.toDate === 'function') {
          norm.padExpiration = (initial as any).padExpiration.toDate();
        }
        if (norm.assetCategory === 'Oxygen Tank') {
          norm.isOxygen = true;
        }
        setForm(norm);
        const inferredExpirationPrecision: ExpirationPrecision = norm.expirationPrecision ?? (
          norm.expirationDate instanceof Date && norm.expirationDate.getUTCDate() === 1 ? 'month' : 'day'
        );
        setExpirationInput(formatExpirationInput(norm.expirationDate as Date | undefined, inferredExpirationPrecision));
      } else {
        setForm({ name: '', isAsset: true, assetStatus: 'Ready' });
        setExpirationInput('');
      }
      setValidationError(null);
      setSaving(false);
      setHistorySerial('');
      setScannedTopCode('');
    }
  }, [isOpen, initial]);

  useEffect(() => {
    if (!isOpen) return;
    if (form.assetCategory === 'Oxygen Tank' && !form.isOxygen) {
      setForm((prev) => ({ ...prev, isOxygen: true }));
    }
  }, [form.assetCategory, form.isOxygen, form.maxOxygenPsi, form.oxygenPsi, form.verificationPolicy?.requireO2PsiMin, isOpen]);

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

  const handleCategoryChange = (category: string) => {
    setForm((prev) => {
      const next: Partial<InventoryItem> = { ...prev, assetCategory: category as any };
      if (category === 'Oxygen Tank') {
        next.isOxygen = true;
      } else {
        next.isOxygen = false;
        next.oxygenPsi = undefined;
        next.maxOxygenPsi = undefined;
        next.verificationPolicy = next.verificationPolicy
          ? { ...next.verificationPolicy, requireO2PsiMin: undefined }
          : next.verificationPolicy;
      }
      return next;
    });
  };

  const handleExpirationPrecisionChange = (precision: ExpirationPrecision) => {
    setForm((prev) => ({ ...prev, expirationPrecision: precision }));
    const parsedCurrentValue = parseExpirationInput(expirationInput, form.expirationPrecision ?? 'month');
    setExpirationInput(formatExpirationInput(parsedCurrentValue ?? (form.expirationDate as Date | undefined), precision));
  };

  const handleExpirationInputChange = (value: string) => {
    setExpirationInput(value);
    const precision = form.expirationPrecision ?? 'month';
    const parsed = parseExpirationInput(value, precision);
    setForm((prev) => ({ ...prev, expirationPrecision: precision, expirationDate: parsed }));
  };

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
      const expirationPrecision: ExpirationPrecision = payload.expirationPrecision ?? 'month';
      const parsedExpiration = parseExpirationInput(expirationInput, expirationPrecision);
      if (expirationInput.trim() && !parsedExpiration) {
        setValidationError(expirationPrecision === 'month'
          ? 'Enter expiration as YYYY/MM or MM/YYYY.'
          : 'Enter expiration as YYYY/MM/DD or MM/DD/YYYY.');
        setSaving(false);
        return;
      }
      payload.expirationPrecision = expirationInput.trim() ? expirationPrecision : undefined;
      payload.expirationDate = parsedExpiration;
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

  const handleTopScanDetected = async (code: string) => {
    setScannedTopCode(code);
    setShowTopScanner(false);
    // Simple behavior: populate the barcode field so user doesn't need to type an asset tag
    setForm((prev) => ({ ...prev, barcode: code } as any));
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
          {!initial && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="flat" color="secondary" onPress={() => setShowTopScanner(true)}>
                  Scan Existing Barcode
                </Button>
                {scannedTopCode ? <Chip color="primary" variant="flat">Scanned: {scannedTopCode}</Chip> : null}
              </div>
            </div>
          )}
          {validationError && (
            <div className="bg-red-50 border border-red-200 rounded p-2">
              <p className="text-red-700 text-sm">{validationError}</p>
            </div>
          )}
          
          <Input label="Name" value={String(form.name ?? '')} onValueChange={(v) => setForm({ ...form, name: v })} />
          <Select label="Category" selectedKeys={[String((form.assetCategory as any) ?? 'Generic')]} onChange={(e) => handleCategoryChange(e.target.value)}>
            <SelectItem key="Generic">Generic</SelectItem>
            {(() => {
              const seen = new Set<string>();
              return (
                <>
                  {ASSET_CATEGORIES_CONFIG.map((config) => {
                    const label = String(config.name || config.id || '');
                    if (seen.has(label)) return null;
                    seen.add(label);
                    return <SelectItem key={label}>{label}</SelectItem>;
                  })}
                  {ITEM_CATEGORIES.map((cat) => {
                    const label = String(cat);
                    if (seen.has(label)) return null;
                    seen.add(label);
                    return <SelectItem key={label}>{label}</SelectItem>;
                  })}
                </>
              );
            })()}
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

          {/* Verification Policy (per-asset) */}
          <div className="border-t pt-4 mt-2">
            <h4 className="text-sm font-semibold mb-2">Verification Policy</h4>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="text-sm">Require Serial on Checkout</div>
                <Switch size="sm" isSelected={!!form.verificationPolicy?.requireSerial} onValueChange={(v) => setForm({ ...form, verificationPolicy: { ...(form.verificationPolicy || {}), requireSerial: v } as any })} />
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm">Require Expiration Confirmation</div>
                <Switch size="sm" isSelected={!!form.verificationPolicy?.requireExpirationConfirmation} onValueChange={(v) => setForm({ ...form, verificationPolicy: { ...(form.verificationPolicy || {}), requireExpirationConfirmation: v } as any })} />
              </div>
              {form.assetCategory === 'Oxygen Tank' && (
                <div className="flex items-center gap-2">
                  <div className="text-sm flex-1">Minimum O₂ PSI (optional)</div>
                  <Input size="sm" type="number" className="w-32" value={String(form.verificationPolicy?.requireO2PsiMin ?? '')} onValueChange={(v) => setForm({ ...form, verificationPolicy: { ...(form.verificationPolicy || {}), requireO2PsiMin: v ? Number(v) : undefined } as any })} placeholder="e.g., 1800" />
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="text-sm">Advisory Only (non-blocking)</div>
                <Switch size="sm" isSelected={!!form.verificationPolicy?.advisoryOnly} onValueChange={(v) => setForm({ ...form, verificationPolicy: { ...(form.verificationPolicy || {}), advisoryOnly: v } as any })} />
              </div>
            </div>
          </div>

          {/* Asset-specific fields: O2 tanks, AEDs, Epipens */}
          {form.assetCategory === 'Oxygen Tank' && (
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

          {/* Expiration (optional) - available for any asset that expires */}
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] gap-3 items-start">
              <div>
                <Select
                  label="Expiration format"
                  labelPlacement="outside"
                  classNames={{ label: 'text-xs font-medium' }}
                  selectedKeys={[String(form.expirationPrecision ?? 'month')]}
                  onChange={(e) => handleExpirationPrecisionChange(e.target.value as ExpirationPrecision)}
                >
                  <SelectItem key="month">Year / Month</SelectItem>
                  <SelectItem key="day">Full date</SelectItem>
                </Select>
              </div>

              <Input
                label="Item expiration"
                labelPlacement="outside"
                classNames={{ label: 'text-xs font-medium' }}
                value={expirationInput}
                onValueChange={handleExpirationInputChange}
                onBlur={() => {
                  const precision = form.expirationPrecision ?? 'month';
                  const parsed = parseExpirationInput(expirationInput, precision);
                  if (!parsed && expirationInput.trim()) {
                    setValidationError(precision === 'month'
                      ? 'Enter expiration as YYYY/MM or MM/YYYY.'
                      : 'Enter expiration as YYYY/MM/DD or MM/DD/YYYY.');
                    return;
                  }
                  setValidationError(null);
                  setForm((prev) => ({ ...prev, expirationDate: parsed, expirationPrecision: precision }));
                }}
                placeholder={(form.expirationPrecision ?? 'month') === 'month' ? 'YYYY/MM' : 'YYYY/MM/DD'}
                inputMode="text"
                description={(form.expirationPrecision ?? 'month') === 'month' ? 'Type the month and year directly. Example: 2026/05' : 'Type the full date directly. Example: 2026/05/02'}
              />
            </div>
          </div>

          {/* External Barcode Assignment Section */}
          <div className="border-t pt-4 mt-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">External Asset Tag</h4>
              {initial?.id && !showScanner && (
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

            {/* Inline scanner — no separate modal */}
            {showScanner && (
              <div className="rounded-lg border border-secondary/20 p-3 mb-3">
                <ScannerInput
                  onScan={handleScanDetected}
                  placeholder="Scan or type barcode…"
                  label="Scan Asset Tag"
                  compact
                />
                <Button
                  size="sm"
                  variant="light"
                  className="mt-1"
                  onPress={() => setShowScanner(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
            
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
                  <div className="flex items-center gap-2">
                    <Chip color="primary" variant="flat" size="sm">Will be assigned on save</Chip>
                    <Button
                      size="sm"
                      variant="light"
                      onPress={() => { setScannedBarcode(''); setForm({ ...form, assignedBarcode: undefined } as any); }}
                    >
                      Clear
                    </Button>
                  </div>
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
          <BarcodeScanner isOpen={showTopScanner} onClose={() => setShowTopScanner(false)} onDetected={handleTopScanDetected} />
          <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button color="primary" onPress={save} isLoading={saving}>{initial ? 'Save' : 'Add Asset'}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
    </>
  );
}
