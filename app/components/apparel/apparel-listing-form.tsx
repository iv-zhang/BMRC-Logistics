'use client';

import React, { useEffect, useState } from 'react';
import { Button, Input, Select, SelectItem, Textarea } from '@heroui/react';
import { AlertTriangle, Shirt, X } from 'lucide-react';
import {
  createApparelListing, updateApparelListing,
  type ApparelActor, type CreateApparelListingInput, type UpdateApparelListingPatch,
} from '@/app/lib/apparel';
import PanelShell from '@/app/components/panel-shell';
import type { ApparelCategory, ApparelCondition, ApparelDisposition, ApparelItem } from '@/app/types';

export interface ApparelListingFormProps {
  isOpen: boolean;
  onClose: () => void;
  /** null = create mode (blank form). An existing item = edit mode (pre-filled). */
  item: ApparelItem | null;
  categories: ApparelCategory[];
  actor: ApparelActor;
  onSaved?: () => void;
}

const CONDITION_OPTIONS: { value: ApparelCondition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'worn', label: 'Worn' },
];

const DISPOSITION_OPTIONS: { value: ApparelDisposition; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'for_sale', label: 'For Sale' },
  { value: 'loaner', label: 'Loaner' },
];

interface FormState {
  categoryId: string;
  sizeLabel: string;
  condition: ApparelCondition;
  disposition: ApparelDisposition;
  price: string;
  description: string;
}

const BLANK_FORM: FormState = {
  categoryId: '',
  sizeLabel: '',
  condition: 'good',
  disposition: 'free',
  price: '',
  description: '',
};

function formFromItem(item: ApparelItem): FormState {
  return {
    categoryId: item.categoryId,
    sizeLabel: item.sizeLabel,
    condition: item.condition,
    disposition: item.disposition,
    price: item.price != null ? String(item.price) : '',
    description: item.description ?? '',
  };
}

export default function ApparelListingForm({ isOpen, onClose, item, categories, actor, onSaved }: ApparelListingFormProps) {
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = item != null;

  useEffect(() => {
    if (!isOpen) return;
    setForm(item ? formFromItem(item) : BLANK_FORM);
    setError('');
  }, [isOpen, item]);

  if (!isOpen) return null;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const sizeLabelTrimmed = form.sizeLabel.trim();
  const priceNum = form.price.trim() === '' ? undefined : Number(form.price);
  const priceInvalid = form.disposition === 'for_sale' && (priceNum == null || !Number.isFinite(priceNum) || priceNum < 0);
  const canSave = sizeLabelTrimmed.length > 0 && !priceInvalid && form.categoryId !== '';

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const descriptionTrimmed = form.description.trim() || undefined;
      const price = form.disposition === 'for_sale' ? priceNum : undefined;

      if (isEdit && item?.id) {
        const patch: UpdateApparelListingPatch = {};
        if (form.categoryId !== item.categoryId) patch.categoryId = form.categoryId;
        if (sizeLabelTrimmed !== item.sizeLabel) patch.sizeLabel = sizeLabelTrimmed;
        if (form.condition !== item.condition) patch.condition = form.condition;
        if (form.disposition !== item.disposition) patch.disposition = form.disposition;
        if (price !== item.price) patch.price = price;
        if (descriptionTrimmed !== item.description) patch.description = descriptionTrimmed;

        if (Object.keys(patch).length > 0) {
          await updateApparelListing(item.id, patch, actor);
        }
      } else {
        const input: CreateApparelListingInput = {
          categoryId: form.categoryId,
          sizeLabel: sizeLabelTrimmed,
          condition: form.condition,
          disposition: form.disposition,
          price,
          description: descriptionTrimmed,
        };
        await createApparelListing(input, actor);
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save this listing.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell isOpen={isOpen} onClose={onClose} ariaLabel={isEdit ? 'Edit listing' : 'Add listing'}>
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex-none">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-[38px] h-[38px] rounded-[11px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                <Shirt size={19} />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">
                  {isEdit ? 'Edit Listing' : 'Add Listing'}
                </div>
                {isEdit && item && (
                  <div className="text-xs text-foreground-500 mt-0.5 truncate">{item.sizeLabel}</div>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          {categories.length === 0 ? (
            <div className="text-xs text-foreground-500">
              No categories exist yet — create one from Manage Categories first.
            </div>
          ) : (
            <Select
              label="Category"
              selectedKeys={form.categoryId ? [form.categoryId] : []}
              onSelectionChange={(keys) => {
                const value = Array.from(keys)[0] as string | undefined;
                if (value) update('categoryId', value);
              }}
            >
              {categories.map((category) => (
                <SelectItem key={category.id}>{category.name}</SelectItem>
              ))}
            </Select>
          )}

          <Input
            label="Size"
            placeholder="e.g. Large, M, 10.5"
            value={form.sizeLabel}
            onValueChange={(v) => update('sizeLabel', v)}
            isRequired
          />

          <Select
            label="Condition"
            selectedKeys={[form.condition]}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0] as ApparelCondition | undefined;
              if (value) update('condition', value);
            }}
          >
            {CONDITION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value}>{opt.label}</SelectItem>
            ))}
          </Select>

          <Select
            label="Disposition"
            selectedKeys={[form.disposition]}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0] as ApparelDisposition | undefined;
              if (value) update('disposition', value);
            }}
          >
            {DISPOSITION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value}>{opt.label}</SelectItem>
            ))}
          </Select>

          {form.disposition === 'for_sale' && (
            <Input
              type="number"
              label="Price"
              placeholder="0.00"
              startContent={<span className="text-foreground-400 text-sm">$</span>}
              value={form.price}
              onValueChange={(v) => update('price', v)}
              isInvalid={priceInvalid}
              errorMessage={priceInvalid ? 'Enter a valid price for a for-sale item.' : undefined}
            />
          )}

          <Textarea
            label="Description (optional)"
            placeholder="Brand, color, fit notes…"
            minRows={3}
            value={form.description}
            onValueChange={(v) => update('description', v)}
          />

          {error && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
              <AlertTriangle size={12} className="flex-none" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex items-center justify-end gap-3 flex-none">
          <Button variant="bordered" onPress={onClose} isDisabled={saving}>Cancel</Button>
          <Button color="primary" isLoading={saving} isDisabled={!canSave} onPress={handleSave}>
            {isEdit ? 'Save changes' : 'Create listing'}
          </Button>
        </div>
    </PanelShell>
  );
}
