'use client';

/**
 * The single catalog of every tile that can appear on a /stats dashboard.
 *
 * This is the integration seam between the tile groups (which own their own
 * components + metadata) and everything that consumes tiles — the canvas, the
 * catalog rail, and `DEFAULT_LAYOUTS` in `app/lib/dashboards.ts`.
 *
 * INVARIANT: every `tileId` referenced by `DEFAULT_LAYOUTS` must exist here.
 * A saved layout naming an unknown id is skipped silently by the canvas (saved
 * layouts outlive tiles, on purpose), which means a typo in a default layout
 * fails *quietly* — `assertDefaultLayoutsResolve()` below exists to turn that
 * into a visible console error in development.
 */

import { PROCUREMENT_TILES } from './tiles/procurement';
import { CONSUMPTION_TILES } from './tiles/consumption';
import { STAFFING_TILES } from './tiles/staffing';
import { DASHBOARD_META, type DashboardKey, type TileDef } from './tile-types';

/**
 * `calls` contributes no tiles yet — there is no call data in this system
 * until an ESO/NEMSIS export is imported (see app/lib/calls/nemsis-map.ts).
 * The dashboard still exists so the gap is visible rather than hidden.
 */
export const ALL_TILES: TileDef[] = [...PROCUREMENT_TILES, ...CONSUMPTION_TILES, ...STAFFING_TILES];

export const TILE_REGISTRY: Map<string, TileDef> = new Map(ALL_TILES.map((t) => [t.id, t]));

export function tilesForDashboard(key: DashboardKey): TileDef[] {
  return ALL_TILES.filter((t) => t.dashboard === key);
}

export function getTile(id: string): TileDef | undefined {
  return TILE_REGISTRY.get(id);
}

/** Dashboards that actually have tiles to show, in display order. */
export const DASHBOARD_ORDER: DashboardKey[] = ['consumption', 'procurement', 'staffing', 'calls'];

export function dashboardLabel(key: DashboardKey): string {
  return DASHBOARD_META[key].label;
}

/**
 * Dev-only guard: report any `DEFAULT_LAYOUTS` entry that names a tile the
 * registry doesn't have. Called once from the stats page. Deliberately a
 * console.error rather than a throw — a bad default layout should degrade to a
 * smaller dashboard, not a white screen.
 */
export function assertDefaultLayoutsResolve(
  layouts: Record<DashboardKey, { tileId: string }[]>
): string[] {
  const missing: string[] = [];
  for (const key of Object.keys(layouts) as DashboardKey[]) {
    for (const { tileId } of layouts[key]) {
      if (!TILE_REGISTRY.has(tileId)) missing.push(`${key} → ${tileId}`);
    }
  }
  if (missing.length && process.env.NODE_ENV !== 'production') {
    console.error(
      `[stats] DEFAULT_LAYOUTS references ${missing.length} unknown tile id(s); they will not render:\n  ` +
        missing.join('\n  ')
    );
  }
  return missing;
}
