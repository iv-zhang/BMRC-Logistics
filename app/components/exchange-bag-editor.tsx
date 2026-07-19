'use client';

import React, { useEffect, useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Autocomplete, AutocompleteItem,
} from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import { saveExchangeBag } from '@/app/lib/exchange-bags';
import type { ExchangeBag, ExchangeBagLine, InventoryItem } from '@/app/types';

interface LineDraft {
  uid: string;
  itemId: string;
  qtyPerBag: string;
}

function makeBlankLine(): LineDraft {
  return { uid: crypto.randomUUID(), itemId: '', qtyPerBag: '1' };
}

interface ExchangeBagEditorProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  bag: ExchangeBag | null;
  items: InventoryItem[];
  categories: { id: string; name: string; shelfIds?: string[] }[];
  actor: { id?: string; name?: string };
  onSaved?: () => void;
}

export default function ExchangeBagEditor({
  isOpen, onOpenChange, bag, items, categories, actor, onSaved,
}: ExchangeBagEditorProps) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [parBags, setParBags] = useState('');
  const [fullCount, setFullCount] = useState('');
  const [emptyCount, setEmptyCount] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([makeBlankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName(bag?.name ?? '');
    setCategoryId(bag?.categoryId ?? '');
    setParBags(bag?.parBags != null ? String(bag.parBags) : '');
    setFullCount(String(bag?.fullCount ?? 0));
    setEmptyCount(String(bag?.emptyCount ?? 0));
    setLines(
      bag?.lines?.length
        ? bag.lines.map((l) => ({ uid: crypto.randomUUID(), itemId: l.itemId, qtyPerBag: String(l.qtyPerBag) }))
        : [makeBlankLine()]
    );
    setError('');
  }, [isOpen, bag]);

  const updateLine = (uid: string, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  };
  const removeLine = (uid: string) => {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.uid !== uid) : prev));
  };
  const addLine = () => setLines((prev) => [...prev, makeBlankLine()]);

  const itemName = (id: string) => items.find((it) => it.id === id)?.name ?? '';

  const handleSave = async () => {
    setError('');
    const trimmedName = name.trim();
    if (!trimmedName) { setError('Name is required'); return; }

    const filledLines = lines.filter((l) => l.itemId && Number(l.qtyPerBag) > 0);
    if (filledLines.length === 0) { setError('Add at least one item line'); return; }

    const bagLines: ExchangeBagLine[] = filledLines.map((l) => ({
      itemId: l.itemId,
      itemName: itemName(l.itemId) || 'Unknown item',
      qtyPerBag: Math.max(1, Math.floor(Number(l.qtyPerBag))),
    }));

    setSaving(true);
    try {
      await saveExchangeBag(
        {
          id: bag?.id,
          name: trimmedName,
          categoryId: categoryId || undefined,
          parBags: parBags.trim() === '' ? undefined : Number(parBags),
          lines: bagLines,
          fullCount: Number.isFinite(Number(fullCount)) ? Math.max(0, Math.floor(Number(fullCount))) : 0,
          emptyCount: Number.isFinite(Number(emptyCount)) ? Math.max(0, Math.floor(Number(emptyCount))) : 0,
        },
        actor,
      );
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save exchange bag');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>{bag ? 'Edit exchange bag' : 'New exchange bag'}</span>
            <span className="text-xs font-normal text-foreground-400">
              Pre-stocked multi-SKU bag — grab full, drop empty
            </span>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <Input label="Bag name" placeholder="e.g. Bandaid Bag" value={name} onValueChange={setName} autoFocus />

            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Category (optional)"
                selectedKeys={categoryId ? [categoryId] : []}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories.map((c) => (
                  <SelectItem key={c.id}>{c.name}</SelectItem>
                ))}
              </Select>
              <Input
                label="Par (full bags)"
                type="number"
                value={parBags}
                onValueChange={setParBags}
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">Contents</span>
                <Button size="sm" variant="flat" startContent={<Plus size={13} />} onPress={addLine}>
                  Add item
                </Button>
              </div>
              {lines.map((line) => (
                <div key={line.uid} className="flex items-center gap-2">
                  <Autocomplete
                    aria-label="Item"
                    placeholder="Search item…"
                    className="flex-1"
                    selectedKey={line.itemId || null}
                    onSelectionChange={(key) => updateLine(line.uid, { itemId: key ? String(key) : '' })}
                    defaultItems={items}
                  >
                    {(it) => <AutocompleteItem key={it.id} textValue={it.name}>{it.name}</AutocompleteItem>}
                  </Autocomplete>
                  <Input
                    aria-label="Qty per bag"
                    type="number"
                    placeholder="Qty"
                    className="w-24 flex-none"
                    value={line.qtyPerBag}
                    onValueChange={(v) => updateLine(line.uid, { qtyPerBag: v })}
                  />
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    color="danger"
                    aria-label="Remove line"
                    isDisabled={lines.length === 1}
                    onPress={() => removeLine(line.uid)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-divider">
              <Input
                label="Full bags (admin correction)"
                type="number"
                value={fullCount}
                onValueChange={setFullCount}
                description="Bags currently staged full"
              />
              <Input
                label="Empty bags (admin correction)"
                type="number"
                value={emptyCount}
                onValueChange={setEmptyCount}
                description="Bags awaiting refill"
              />
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button color="primary" isLoading={saving} onPress={handleSave}>Save</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
