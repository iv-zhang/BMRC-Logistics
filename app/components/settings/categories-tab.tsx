'use client';
import React from 'react';
import { Input, Button } from '@heroui/react';
import { Plus, Trash2, Info } from 'lucide-react';
import type { AssetCategoryDef, VerificationFieldDef } from '@/app/config/org-config';
import { newId } from './settings-utils';

// ---------------------------------------------------------------------------
// Item Categories — itemCategories: string[]
// ---------------------------------------------------------------------------

interface ItemCategoriesTabProps {
  itemCategories: string[];
  onChange: (itemCategories: string[]) => void;
}

export function ItemCategoriesTab({ itemCategories, onChange }: ItemCategoriesTabProps) {
  const updateAt = (idx: number, value: string) => {
    const next = [...itemCategories];
    next[idx] = value;
    onChange(next);
  };

  const removeAt = (idx: number) => {
    onChange(itemCategories.filter((_, i) => i !== idx));
  };

  const add = () => onChange([...itemCategories, 'New Category']);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 bg-warning-50 dark:bg-warning-950/20 border border-warning/20 rounded-large px-4 py-3">
        <Info size={16} className="text-warning flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          Renaming a category here updates new records and dropdowns, but won&apos;t relabel items already saved under the old name.
        </p>
      </div>

      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Item Categories</h2>
        <p className="text-sm text-foreground-500 mb-4">
          Categories used to classify consumable inventory (Airway, Trauma, PPE, etc.).
        </p>
        <div className="flex flex-col gap-2">
          {itemCategories.map((cat, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input size="sm" value={cat} onValueChange={(v) => updateAt(idx, v)} className="flex-1 max-w-sm" />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                onPress={() => removeAt(idx)}
                aria-label="Remove category"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {itemCategories.length === 0 && (
            <p className="text-xs text-foreground-400">No item categories yet.</p>
          )}
        </div>
        <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} className="mt-3" onPress={add}>
          Add category
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Families — itemFamilies: string[] (structured naming: family, variant)
// ---------------------------------------------------------------------------

interface ItemFamiliesTabProps {
  itemFamilies: string[];
  onChange: (next: string[]) => void;
}

export function ItemFamiliesTab({ itemFamilies, onChange }: ItemFamiliesTabProps) {
  const updateAt = (idx: number, value: string) => {
    const next = [...itemFamilies];
    next[idx] = value;
    onChange(next);
  };

  const removeAt = (idx: number) => {
    onChange(itemFamilies.filter((_, i) => i !== idx));
  };

  const add = () => onChange([...itemFamilies, 'New Family']);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 bg-warning-50 dark:bg-warning-950/20 border border-warning/20 rounded-large px-4 py-3">
        <Info size={16} className="text-warning flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          Unlike categories, renaming a family here REGENERATES the derived name (family + variant) on every item that uses it — this relabels already-saved records, not just new ones.
        </p>
      </div>

      <div className="bg-content1 border border-divider rounded-large p-5">
        <h2 className="text-base font-semibold text-foreground mb-1">Item Families</h2>
        <p className="text-sm text-foreground-500 mb-4">
          The controlled parent list for structured item names (e.g. &quot;Bandaids&quot;, &quot;Nitrile Gloves&quot;). An item&apos;s name is derived as &quot;Family, Variant&quot; — never typed by hand.
        </p>
        <div className="flex flex-col gap-2">
          {itemFamilies.map((fam, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input size="sm" value={fam} onValueChange={(v) => updateAt(idx, v)} className="flex-1 max-w-sm" />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                onPress={() => removeAt(idx)}
                aria-label="Remove family"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {itemFamilies.length === 0 && (
            <p className="text-xs text-foreground-400">No item families yet.</p>
          )}
        </div>
        <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} className="mt-3" onPress={add}>
          Add family
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asset Categories — assetCategories: AssetCategoryDef[]
// ---------------------------------------------------------------------------

interface AssetCategoriesTabProps {
  assetCategories: AssetCategoryDef[];
  verificationFields: Record<string, VerificationFieldDef>;
  onChange: (assetCategories: AssetCategoryDef[]) => void;
}

export function AssetCategoriesTab({ assetCategories, verificationFields, onChange }: AssetCategoriesTabProps) {
  const fields = Object.values(verificationFields);

  const updateCat = (id: string, patch: Partial<AssetCategoryDef>) => {
    onChange(assetCategories.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const toggleField = (id: string, fieldId: string) => {
    const cat = assetCategories.find((c) => c.id === id);
    if (!cat) return;
    const has = cat.defaultVerificationFields.includes(fieldId);
    updateCat(id, {
      defaultVerificationFields: has
        ? cat.defaultVerificationFields.filter((f) => f !== fieldId)
        : [...cat.defaultVerificationFields, fieldId],
    });
  };

  const removeCat = (id: string) => {
    if (!confirm('Remove this asset category? Existing assets keep their category label, but it will disappear from dropdowns.')) return;
    onChange(assetCategories.filter((c) => c.id !== id));
  };

  const addCat = () => {
    onChange([
      ...assetCategories,
      { id: newId('cat'), name: 'New Category', icon: '', defaultVerificationFields: [] },
    ]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 bg-warning-50 dark:bg-warning-950/20 border border-warning/20 rounded-large px-4 py-3">
        <Info size={16} className="text-warning flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          Renaming a category here updates new records and dropdowns, but won&apos;t relabel assets already saved under the old name.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {assetCategories.map((cat) => (
          <div key={cat.id} className="bg-content1 border border-divider rounded-large p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                <Input
                  label="Category name"
                  value={cat.name}
                  onValueChange={(v) => updateCat(cat.id, { name: v })}
                />
                <Input
                  label="Icon (optional)"
                  placeholder="e.g., HeartPulse"
                  description="A Lucide icon name."
                  value={cat.icon}
                  onValueChange={(v) => updateCat(cat.id, { icon: v })}
                />
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                className="flex-none mt-1"
                onPress={() => removeCat(cat.id)}
                aria-label="Remove asset category"
              >
                <Trash2 size={16} />
              </Button>
            </div>

            <div className="bg-content2 rounded-large p-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2.5">
                Verification checks that apply to this category
              </p>
              <div className="flex flex-wrap gap-2">
                {fields.map((f) => {
                  const active = cat.defaultVerificationFields.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => toggleField(cat.id, f.id)}
                      className={`text-xs font-semibold px-2.5 py-1.5 rounded-full border transition-colors duration-150 ${
                        active
                          ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                          : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button color="primary" startContent={<Plus size={16} />} onPress={addCat} className="self-start">
        Add asset category
      </Button>
    </div>
  );
}
