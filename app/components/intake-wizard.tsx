'use client';
import React, { useState, useEffect } from 'react';
import { Button } from '@heroui/react';
import { Package, X, ScanBarcode, CheckCircle, Minus, Plus } from 'lucide-react';
import type { ItemCategory, InventoryBatch, BatchStatus } from '@/app/types';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { deriveItemName } from '@/app/lib/item-naming';

interface IntakeWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEPS = ['Identify', 'Quantity & Batch', 'Review'];

const CATEGORIES: ItemCategory[] = [
  'Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other',
];

const DEFAULT_FORM = {
  barcode: '',
  family: '',
  variantLabel: '',
  category: 'PPE' as ItemCategory,
  manufacturer: '',
  location: '',
  unit: 'Box',
  perUnit: 1,
  qty: 1,
  lotNumber: '',
  expirationDate: '',
};

export default function IntakeWizard({ isOpen, onClose }: IntakeWizardProps) {
  const { itemFamilies } = useOrgConfig();
  const [currentStep, setCurrentStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...DEFAULT_FORM });

  // `name` is DERIVED, never typed by hand — see app/lib/item-naming.ts.
  const derivedName = deriveItemName(form.family, form.variantLabel);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      setForm({ ...DEFAULT_FORM });
      setSaving(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  function set<K extends keyof typeof DEFAULT_FORM>(key: K, value: (typeof DEFAULT_FORM)[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function handleNext() {
    if (currentStep < 2) {
      setCurrentStep(s => s + 1);
    } else {
      handleConfirm();
    }
  }

  async function handleConfirm() {
    setSaving(true);
    try {
      const {
        collection, query, where, getDocs, addDoc, updateDoc,
        doc, arrayUnion, serverTimestamp,
      } = await import('firebase/firestore');
      const { db } = await import('@/firebase');

      const newBatch: Omit<InventoryBatch, 'id'> = {
        lotNumber: form.lotNumber || undefined,
        expirationDate: form.expirationDate ? new Date(form.expirationDate + '-01') : undefined,
        stock: form.qty * form.perUnit,
        bagCount: form.unit === 'Bag' ? form.qty : undefined,
        itemsPerBag: form.unit === 'Bag' ? form.perUnit : undefined,
        status: 'sealed' as BatchStatus,
        receivedAt: new Date(),
        supplier: form.manufacturer || undefined,
      };

      // Prefer matching on family + variantLabel (structured naming); fall
      // back to the legacy name-equality query when no family is set.
      const family = form.family.trim();
      const variantLabel = form.variantLabel.trim();
      let existingDoc: import('firebase/firestore').QueryDocumentSnapshot | undefined;
      if (family) {
        if (variantLabel) {
          const qref = query(
            collection(db, 'inventory'),
            where('family', '==', family),
            where('variantLabel', '==', variantLabel),
          );
          existingDoc = (await getDocs(qref)).docs[0];
        } else {
          const qref = query(collection(db, 'inventory'), where('family', '==', family));
          existingDoc = (await getDocs(qref)).docs.find((d) => !d.data().variantLabel);
        }
      } else {
        const qref = query(collection(db, 'inventory'), where('name', '==', derivedName));
        existingDoc = (await getDocs(qref)).docs[0];
      }

      let itemId: string;
      if (existingDoc) {
        itemId = existingDoc.id;
        await updateDoc(doc(db, 'inventory', existingDoc.id), {
          batches: arrayUnion({ ...newBatch, id: crypto.randomUUID() }),
          updatedAt: serverTimestamp(),
        });
      } else {
        const newDoc = await addDoc(collection(db, 'inventory'), {
          name: derivedName,
          family: family || null,
          variantLabel: variantLabel || null,
          category: form.category,
          barcode: form.barcode || null,
          location: form.location || 'HQ',
          reorderThreshold: 0,
          isOxygen: false,
          unopenedBoxes: 0,
          batches: [{ ...newBatch, id: crypto.randomUUID() }],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        itemId = newDoc.id;
      }

      await addDoc(collection(db, 'inventory_logs'), {
        itemId,
        itemName: derivedName,
        action: 'intake',
        quantity: form.qty * form.perUnit,
        supplier: form.manufacturer || null,
        lotNumber: form.lotNumber || null,
        notes: `${form.qty} ${form.unit}(s)${form.perUnit > 1 ? ` × ${form.perUnit} items each` : ''} received`,
        timestamp: serverTimestamp(),
      });

      onClose();
    } catch (e) {
      console.error('Intake error', e);
    } finally {
      setSaving(false);
    }
  }

  const totalItems = form.qty * form.perUnit;

  const inputCls = 'border border-divider rounded-[10px] px-3 py-[10px] font-[inherit] text-[13.5px] outline-none bg-content1 text-foreground focus:border-primary w-full';
  const labelCls = 'text-xs font-bold text-foreground-500 mb-1.5 block';

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px]" onClick={onClose} />

      {/* Modal */}
      <div
        className="fixed z-[61] w-[760px] max-w-[94vw] max-h-[90vh] bg-content1 rounded-[20px] shadow-[0_24px_70px_rgba(16,24,40,0.3)] flex flex-col overflow-hidden"
        style={{ top: '50%', left: '50%', animation: 'bmrcPop 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}
      >

        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-[38px] h-[38px] rounded-[11px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center">
              <Package size={19} />
            </div>
            <div>
              <div className="font-bold text-[17px] tracking-tight text-foreground">Stock Intake</div>
              <div className="text-xs text-foreground-300 font-medium mt-0.5">Receive new supply into inventory</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[9px] bg-content3 text-foreground-400 flex items-center justify-center hover:bg-divider transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-divider/50">
          {STEPS.map((step, i) => (
            <React.Fragment key={step}>
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center font-mono text-xs font-semibold border-[1.5px] ${
                  i < currentStep
                    ? 'bg-primary border-primary text-white'
                    : i === currentStep
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary text-primary'
                    : 'bg-content2 border-divider text-foreground-400'
                }`}>{i + 1}</div>
                <span className={`text-[12.5px] font-semibold ${i <= currentStep ? 'text-foreground' : 'text-foreground-400'}`}>{step}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="w-[26px] h-0.5 rounded-full bg-divider flex-none" />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">

          {/* Step 1 — Identify */}
          {currentStep === 0 && (
            <div className="grid grid-cols-2 gap-[14px]">
              {/* Barcode input — full width */}
              <div className="col-span-2">
                <label className={labelCls}>Barcode / NDC</label>
                <div className="flex items-center gap-3 bg-primary-50 dark:bg-primary-900/20 border border-dashed border-primary-200 dark:border-primary-800 rounded-xl px-4 py-3">
                  <ScanBarcode size={18} className="text-primary flex-none" />
                  <input
                    value={form.barcode}
                    onChange={e => set('barcode', e.target.value)}
                    placeholder="Scan or type barcode / NDC…"
                    className="flex-1 font-[inherit] text-[13.5px] outline-none bg-transparent text-foreground placeholder:text-primary/50"
                  />
                </div>
              </div>

              {/* Family */}
              <label className="flex flex-col">
                <span className={labelCls}>Family</span>
                <select
                  value={form.family}
                  onChange={e => set('family', e.target.value)}
                  className={inputCls}
                >
                  <option value="" disabled>Select a family…</option>
                  {(form.family && !itemFamilies.includes(form.family) ? [form.family, ...itemFamilies] : itemFamilies).map(
                    (fam) => <option key={fam} value={fam}>{fam}</option>,
                  )}
                </select>
              </label>

              {/* Variant */}
              <label className="flex flex-col">
                <span className={labelCls}>Variant (optional)</span>
                <input
                  value={form.variantLabel}
                  onChange={e => set('variantLabel', e.target.value)}
                  placeholder="e.g. Small, M, 28 Fr"
                  className={inputCls}
                />
              </label>

              {/* Derived name preview */}
              <p className="col-span-2 text-xs text-foreground-400 -mt-1.5">
                Name: <span className="font-semibold text-foreground-600">{derivedName || '—'}</span>
              </p>

              {/* Category */}
              <label className="flex flex-col">
                <span className={labelCls}>Category</span>
                <select
                  value={form.category}
                  onChange={e => set('category', e.target.value as ItemCategory)}
                  className={inputCls}
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>

              {/* Manufacturer */}
              <label className="flex flex-col">
                <span className={labelCls}>Manufacturer / Supplier</span>
                <input
                  value={form.manufacturer}
                  onChange={e => set('manufacturer', e.target.value)}
                  placeholder="e.g. Medline"
                  className={inputCls}
                />
              </label>

              {/* Storage location */}
              <label className="flex flex-col">
                <span className={labelCls}>Storage Location</span>
                <input
                  value={form.location}
                  onChange={e => set('location', e.target.value)}
                  placeholder="e.g. HQ · Back Room · Shelf A2"
                  className={inputCls}
                />
              </label>
            </div>
          )}

          {/* Step 2 — Quantity & Batch */}
          {currentStep === 1 && (
            <div className="grid grid-cols-2 gap-[14px]">
              {/* Unit of intake */}
              <label className="flex flex-col">
                <span className={labelCls}>Unit of Intake</span>
                <select
                  value={form.unit}
                  onChange={e => set('unit', e.target.value)}
                  className={inputCls}
                >
                  <option value="Box">Box</option>
                  <option value="Bag">Bag</option>
                  <option value="Case">Case</option>
                  <option value="Each">Each</option>
                </select>
              </label>

              {/* Items per unit */}
              <label className="flex flex-col">
                <span className={labelCls}>Items per {form.unit}</span>
                <input
                  type="number"
                  min={1}
                  value={form.perUnit}
                  onChange={e => set('perUnit', Math.max(1, parseInt(e.target.value) || 1))}
                  className={inputCls}
                />
              </label>

              {/* Quantity stepper */}
              <div className="flex flex-col">
                <span className={labelCls}>Quantity Received</span>
                <div className="flex items-center gap-2 border border-divider rounded-[10px] p-[5px]">
                  <button
                    type="button"
                    onClick={() => set('qty', Math.max(1, form.qty - 1))}
                    className="w-[34px] h-[34px] rounded-[8px] bg-content3 text-foreground-500 flex items-center justify-center hover:bg-divider transition-colors"
                  >
                    <Minus size={15} />
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={form.qty}
                    onChange={e => set('qty', Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-1 text-center font-mono text-lg font-semibold text-foreground border-none outline-none bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => set('qty', form.qty + 1)}
                    className="w-[34px] h-[34px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center hover:opacity-80 transition-opacity"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>

              {/* Total received */}
              <div className="flex flex-col">
                <span className={labelCls}>Total Received</span>
                <div className="bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-xl px-4 py-3 flex items-center justify-center h-full">
                  <span className="text-success font-mono text-2xl font-semibold">
                    {form.qty} × {form.perUnit} = {totalItems} items
                  </span>
                </div>
              </div>

              {/* Lot number */}
              <label className="flex flex-col">
                <span className={labelCls}>Lot Number</span>
                <input
                  value={form.lotNumber}
                  onChange={e => set('lotNumber', e.target.value)}
                  placeholder="e.g. GLV-7782"
                  className={`${inputCls} font-mono`}
                />
              </label>

              {/* Expiration date */}
              <label className="flex flex-col">
                <span className={labelCls}>Expiration Date</span>
                <input
                  type="month"
                  value={form.expirationDate}
                  onChange={e => set('expirationDate', e.target.value)}
                  className={inputCls}
                />
              </label>
            </div>
          )}

          {/* Step 3 — Review */}
          {currentStep === 2 && (
            <div className="flex flex-col gap-4">
              {/* Summary card */}
              <div className="bg-content2 rounded-[14px] px-5 py-4">
                <div className="font-semibold text-[16px] text-foreground mb-0.5">{derivedName || '(unnamed item)'}</div>
                <div className="text-xs text-foreground-400 font-medium">{form.category}{form.manufacturer ? ` · ${form.manufacturer}` : ''}</div>
                {form.barcode && (
                  <div className="font-mono text-xs text-foreground-400 mt-1">{form.barcode}</div>
                )}
              </div>

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-content2 rounded-[12px] px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">Location</div>
                  <div className="text-[13.5px] font-semibold text-foreground">{form.location || '—'}</div>
                </div>
                <div className="bg-content2 rounded-[12px] px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">Quantity</div>
                  <div className="font-mono text-[13.5px] font-semibold text-foreground">
                    {form.qty} {form.unit}{form.qty !== 1 ? 's' : ''} × {form.perUnit} = <span className="text-success">{totalItems} items</span>
                  </div>
                </div>
                <div className="bg-content2 rounded-[12px] px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">Lot #</div>
                  <div className="font-mono text-[13.5px] font-semibold text-foreground">{form.lotNumber || '—'}</div>
                </div>
                <div className="bg-content2 rounded-[12px] px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">Expires</div>
                  <div className="font-mono text-[13.5px] font-semibold text-foreground">{form.expirationDate || '—'}</div>
                </div>
              </div>

              {/* Confirmation note */}
              <div className="flex items-center gap-3 bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-xl px-4 py-3">
                <CheckCircle size={17} className="text-primary flex-none" />
                <span className="text-[12.5px] text-primary font-semibold">Will be logged to the audit trail and added to FIFO rotation for this item.</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex items-center justify-between">
          <Button
            variant="bordered"
            onPress={() => setCurrentStep(s => s - 1)}
            className={currentStep === 0 ? 'invisible' : ''}
          >
            Back
          </Button>
          <div className="flex items-center gap-3">
            <Button variant="light" className="text-foreground-400" onPress={onClose}>
              Cancel
            </Button>
            <Button color="primary" onPress={handleNext} isLoading={saving}>
              {currentStep < 2 ? 'Continue' : 'Confirm Intake'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
