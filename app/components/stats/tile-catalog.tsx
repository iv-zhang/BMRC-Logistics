'use client';

import React, { useState } from 'react';
import { Plus, X, RotateCcw, Upload, ChevronDown } from 'lucide-react';
import type { TileDef, DashboardKey } from './tile-types';

interface TileCatalogProps {
  dashboard: DashboardKey;
  allTiles: TileDef[];
  activeTileIds: string[];
  onAdd: (tileId: string) => void;
  onRemove: (tileId: string) => void;
  onResetLayout: () => void;
  onPublish?: () => void;
  canPublish: boolean;
}

export default function TileCatalog({
  dashboard,
  allTiles,
  activeTileIds,
  onAdd,
  onRemove,
  onResetLayout,
  onPublish,
  canPublish,
}: TileCatalogProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const tilesForDashboard = allTiles.filter((t) => t.dashboard === dashboard);

  const content = (
    <div className="flex flex-col gap-3">
      {/* Tiles section */}
      <div className="bg-content1 border border-divider rounded-large p-3">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-3">
          Tiles
        </p>
        <div className="space-y-2">
          {tilesForDashboard.map((tile) => {
            const isActive = activeTileIds.includes(tile.id);
            return (
              <button
                key={tile.id}
                onClick={() => (isActive ? onRemove(tile.id) : onAdd(tile.id))}
                className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-medium transition-colors duration-150 text-left border ${
                  isActive
                    ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20 dark:border-primary/40'
                    : 'border-transparent hover:bg-content2 text-foreground'
                }`}
                title={tile.description}
              >
                {/* Icon / toggle */}
                <div className="flex-none mt-0.5">
                  {isActive ? (
                    <div className="w-4 h-4 rounded-sm bg-primary flex items-center justify-center flex-none">
                      <X size={12} className="text-white" />
                    </div>
                  ) : (
                    <div className="w-4 h-4 rounded-sm border border-foreground-400 flex items-center justify-center flex-none hover:border-primary hover:bg-primary-50/50">
                      <Plus size={12} className="text-foreground-400" />
                    </div>
                  )}
                </div>

                {/* Title and description */}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold leading-tight text-foreground">
                    {tile.title}
                  </div>
                  <div className="text-[11px] text-foreground-400 mt-0.5 leading-snug">
                    {tile.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Actions: Reset + Publish */}
      <div className="bg-content1 border border-divider rounded-large p-3 space-y-1.5 flex-none">
        <button
          onClick={onResetLayout}
          className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-primary py-1.5 px-2.5 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded-medium transition-colors duration-150"
        >
          <RotateCcw size={12} /> Reset layout
        </button>
        {canPublish && (
          <button
            onClick={onPublish}
            className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-primary py-1.5 px-2.5 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded-medium transition-colors duration-150"
          >
            <Upload size={12} /> Publish as org default
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop: fixed left rail */}
      <aside className="hidden md:flex md:w-64 md:flex-none md:flex-col md:gap-3">
        {content}
      </aside>

      {/* Mobile: collapsible disclosure */}
      <div className="md:hidden flex flex-col gap-3 mb-3">
        <button
          onClick={() => setMobileOpen((o) => !o)}
          className="w-full flex items-center gap-2 bg-content1 border border-divider rounded-large px-4 py-2.5 text-sm font-semibold text-foreground-600 dark:text-foreground-300"
        >
          Tile Catalog
          <ChevronDown
            size={16}
            className={`ml-auto text-foreground-400 transition-transform duration-200 ${
              mobileOpen ? 'rotate-180' : ''
            }`}
          />
        </button>
        {mobileOpen && <div className="flex flex-col gap-3">{content}</div>}
      </div>
    </>
  );
}
