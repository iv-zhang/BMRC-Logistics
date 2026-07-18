'use client';
import React, { useEffect, useState } from 'react';
import { Button, Autocomplete, AutocompleteItem } from '@heroui/react';
import { Receipt, X, Plus, Trash2, AlertTriangle, Minus } from 'lucide-react';
import type { ItemCategory } from '@/app/types';
import { logPurchase, purchaseTotal, type PurchaseActor, type PurchaseInput, type PurchaseLineInput } from '@/app/lib/purchases';
import { addVendor, seedVendorsIfMissing, subscribeVendors, type Vendor } from '@/app/lib/vendors';

interface PurchaseModalItem {
  id: string;
  name: string;
  category?: string;
  isAsset?: boolean;
}

interface PurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  actor: PurchaseActor;
  /** 'asset' when opened from /assets, else 'inventory'. Sets each new line's default kind. */
  defaultKind?: 'inventory' | 'asset';
  /** Existing inventory items for the "link to existing SKU" autocomplete. */
  items: PurchaseModalItem[];
  /** Called with the new purchase id after a successful logPurchase. */
  onLogged?: (purchaseId: string) => void;
}

const STEPS = ['Order', 'Line Items', 'Costs & Review'];

const CATEGORIES: ItemCategory[] = [
  'Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other',
];

const UNIT_OPTIONS = [
  { value: 'box', label: 'Box' },
  { value: 'bag', label: 'Bag' },
  { value: 'case', label: 'Case' },
  { value: 'each', label: 'Each' },
];

interface LineFormState {
  uid: string;
  kind: 'inventory' | 'asset';
  mode: 'existing' | 'new';
  linkedInventoryId: string;
  itemName: string;
  category: string;
  itemNumber: string;
  orderedQty: string;
  unit: string;
  unitsPerPackage: string;
  lineCost: string;
}

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function makeBlankLine(kind: 'inventory' | 'asset'): LineFormState {
  return {
    uid: crypto.randomUUID(),
    kind,
    mode: 'existing',
    linkedInventoryId: '',
    itemName: '',
    category: 'Other',
    itemNumber: '',
    orderedQty: '1',
    unit: 'box',
    unitsPerPackage: '',
    lineCost: '',
  };
}

function hasValidLine(lines: LineFormState[]): boolean {
  return lines.some(
    l => (l.mode === 'existing' ? l.linkedInventoryId : l.itemName.trim()) && Number(l.orderedQty) > 0
  );
}

export default function PurchaseModal({
  isOpen,
  onClose,
  actor,
  defaultKind = 'inventory',
  items,
  onLogged,
}: PurchaseModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [vendor, setVendor] = useState('');
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [orderDate, setOrderDate] = useState(todayStr());
  const [poNumber, setPoNumber] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [lines, setLines] = useState<LineFormState[]>([makeBlankLine(defaultKind)]);
  const [subtotal, setSubtotal] = useState('');
  const [shipping, setShipping] = useState('');
  const [tax, setTax] = useState('');
  const [discount, setDiscount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset state whenever the modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      setVendor('');
      setOrderDate(todayStr());
      setPoNumber('');
      setInvoiceRef('');
      setLines([makeBlankLine(defaultKind)]);
      setSubtotal('');
      setShipping('');
      setTax('');
      setDiscount('');
      setSaving(false);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load the vendor list — seed defaults once, then subscribe live.
  useEffect(() => {
    if (!isOpen) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    seedVendorsIfMissing().then(() => {
      if (cancelled) return;
      unsub = subscribeVendors(setVendors);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function updateLine(uid: string, patch: Partial<LineFormState>) {
    setLines(prev => prev.map(l => (l.uid === uid ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines(prev => [...prev, makeBlankLine(defaultKind)]);
  }

  function removeLine(uid: string) {
    setLines(prev => (prev.length > 1 ? prev.filter(l => l.uid !== uid) : prev));
  }

  const lineCostSum = lines.reduce((sum, l) => sum + (Number(l.lineCost) || 0), 0);

  const total = purchaseTotal({
    subtotal: Number(subtotal) || 0,
    shipping: Number(shipping) || 0,
    tax: Number(tax) || 0,
    discount: Number(discount) || 0,
  });

  function validate(): string | null {
    if (!vendor.trim()) return 'Vendor is required.';
    if (!hasValidLine(lines)) return 'Add at least one line item with a name (or linked SKU) and a quantity.';
    return null;
  }

  function handleNext() {
    if (currentStep === 0) {
      if (!vendor.trim()) {
        setError('Vendor is required.');
        return;
      }
      setError('');
      setCurrentStep(1);
    } else if (currentStep === 1) {
      if (!hasValidLine(lines)) {
        setError('Add at least one line item with a name (or linked SKU) and a quantity.');
        return;
      }
      setError('');
      setCurrentStep(2);
    } else {
      handleSubmit();
    }
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setSaving(true);
    try {
      const validLines = lines.filter(
        l => (l.mode === 'existing' ? l.linkedInventoryId : l.itemName.trim()) && Number(l.orderedQty) > 0
      );
      const lineInputs: PurchaseLineInput[] = validLines.map(l => ({
        kind: l.kind,
        itemName: l.itemName.trim(),
        linkedInventoryId: l.mode === 'existing' ? l.linkedInventoryId : undefined,
        itemNumber: l.itemNumber.trim() || undefined,
        category: l.category || undefined,
        orderedQty: Number(l.orderedQty),
        unit: l.unit || undefined,
        unitsPerPackage: l.unitsPerPackage ? Number(l.unitsPerPackage) : undefined,
        lineCost: l.lineCost ? Number(l.lineCost) : undefined,
      }));

      const input: PurchaseInput = {
        vendor: vendor.trim(),
        orderDate: new Date(orderDate),
        poNumber: poNumber.trim() || undefined,
        invoiceRef: invoiceRef.trim() || undefined,
        subtotal: subtotal ? Number(subtotal) : undefined,
        shipping: shipping ? Number(shipping) : undefined,
        tax: tax ? Number(tax) : undefined,
        discount: discount ? Number(discount) : undefined,
        lines: lineInputs,
      };

      const trimmedVendor = vendor.trim();
      const vendorExists = vendors.some(v => v.name.toLowerCase() === trimmedVendor.toLowerCase());
      if (!vendorExists) {
        await addVendor(trimmedVendor);
      }

      const id = await logPurchase(input, actor);
      onLogged?.(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to log purchase.');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'border border-divider rounded-[10px] px-3 py-[10px] font-[inherit] text-[13.5px] outline-none bg-content1 text-foreground focus:border-primary w-full';
  const labelCls = 'text-xs font-bold text-foreground-500 mb-1.5 block';
  const stepperMinusCls = 'w-[34px] h-[34px] rounded-[8px] bg-content3 text-foreground-500 flex items-center justify-center hover:bg-divider transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const stepperPlusCls = 'w-[34px] h-[34px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center hover:opacity-80 transition-opacity';
  const stepperInputCls = 'flex-1 text-center font-mono text-lg font-semibold text-foreground border-none outline-none bg-transparent';

  const validLinesForReview = lines.filter(
    l => (l.mode === 'existing' ? l.linkedInventoryId : l.itemName.trim()) && Number(l.orderedQty) > 0
  );

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px]" onClick={onClose} />

      {/* Modal */}
      <div
        className="fixed z-[61] w-[820px] max-w-[94vw] max-h-[90vh] bg-content1 rounded-[20px] shadow-[0_24px_70px_rgba(16,24,40,0.3)] flex flex-col overflow-hidden"
        style={{ top: '50%', left: '50%', animation: 'bmrcPop 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex items-center justify-between flex-none">
          <div className="flex items-center gap-3">
            <div className="w-[38px] h-[38px] rounded-[11px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center">
              <Receipt size={19} />
            </div>
            <div>
              <div className="font-bold text-[17px] tracking-tight text-foreground">Log Purchase</div>
              <div className="text-xs text-foreground-300 font-medium mt-0.5">Record an order — stock is added when it arrives</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[9px] bg-content3 text-foreground-400 flex items-center justify-center hover:bg-divider transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-divider/50 flex-none">
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

          {/* Step 1 — Order */}
          {currentStep === 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-[14px]">
              <div className="flex flex-col col-span-2 sm:col-span-1">
                <span className={labelCls}>Vendor</span>
                <Autocomplete
                  aria-label="Vendor"
                  placeholder="e.g. Bound Tree Medical"
                  allowsCustomValue
                  inputValue={vendor}
                  onInputChange={value => setVendor(value)}
                  onSelectionChange={key => {
                    if (key != null) setVendor(String(key));
                  }}
                  className="w-full"
                >
                  {vendors.map(v => (
                    <AutocompleteItem key={v.name} textValue={v.name}>
                      {v.name}
                    </AutocompleteItem>
                  ))}
                </Autocomplete>
              </div>
              <label className="flex flex-col">
                <span className={labelCls}>Order Date</span>
                <input
                  type="date"
                  value={orderDate}
                  onChange={e => setOrderDate(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col">
                <span className={labelCls}>PO #</span>
                <input
                  value={poNumber}
                  onChange={e => setPoNumber(e.target.value)}
                  placeholder="Optional"
                  className={`${inputCls} font-mono`}
                />
              </label>
              <label className="flex flex-col">
                <span className={labelCls}>Invoice Ref</span>
                <input
                  value={invoiceRef}
                  onChange={e => setInvoiceRef(e.target.value)}
                  placeholder="Optional"
                  className={`${inputCls} font-mono`}
                />
              </label>
            </div>
          )}

          {/* Step 2 — Line Items */}
          {currentStep === 1 && (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Line Items</p>

              <div className="flex flex-col gap-3">
                {lines.map(line => {
                  const filteredItems = items.filter(i => Boolean(i.isAsset) === (line.kind === 'asset'));
                  return (
                    <div key={line.uid} className="bg-content2 rounded-[14px] p-4 flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
                          {(['existing', 'new'] as const).map(m => (
                            <button
                              key={m}
                              type="button"
                              onClick={() =>
                                updateLine(line.uid, m === 'existing'
                                  ? { mode: 'existing' }
                                  : { mode: 'new', linkedInventoryId: '' })
                              }
                              className={`px-3 py-1 rounded-medium text-xs font-semibold transition-colors duration-150 ${
                                line.mode === m ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content3'
                              }`}
                            >
                              {m === 'existing' ? 'Existing item' : 'New item'}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(line.uid)}
                          disabled={lines.length === 1}
                          className="w-7 h-7 rounded-medium bg-content1 text-foreground-400 hover:bg-danger-50 hover:text-danger dark:hover:bg-danger-950/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors duration-150 flex-none"
                          aria-label="Remove line"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>

                      {line.mode === 'existing' ? (
                        <div className="flex flex-col">
                          <Autocomplete
                            size="sm"
                            label="Existing item"
                            placeholder="Search inventory…"
                            selectedKey={line.linkedInventoryId || null}
                            onSelectionChange={key => {
                              const found = filteredItems.find(i => i.id === key);
                              updateLine(line.uid, {
                                linkedInventoryId: key ? String(key) : '',
                                itemName: found?.name || '',
                                category: found?.category || 'Other',
                              });
                            }}
                            className="w-full"
                          >
                            {filteredItems.map(i => (
                              <AutocompleteItem key={i.id} textValue={i.name}>
                                {i.name}
                              </AutocompleteItem>
                            ))}
                          </Autocomplete>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <label className="flex flex-col">
                            <span className={labelCls}>Item name</span>
                            <input
                              value={line.itemName}
                              onChange={e => updateLine(line.uid, { itemName: e.target.value })}
                              placeholder="e.g. Nitrile Gloves"
                              className={inputCls}
                            />
                          </label>
                          <label className="flex flex-col">
                            <span className={labelCls}>Category</span>
                            <select
                              value={line.category}
                              onChange={e => updateLine(line.uid, { category: e.target.value })}
                              className={inputCls}
                            >
                              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </label>
                        </div>
                      )}

                      <label className="flex flex-col">
                        <span className={labelCls}>
                          Vendor Item #
                          <span className="font-normal normal-case text-foreground-400 ml-1.5">— the number you&apos;ll verify on arrival</span>
                        </span>
                        <input
                          value={line.itemNumber}
                          onChange={e => updateLine(line.uid, { itemNumber: e.target.value })}
                          placeholder="e.g. GLV-7782-M"
                          className={`${inputCls} font-mono`}
                        />
                      </label>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="flex flex-col">
                          <span className={labelCls}>Ordered Qty</span>
                          <div className="flex items-center gap-2 border border-divider rounded-[10px] p-[5px]">
                            <button
                              type="button"
                              onClick={() => {
                                const next = Math.max(1, (Number(line.orderedQty) || 1) - 1);
                                updateLine(line.uid, { orderedQty: String(next) });
                              }}
                              className={stepperMinusCls}
                              aria-label="Decrease ordered quantity"
                            >
                              <Minus size={15} />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={line.orderedQty}
                              onChange={e => updateLine(line.uid, { orderedQty: e.target.value })}
                              className={stepperInputCls}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const next = Math.max(1, (Number(line.orderedQty) || 0) + 1);
                                updateLine(line.uid, { orderedQty: String(next) });
                              }}
                              className={stepperPlusCls}
                              aria-label="Increase ordered quantity"
                            >
                              <Plus size={15} />
                            </button>
                          </div>
                        </div>
                        <label className="flex flex-col">
                          <span className={labelCls}>Unit</span>
                          <select
                            value={line.unit}
                            onChange={e => updateLine(line.uid, { unit: e.target.value })}
                            className={inputCls}
                          >
                            {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>
                        <div className="flex flex-col">
                          <span className={labelCls}>Units / Package</span>
                          <div className="flex items-center gap-2 border border-divider rounded-[10px] p-[5px]">
                            <button
                              type="button"
                              onClick={() => {
                                const cur = Number(line.unitsPerPackage) || 0;
                                updateLine(line.uid, { unitsPerPackage: cur <= 1 ? '' : String(cur - 1) });
                              }}
                              disabled={!line.unitsPerPackage}
                              className={stepperMinusCls}
                              aria-label="Decrease units per package"
                            >
                              <Minus size={15} />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={line.unitsPerPackage}
                              placeholder="—"
                              onChange={e => updateLine(line.uid, { unitsPerPackage: e.target.value })}
                              className={stepperInputCls}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const next = (Number(line.unitsPerPackage) || 0) + 1;
                                updateLine(line.uid, { unitsPerPackage: String(next) });
                              }}
                              className={stepperPlusCls}
                              aria-label="Increase units per package"
                            >
                              <Plus size={15} />
                            </button>
                          </div>
                        </div>
                        <label className="flex flex-col">
                          <span className={labelCls}>Line Cost $</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.lineCost}
                            onChange={e => updateLine(line.uid, { lineCost: e.target.value })}
                            placeholder="Optional"
                            className={`${inputCls} font-mono`}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              <Button
                variant="bordered"
                size="sm"
                className="self-start"
                startContent={<Plus size={14} />}
                onPress={addLine}
              >
                Add line
              </Button>
            </div>
          )}

          {/* Step 3 — Costs & Review */}
          {currentStep === 2 && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Cost Summary</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <label className="flex flex-col">
                    <span className={labelCls}>
                      Subtotal
                      {lineCostSum > 0 && (
                        <button
                          type="button"
                          onClick={() => setSubtotal(String(lineCostSum))}
                          className="font-normal normal-case text-primary ml-1.5 hover:underline"
                        >
                          use ${lineCostSum.toFixed(2)}
                        </button>
                      )}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={subtotal}
                      onChange={e => setSubtotal(e.target.value)}
                      placeholder="0.00"
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="flex flex-col">
                    <span className={labelCls}>Shipping</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={shipping}
                      onChange={e => setShipping(e.target.value)}
                      placeholder="0.00"
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="flex flex-col">
                    <span className={labelCls}>Tax</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={tax}
                      onChange={e => setTax(e.target.value)}
                      placeholder="0.00"
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                  <label className="flex flex-col">
                    <span className={labelCls}>Discount</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={discount}
                      onChange={e => setDiscount(e.target.value)}
                      placeholder="0.00"
                      className={`${inputCls} font-mono`}
                    />
                  </label>
                </div>

                <div className="bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-xl px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-primary">Total</span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-primary">
                    ${total.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-3 border-t border-divider pt-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Review — Item Worth</p>

                <div className="flex flex-col gap-2">
                  {validLinesForReview.map(l => {
                    const qty = Number(l.orderedQty) || 0;
                    const perPkg = Number(l.unitsPerPackage) || 1;
                    const lineCost = Number(l.lineCost) || 0;
                    const totalUnits = qty * perPkg;
                    const unitCost = lineCost && totalUnits ? lineCost / totalUnits : undefined;
                    return (
                      <div key={l.uid} className="bg-content2 rounded-[12px] px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-semibold text-foreground truncate">
                            {l.itemName.trim() || '(unnamed item)'}
                          </div>
                          <div className="text-xs text-foreground-400 font-medium mt-0.5 font-mono">
                            {qty} {l.unit || 'unit'}{qty !== 1 ? 's' : ''} × {perPkg} = {totalUnits} units
                          </div>
                        </div>
                        <div className="text-right flex-none">
                          <div className="font-mono text-sm font-semibold text-foreground">
                            {unitCost !== undefined ? `$${unitCost.toFixed(2)}/unit` : '—'}
                          </div>
                          <div className="font-mono text-xs text-foreground-400 mt-0.5">
                            {lineCost ? `$${lineCost.toFixed(2)} line` : 'no cost entered'}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-xl px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-success">Total purchase value</span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-success">
                    ${lineCostSum.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-950/20 border border-danger/30 rounded-large px-4 py-3 mt-4">
              <AlertTriangle size={15} className="text-danger flex-none" />
              <span className="text-xs font-semibold text-danger">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex items-center justify-between flex-none">
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
              {currentStep < 2 ? 'Continue' : 'Log Purchase'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
