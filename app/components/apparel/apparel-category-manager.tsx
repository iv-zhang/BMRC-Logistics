'use client';

import React, { useMemo, useState } from 'react';
import { Button, Chip, Input } from '@heroui/react';
import { AlertTriangle, ArrowDown, ArrowUp, Shirt, X } from 'lucide-react';
import {
  archiveApparelCategory, countActiveApparelGarmentsInCategory,
  createApparelCategory, reactivateApparelCategory, swapApparelCategorySortOrder,
} from '@/app/lib/apparel-categories';
import type { ApparelActor } from '@/app/lib/apparel';
import PanelShell from '@/app/components/panel-shell';
import type { ApparelCategory } from '@/app/types';

export interface ApparelCategoryManagerProps {
  isOpen: boolean;
  onClose: () => void;
  categories: ApparelCategory[];
  actor: ApparelActor;
}

export default function ApparelCategoryManager({ isOpen, onClose, categories, actor }: ApparelCategoryManagerProps) {
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const sorted = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  );

  if (!isOpen) return null;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setError('');
    try {
      await createApparelCategory({ name }, actor);
      setNewName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create this category.');
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async (category: ApparelCategory, direction: 'up' | 'down') => {
    const index = sorted.findIndex((c) => c.id === category.id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    const neighbor = sorted[neighborIndex];
    if (!category.id || !neighbor?.id) return;
    setSaving(true);
    setError('');
    try {
      await swapApparelCategorySortOrder(category.id, neighbor.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder categories.');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (category: ApparelCategory) => {
    if (!category.id) return;
    setSaving(true);
    setError('');
    try {
      const count = await countActiveApparelGarmentsInCategory(category.id);
      if (!window.confirm(
        `Archive "${category.name}"? ${count} active garment(s) currently use this category — they will keep showing this category name, but it will no longer appear as a filter or in the "add listing" form.`,
      )) {
        return;
      }
      await archiveApparelCategory(category.id, actor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive this category.');
    } finally {
      setSaving(false);
    }
  };

  const handleReactivate = async (category: ApparelCategory) => {
    if (!category.id) return;
    setSaving(true);
    setError('');
    try {
      await reactivateApparelCategory(category.id, actor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reactivate this category.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell isOpen={isOpen} onClose={onClose} ariaLabel="Manage categories">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex-none">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-[38px] h-[38px] rounded-[11px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                <Shirt size={19} />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">
                  Manage Categories
                </div>
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
          <div className="flex items-end gap-2">
            <Input
              label="New category name"
              placeholder="e.g. Jackets"
              value={newName}
              onValueChange={setNewName}
              isDisabled={saving}
              className="flex-1"
            />
            <Button color="primary" isLoading={saving} isDisabled={!newName.trim()} onPress={handleCreate}>
              Add
            </Button>
          </div>

          {error && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
              <AlertTriangle size={12} className="flex-none" />
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {sorted.length === 0 ? (
              <p className="text-sm text-foreground-500">No categories yet.</p>
            ) : (
              sorted.map((category, index) => (
                <div
                  key={category.id}
                  className="flex items-center gap-3 border border-divider rounded-large px-3 py-2"
                >
                  <div className="flex flex-col flex-none">
                    <button
                      onClick={() => handleMove(category, 'up')}
                      disabled={saving || index === 0}
                      className="w-6 h-6 rounded-medium hover:bg-content2 text-foreground-400 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label="Move up"
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      onClick={() => handleMove(category, 'down')}
                      disabled={saving || index === sorted.length - 1}
                      className="w-6 h-6 rounded-medium hover:bg-content2 text-foreground-400 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label="Move down"
                    >
                      <ArrowDown size={14} />
                    </button>
                  </div>

                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground truncate">{category.name}</span>
                    <Chip size="sm" variant="flat" color={category.active ? 'success' : 'default'}>
                      {category.active ? 'Active' : 'Archived'}
                    </Chip>
                  </div>

                  {category.active ? (
                    <Button
                      size="sm"
                      variant="bordered"
                      color="danger"
                      isDisabled={saving}
                      onPress={() => handleArchive(category)}
                    >
                      Archive
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="bordered"
                      isDisabled={saving}
                      onPress={() => handleReactivate(category)}
                    >
                      Reactivate
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex items-center justify-end gap-3 flex-none">
          <Button variant="bordered" onPress={onClose} isDisabled={saving}>Close</Button>
        </div>
    </PanelShell>
  );
}
