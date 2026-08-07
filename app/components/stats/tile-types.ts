/**
 * Tile + dashboard contracts for /stats.  WAVE-0 GATE — see `app/lib/stats/shared.ts`.
 *
 * Types only, no runtime imports of tile components: the registry
 * (`tile-registry.tsx`) imports every tile, and every tile imports this file,
 * so keeping the two apart is what prevents a circular import.
 */

import type React from 'react';
import type { StatsData, StatsFilterState, CrossFilter } from '@/app/lib/stats/shared';

/** Which dashboard a tile belongs to. Also the per-dashboard role-gate key. */
export type DashboardKey = 'procurement' | 'consumption' | 'staffing' | 'calls';

export const DASHBOARD_KEYS: DashboardKey[] = ['procurement', 'consumption', 'staffing', 'calls'];

export const DASHBOARD_META: Record<
  DashboardKey,
  {
    label: string;
    blurb: string;
    /**
     * Role gate. `staffing` is intentionally wider than the rest: medops runs
     * events and rosters but must never see logistics surfaces (decisions.md
     * D-13), so it gets staffing only — never procurement or consumption.
     */
    gate: 'admin' | 'eventManager';
  }
> = {
  procurement: { label: 'Purchasing', blurb: 'Spend, vendors, order latency', gate: 'admin' },
  consumption: { label: 'Usage', blurb: 'Burn rate, days of cover, waste', gate: 'admin' },
  staffing: { label: 'Staffing', blurb: 'Coverage, attendance, hours', gate: 'eventManager' },
  calls: { label: 'Calls', blurb: 'Incident volume and response times', gate: 'eventManager' },
};

/**
 * Props every tile component receives.
 *
 * A tile is a pure function of (data, filters) → chart. It must NOT fetch, and
 * must NOT hold cross-tile state; `onCrossFilter` is the only way it talks to
 * the rest of the dashboard.
 */
export interface TileProps {
  /** The full loaded bundle. Tiles select what they need; no tile refetches. */
  data: StatsData;
  /** Active date range + cross-filters. Apply via `passesCrossFilters(..., tileId)`. */
  filters: StatsFilterState;
  /** This tile's registry id — pass as `own` to `passesCrossFilters`. */
  tileId: string;
  /**
   * Emit a cross-filter (a mark was clicked). Passing null clears filters this
   * tile owns. Tiles that expose no clickable marks may ignore this.
   */
  onCrossFilter: (f: CrossFilter | null) => void;
}

export interface TileDef {
  id: string;
  title: string;
  /** One line shown in the tile catalog and as the tile's `title` tooltip. */
  description: string;
  dashboard: DashboardKey;
  component: React.ComponentType<TileProps>;
  /** Default grid footprint, in 12-column units / 40px row units. */
  defaultW: number;
  defaultH: number;
  minW?: number;
  minH?: number;
  /**
   * Collections this tile reads. Used to show an honest "no data yet" state
   * when a collection is empty, instead of a chart of zeroes.
   */
  dataDeps: (keyof StatsData)[];
}

/** One tile placed on a dashboard. Grid is 12 columns wide; `y`/`h` are row units. */
export interface TileLayout {
  tileId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardSpec {
  id: string;
  key: DashboardKey;
  name: string;
  tiles: TileLayout[];
  /** Unset for the org-published default; set for a user's personal copy. */
  ownerUid?: string;
  /** True for the org default everyone lands on. Only admin/QM may write one. */
  published?: boolean;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const GRID_COLUMNS = 12;
export const GRID_ROW_HEIGHT = 40;
export const GRID_GAP = 12;
