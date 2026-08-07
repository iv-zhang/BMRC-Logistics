'use client';

/**
 * Card chrome every dashboard tile renders inside. Owns no data logic —
 * `dashboard-canvas.tsx` is the only caller, wiring drag/resize/remove.
 *
 * See CLAUDE.md "Card-list expandable pattern" / detail-drawer surface rules:
 * one bordered surface (`content1`), a `content2` header stripe, no nested
 * borders. The body is the tile's only scroll region so a tall chart can
 * never push the grid cell taller than its allotted row span.
 */

import * as React from 'react';
import { GripVertical, MoreVertical, Trash2 } from 'lucide-react';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@heroui/react';
import { EmptyState } from './chart-kit';

export interface TileFrameProps {
  title: string;
  /** One-line description shown as the header's tooltip. */
  description?: string;
  children: React.ReactNode;
  onRemove?: () => void;
  /** Pointer-down handler wired to the bottom-right resize handle. */
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * @dnd-kit `attributes` + `listeners` for the drag handle, spread directly
   * onto the handle button. Omit (and the handle renders inert) when the
   * canvas is not in `editable` mode.
   */
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  /** When true, renders an EmptyState in place of `children` — a dataDep this tile needs failed to load. */
  unavailable?: boolean;
}

export function TileFrame({
  title,
  description,
  children,
  onRemove,
  onResizeStart,
  dragHandleProps,
  isDragging,
  unavailable,
}: TileFrameProps) {
  return (
    <div
      className={`relative flex h-full flex-col bg-content1 border border-divider rounded-large overflow-hidden ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      {/* Header stripe */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-content2 border-b border-divider flex-none"
        title={description}
      >
        {dragHandleProps ? (
          <button
            type="button"
            className="w-8 h-8 -ml-1 flex-none flex items-center justify-center rounded-medium text-foreground-400 hover:bg-content3 hover:text-foreground-600 cursor-grab active:cursor-grabbing transition-colors duration-150"
            aria-label={`Drag to reorder ${title}`}
            {...dragHandleProps}
          >
            <GripVertical size={15} />
          </button>
        ) : null}
        <span className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
          {title}
        </span>
        {onRemove ? (
          <Dropdown>
            <DropdownTrigger>
              <button
                type="button"
                className="w-8 h-8 flex-none flex items-center justify-center rounded-medium text-foreground-400 hover:bg-content3 hover:text-foreground-600 transition-colors duration-150"
                aria-label={`${title} tile options`}
              >
                <MoreVertical size={15} />
              </button>
            </DropdownTrigger>
            <DropdownMenu aria-label={`${title} tile actions`}>
              <DropdownItem
                key="remove"
                color="danger"
                className="text-danger"
                startContent={<Trash2 size={14} />}
                onPress={onRemove}
              >
                Remove
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        ) : null}
      </div>

      {/* Body — the tile's only scroll region */}
      <div className="flex-1 overflow-auto p-3 min-h-0">
        {unavailable ? (
          <EmptyState message="Data unavailable" hint="This tile's data couldn't be loaded — try refreshing." />
        ) : (
          children
        )}
      </div>

      {/* Resize handle */}
      {onResizeStart ? (
        <div
          onPointerDown={onResizeStart}
          className="absolute bottom-0 right-0 z-10 w-4 h-4 flex-none cursor-se-resize touch-none"
          role="presentation"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="absolute bottom-0.5 right-0.5 text-foreground-400" aria-hidden="true">
            <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
