'use client';

/**
 * The arrangeable /stats dashboard canvas — a Tableau-style tiled grid with
 * drag-to-reorder and corner resize.
 *
 * Layout model (see tile-types.ts): a real absolute x/y grid is NOT used.
 * Tiles are laid out in document order (sorted by `y` then `x`) inside a
 * 12-column CSS grid with `grid-auto-flow: dense`; each tile only carries a
 * column/row *span* (`w`/`h`). Reordering just recomputes `y` from the new
 * document order (`x` stays 0) — the browser's dense auto-placement does the
 * actual visual packing. This is far more robust than tracking real
 * coordinates and is why no `react-grid-layout`-style engine is needed.
 */

import * as React from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TileFrame } from './tile-frame';
import { EmptyState } from './chart-kit';
import { GRID_COLUMNS, GRID_ROW_HEIGHT, GRID_GAP, type TileDef, type TileLayout } from './tile-types';
import type { StatsData, StatsFilterState, CrossFilter } from '@/app/lib/stats/shared';

const MIN_SPAN = 2;
const MAX_H = 20;

/** True at/above the `md` shell breakpoint (768px) — see CLAUDE.md "Breakpoints". */
function useIsMdUp(): boolean {
  const [isMdUp, setIsMdUp] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const update = () => setIsMdUp(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return isMdUp;
}

// ── Per-tile error boundary ─────────────────────────────────────────────────
// A class component is required for error boundaries; this is the one place
// in the file that isn't a function component. Keyed by the parent map so one
// crashing tile renders its own EmptyState instead of blanking the canvas.

interface TileErrorBoundaryProps {
  title: string;
  children: React.ReactNode;
}
interface TileErrorBoundaryState {
  hasError: boolean;
}

class TileErrorBoundary extends React.Component<TileErrorBoundaryProps, TileErrorBoundaryState> {
  constructor(props: TileErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): TileErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[DashboardCanvas] tile "${this.props.title}" crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return <EmptyState message="This tile failed to render" hint="Remove it from the dashboard, or reload the page." />;
    }
    return this.props.children;
  }
}

// ── Sortable tile wrapper ───────────────────────────────────────────────────

interface SortableTileProps {
  tile: TileLayout;
  def: TileDef;
  data: StatsData;
  filters: StatsFilterState;
  onCrossFilter: (f: CrossFilter | null) => void;
  dndEnabled: boolean;
  editable: boolean;
  unavailable: boolean;
  w: number;
  h: number;
  onRemove: () => void;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function SortableTile({
  tile,
  def,
  data,
  filters,
  onCrossFilter,
  dndEnabled,
  editable,
  unavailable,
  w,
  h,
  onRemove,
  onResizeStart,
}: SortableTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tile.tileId,
    disabled: !dndEnabled,
  });

  const style: React.CSSProperties = {
    gridColumn: `span ${w}`,
    gridRow: `span ${h}`,
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  const Component = def.component;

  return (
    <div ref={setNodeRef} style={style} className="min-w-0">
      <TileFrame
        title={def.title}
        description={def.description}
        onRemove={editable ? onRemove : undefined}
        onResizeStart={dndEnabled ? onResizeStart : undefined}
        dragHandleProps={dndEnabled ? { ...attributes, ...listeners } : undefined}
        isDragging={isDragging}
        unavailable={unavailable}
      >
        <TileErrorBoundary title={def.title}>
          <Component data={data} filters={filters} tileId={def.id} onCrossFilter={onCrossFilter} />
        </TileErrorBoundary>
      </TileFrame>
    </div>
  );
}

// ── DashboardCanvas ──────────────────────────────────────────────────────────

export interface DashboardCanvasProps {
  tiles: TileLayout[];
  registry: Map<string, TileDef>;
  data: StatsData;
  filters: StatsFilterState;
  onCrossFilter: (f: CrossFilter | null) => void;
  onLayoutChange: (next: TileLayout[]) => void;
  editable: boolean;
  unavailableDeps: string[];
}

export function DashboardCanvas({
  tiles,
  registry,
  data,
  filters,
  onCrossFilter,
  onLayoutChange,
  editable,
  unavailableDeps,
}: DashboardCanvasProps) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const isMdUp = useIsMdUp();
  // Drag + resize are desktop-only even in an editable dashboard — see the
  // "Responsive" requirement: below `md` the canvas is a single stacked
  // column and both interactions are disabled, not just visually hidden.
  const dndEnabled = editable && isMdUp;

  const [resizing, setResizing] = React.useState<{ tileId: string; w: number; h: number } | null>(null);

  // Saved layouts outlive tiles (a tile can be retired from the registry) —
  // silently drop unknown ids from what's rendered/dragged, but keep them in
  // the layout array we hand back on write so nothing is lost.
  const sortedTiles = React.useMemo(
    () => tiles.filter((t) => registry.has(t.tileId)).sort((a, b) => a.y - b.y || a.x - b.x),
    [tiles, registry]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sortedTiles.findIndex((t) => t.tileId === active.id);
      const newIndex = sortedTiles.findIndex((t) => t.tileId === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(sortedTiles, oldIndex, newIndex).map((t, i) => ({ ...t, y: i, x: 0 }));
      const untouched = tiles.filter((t) => !registry.has(t.tileId));
      onLayoutChange([...reordered, ...untouched]);
    },
    [sortedTiles, tiles, registry, onLayoutChange]
  );

  const startResize = React.useCallback(
    (tile: TileLayout, def: TileDef) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dndEnabled) return;
      e.preventDefault();
      e.stopPropagation();

      const target = e.currentTarget;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = tile.w;
      const startH = tile.h;
      const minW = Math.max(MIN_SPAN, def.minW ?? MIN_SPAN);
      const minH = Math.max(MIN_SPAN, def.minH ?? MIN_SPAN);

      const rect = gridRef.current?.getBoundingClientRect();
      const containerWidth = rect?.width ?? 1200;
      const colWidth = (containerWidth - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
      const colStep = colWidth + GRID_GAP;
      const rowStep = GRID_ROW_HEIGHT + GRID_GAP;

      let latestW = startW;
      let latestH = startH;

      target.setPointerCapture(pointerId);

      const handleMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const nextW = Math.min(GRID_COLUMNS, Math.max(minW, Math.round(startW + dx / colStep)));
        const nextH = Math.min(MAX_H, Math.max(minH, Math.round(startH + dy / rowStep)));
        latestW = nextW;
        latestH = nextH;
        setResizing({ tileId: tile.tileId, w: nextW, h: nextH });
      };

      const handleUp = () => {
        target.removeEventListener('pointermove', handleMove);
        target.removeEventListener('pointerup', handleUp);
        target.removeEventListener('pointercancel', handleUp);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // capture may already have been released by the browser
        }
        setResizing(null);
        if (latestW !== startW || latestH !== startH) {
          onLayoutChange(tiles.map((t) => (t.tileId === tile.tileId ? { ...t, w: latestW, h: latestH } : t)));
        }
      };

      target.addEventListener('pointermove', handleMove);
      target.addEventListener('pointerup', handleUp);
      target.addEventListener('pointercancel', handleUp);
    },
    [dndEnabled, tiles, onLayoutChange]
  );

  if (sortedTiles.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 md:h-full md:min-h-0">
        <EmptyState
          message="No tiles on this dashboard"
          hint={editable ? 'Add a tile from the catalog to get started.' : 'Ask an admin to add tiles to this dashboard.'}
        />
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sortedTiles.map((t) => t.tileId)} strategy={rectSortingStrategy}>
        <div
          ref={gridRef}
          className="flex flex-col gap-3 md:grid md:h-full md:min-h-0 md:content-start md:overflow-y-auto"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
            gridAutoRows: `${GRID_ROW_HEIGHT}px`,
            gridAutoFlow: 'dense',
            gap: `${GRID_GAP}px`,
          }}
        >
          {sortedTiles.map((tile) => {
            const def = registry.get(tile.tileId);
            if (!def) return null;
            const unavailable = def.dataDeps.some((dep) => unavailableDeps.includes(dep));
            const size = resizing && resizing.tileId === tile.tileId ? resizing : tile;

            return (
              <SortableTile
                key={tile.tileId}
                tile={tile}
                def={def}
                data={data}
                filters={filters}
                onCrossFilter={onCrossFilter}
                dndEnabled={dndEnabled}
                editable={editable}
                unavailable={unavailable}
                w={size.w}
                h={size.h}
                onRemove={() => onLayoutChange(tiles.filter((t) => t.tileId !== tile.tileId))}
                onResizeStart={startResize(tile, def)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
