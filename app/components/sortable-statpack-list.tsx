'use client';

import React, { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Input,
  Select,
  SelectItem,
  Button,
  Switch,
  Chip,
  Accordion,
  AccordionItem,
} from '@heroui/react';
import { GripVertical, X, Link2, ShieldCheck } from 'lucide-react';
import type { StatpackItem } from '@/app/types';

interface SortableStatpackItemProps {
  item: StatpackItem;
  index: number;
  onUpdate: (index: number, patch: Partial<StatpackItem>) => void;
  onRemove: (index: number) => void;
  onAttachAsset?: (index: number, itemName: string) => void;
  onEditAssetPolicy?: (assetInstanceId: string) => void;
}

function SortableStatpackItem({ item, index, onUpdate, onRemove, onAttachAsset, onEditAssetPolicy }: SortableStatpackItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.itemId || `item-${index}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const hasAsset = !!item.assetInstanceId || !!item.serialNumber;
  const rules = item.verificationRules || {};
  const hasRules = rules.requireSerial || rules.requireExpirationConfirmation || (rules.requireO2PsiMin !== undefined && rules.requireO2PsiMin > 0);

  const updateRule = (key: keyof typeof rules, value: any) => {
    onUpdate(index, {
      verificationRules: {
        ...rules,
        [key]: value,
      },
    });
  };

  return (
    <div style={style as React.CSSProperties} className="flex items-start gap-3 p-2 border-b border-default-200">
      <div ref={setNodeRef} className="flex items-center gap-2 cursor-move" {...attributes} {...listeners}>
        <GripVertical size={16} className="text-gray-400" />
      </div>

      <div className="flex-1">
        <div className="flex items-center gap-2">
          <Input
            value={item.itemDetails?.name ?? ''}
            onValueChange={(v) =>
              onUpdate(index, {
                itemDetails: { ...(item.itemDetails || {} as any), name: v },
              })
            }
          />
          {hasRules && (
            <Chip size="sm" color="primary" variant="flat" startContent={<ShieldCheck size={12} />}>
              Rules
            </Chip>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-default-500 mt-2">
          {item.itemDetails?.category && (
            <Chip size="sm" variant="flat" color="secondary">
              {item.itemDetails.category}
            </Chip>
          )}
          {hasAsset && (
            <div className="flex items-center gap-1 text-success-700">
              <Link2 size={12} />
              <span>
                {item.serialNumber || (item.assetInstanceId ? `Asset ${item.assetInstanceId.slice(0,8)}` : 'Linked')}
              </span>
            </div>
          )}
        </div>

        <div className="mt-2">
          <Accordion variant="light" className="px-0">
            <AccordionItem
              key="rules"
              aria-label="Verification Rules"
              title={
                <div className="flex items-center gap-2 text-xs font-medium">
                  <ShieldCheck size={14} />
                  <span>Verification Rules</span>
                </div>
              }
              classNames={{
                title: "text-xs",
                content: "pt-2 pb-0",
              }}
            >
              <div className="flex flex-col gap-3 pl-4 pr-2">
                <Switch
                  size="sm"
                  isSelected={rules.requireSerial || false}
                  onValueChange={(v) => updateRule('requireSerial', v)}
                >
                  <span className="text-xs">Require Serial Scan</span>
                </Switch>

                <Switch
                  size="sm"
                  isSelected={rules.requireExpirationConfirmation || false}
                  onValueChange={(v) => updateRule('requireExpirationConfirmation', v)}
                >
                  <span className="text-xs">Require Expiration Check</span>
                </Switch>

                <div className="flex items-center gap-2">
                  <span className="text-xs whitespace-nowrap">Min O₂ PSI:</span>
                  <Input
                    type="number"
                    size="sm"
                    className="w-24"
                    value={String(rules.requireO2PsiMin ?? '')}
                    onValueChange={(v) => updateRule('requireO2PsiMin', v ? Number(v) : undefined)}
                    placeholder="e.g., 1800"
                  />
                </div>

                <Switch
                  size="sm"
                  isSelected={rules.advisoryOnly || false}
                  onValueChange={(v) => updateRule('advisoryOnly', v)}
                >
                  <span className="text-xs">Advisory Only (Non-blocking)</span>
                </Switch>
              </div>
            </AccordionItem>
          </Accordion>
        </div>
      </div>

      <div className="w-40 flex flex-col gap-2 items-end">
        <Input
          className="w-24"
          type="number"
          value={String(item.requiredQuantity ?? 0)}
          onValueChange={(v) => onUpdate(index, { requiredQuantity: Number(v) || 0 })}
        />

        <Select
          className="min-w-[120px]"
          selectedKeys={[String(item.pocket || 'main')]}
          onChange={(e) => onUpdate(index, { pocket: e.target.value as any })}
        >
          <SelectItem key="main">Main</SelectItem>
          <SelectItem key="front_aux">Front</SelectItem>
          <SelectItem key="side_left">Left</SelectItem>
          <SelectItem key="side_right">Right</SelectItem>
        </Select>

        <div className="flex gap-2 mt-2">
          {onAttachAsset && (
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color={hasAsset ? 'success' : 'primary'}
              onPress={() => onAttachAsset(index, item.itemDetails?.name || '')}
              title={hasAsset ? 'Update asset link' : 'Attach existing asset'}
            >
              <Link2 size={14} />
            </Button>
          )}
          {hasAsset && onEditAssetPolicy && item.assetInstanceId && (
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color="primary"
              onPress={() => onEditAssetPolicy(item.assetInstanceId as string)}
              title="Edit verification policy"
            >
              <ShieldCheck size={14} />
            </Button>
          )}
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="danger"
            onPress={() => onRemove(index)}
          >
            <X size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface SortableStatpackContentListProps {
  items: StatpackItem[];
  onReorder: (newItems: StatpackItem[]) => void;
  onUpdateItem: (index: number, patch: Partial<StatpackItem>) => void;
  onRemoveItem: (index: number) => void;
  onAttachAsset?: (index: number, itemName: string) => void;
  onEditAssetPolicy?: (assetInstanceId: string) => void;
}

export default function SortableStatpackContentList({
  items,
  onReorder,
  onUpdateItem,
  onRemoveItem,
  onAttachAsset,
  onEditAssetPolicy,
}: SortableStatpackContentListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item) => (item.itemId || `item-${items.indexOf(item)}`) === active.id);
      const newIndex = items.findIndex((item) => (item.itemId || `item-${items.indexOf(item)}`) === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newItems = arrayMove(items, oldIndex, newIndex);
        onReorder(newItems);
      }
    }
  };

  const itemIds = items.map((item, idx) => item.itemId || `item-${idx}`);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <Table aria-label="Sortable statpack contents">
          <TableHeader>
            <TableColumn> </TableColumn>
            <TableColumn>Item</TableColumn>
            <TableColumn>Quantity</TableColumn>
            <TableColumn>Pocket</TableColumn>
            <TableColumn>Actions</TableColumn>
          </TableHeader>
          <TableBody>
            {items.map((item, idx) => (
              <SortableStatpackItem
                key={item.itemId || `item-${idx}`}
                item={item}
                index={idx}
                onUpdate={onUpdateItem}
                onRemove={onRemoveItem}
                      onAttachAsset={onAttachAsset}
                      onEditAssetPolicy={onEditAssetPolicy}
              />
            ))}
          </TableBody>
        </Table>
      </SortableContext>
    </DndContext>
  );
}
