'use client';
import React, { useEffect, useState, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Select, SelectItem, Textarea } from '@heroui/react';
import type { InventoryItem } from '@/app/types';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import AssetHistory from '@/app/components/asset-history';
import { exportLabelsToPDF, DEFAULT_TEMPLATE } from '@/app/lib/print';
import LabelCard from '@/app/components/label-card';

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
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setForm(initial ? { ...initial } : { name: '', isAsset: true, assetStatus: 'Ready' });
      setValidationError(null);
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
        spSnap.forEach(s => { const d = s.data() as any; if (d?.currentLocation) locSet.add(String(d.currentLocation)); });
        const invSnap = await getDocs(collection(db, 'inventory'));
        invSnap.forEach(s => { const d = s.data() as any; if (d?.currentLocation) locSet.add(String(d.currentLocation)); });
        const arr = Array.from(locSet).filter(Boolean);
        if (mounted) setKnownLocations(arr);
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
          // @ts-expect-error JsBarcode types are not fully typed
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
      // Ensure there is a barcode or QR; if not present, generate one on-the-fly
      let payload: Partial<InventoryItem> = { ...form } as Partial<InventoryItem>;
      if (!payload.barcode && !payload.qr) {
        const gen = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `asset_${Date.now()}`;
        payload = { ...payload, assetSerial: gen, assetTag: gen, barcode: gen, qr: gen } as Partial<InventoryItem>;
      }

      setValidationError(null);

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
    }
  };

  return (
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
              <AssetHistory assetId={initial.id} maxRows={5} />
            </div>
          )}
        </ModalBody>
          <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button color="primary" onPress={save}>{initial ? 'Save' : 'Add Asset'}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
