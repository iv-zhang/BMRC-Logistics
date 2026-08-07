'use client';

/**
 * Statistics — a Tableau-style dashboard shell.
 *
 * Four dashboards (Usage / Purchasing / Staffing / Calls), each an arrangeable
 * grid of hand-written tiles from `tile-registry.tsx`. This page owns only
 * shell concerns: role gating, which datasets to load, filter + cross-filter
 * state, and layout persistence. It computes no metrics — every number comes
 * from a tile, which gets it from `app/lib/stats/*`. See decisions.md D-27.
 *
 * Layout rule (same as /inventory): on desktop this is a FIXED-HEIGHT app
 * shell — the page never scrolls, the canvas is the only scroll region, and
 * the header/filter shelf/tile rail stay pinned. Below `md` it reverts to one
 * unified page scroll with the rail in a disclosure, so every height and
 * overflow class here is `md:`-prefixed.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Spinner } from '@heroui/react';
import { RefreshCw, BarChart3 } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { isEventManagerRole } from '@/app/lib/events';
import { useStatsData } from '@/app/hooks/useStatsData';
import FilterShelf from '@/app/components/stats/filter-shelf';
import TileCatalog from '@/app/components/stats/tile-catalog';
import { DashboardCanvas } from '@/app/components/stats/dashboard-canvas';
import {
  ALL_TILES,
  TILE_REGISTRY,
  assertDefaultLayoutsResolve,
  tilesForDashboard,
} from '@/app/components/stats/tile-registry';
import {
  DASHBOARD_META,
  type DashboardKey,
  type TileLayout,
} from '@/app/components/stats/tile-types';
import {
  DEFAULT_LAYOUTS,
  subscribeDashboard,
  saveDashboardLayout,
  publishDashboardLayout,
  resetDashboardLayout,
} from '@/app/lib/dashboards';
import type { CrossFilter, DateRange, StatsData, StatsFilterState } from '@/app/lib/stats/shared';

type RangePreset = 'all' | 'ytd' | 'year' | '90d' | '30d' | '7d' | 'custom';

function presetToRange(preset: RangePreset, customStart: string, customEnd: string, now = new Date()): DateRange {
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'ytd':
      return { start: new Date(now.getFullYear(), 0, 1), end: now };
    case 'year':
      return { start: daysAgo(365), end: now };
    case '90d':
      return { start: daysAgo(90), end: now };
    case '30d':
      return { start: daysAgo(30), end: now };
    case '7d':
      return { start: daysAgo(7), end: now };
    case 'custom':
      return {
        start: customStart ? new Date(`${customStart}T00:00:00`) : null,
        end: customEnd ? new Date(`${customEnd}T23:59:59.999`) : null,
      };
  }
}

function rangeLabelFor(preset: RangePreset, customStart: string, customEnd: string): string {
  switch (preset) {
    case 'all':
      return 'All time';
    case 'ytd':
      return 'Year to date';
    case 'year':
      return 'Past year';
    case '90d':
      return 'Past 90 days';
    case '30d':
      return 'Past 30 days';
    case '7d':
      return 'Past 7 days';
    case 'custom':
      if (customStart && customEnd) return `${customStart} – ${customEnd}`;
      if (customStart) return `Since ${customStart}`;
      if (customEnd) return `Through ${customEnd}`;
      return 'Custom range';
  }
}

/**
 * Datasets each dashboard needs. Loading only what's on screen keeps us from
 * issuing reads that firestore.rules would deny anyway (medops on Staffing has
 * no business reading `inventory`), which in turn keeps the console clean of
 * permission errors that aren't bugs.
 */
const DASHBOARD_DEPS: Record<DashboardKey, (keyof StatsData)[]> = {
  consumption: ['statpackLogs', 'statpacks', 'inventory', 'restockReports', 'restockActions', 'medicationLogs'],
  procurement: ['purchases', 'buyList'],
  staffing: ['events', 'shiftRequests', 'users'],
  calls: [],
};

/** Old deep links (`?tab=statpacks|restock`) both land on the Usage dashboard. */
function tabParamToDashboard(v: string | null): DashboardKey | null {
  if (!v) return null;
  if (v === 'statpacks' || v === 'restock' || v === 'consumption') return 'consumption';
  if (v === 'procurement' || v === 'staffing' || v === 'calls') return v;
  return null;
}

export default function StatsPage() {
  const router = useRouter();
  const { role, effectiveUid, userData, loading: authLoading } = useUserRole();

  const isAdmin = role === 'admin' || role === 'quartermaster';
  const isEventManager = isEventManagerRole(role);

  /** Dashboards this role may see. medops gets staffing/calls only (D-13). */
  const visibleDashboards = useMemo(() => {
    const keys: DashboardKey[] = [];
    if (isAdmin) keys.push('consumption', 'procurement');
    if (isEventManager) keys.push('staffing', 'calls');
    return keys;
  }, [isAdmin, isEventManager]);

  const [dashboard, setDashboard] = useState<DashboardKey | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>('90d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [crossFilters, setCrossFilters] = useState<CrossFilter[]>([]);
  /**
   * Layout is stored WITH the dashboard it belongs to, so `layoutLoading` is
   * derived (`loadedLayout.key !== dashboard`) instead of being set at the top
   * of the subscribe effect. Without the key, switching dashboards would show
   * the previous one's tiles for a frame before the new layout arrived.
   */
  const [loadedLayout, setLoadedLayout] = useState<{ key: DashboardKey; tiles: TileLayout[] } | null>(null);

  // Resolve the initial dashboard from ?tab=, falling back to the first the
  // role can actually see. This must run in an effect rather than a lazy
  // initializer: the page is statically exported, so reading location during
  // the first render would make the client's HTML disagree with the
  // prerendered output and trip a hydration mismatch.
  useEffect(() => {
    if (!visibleDashboards.length) return;
    const fromUrl = tabParamToDashboard(new URLSearchParams(window.location.search).get('tab'));
    const next = fromUrl && visibleDashboards.includes(fromUrl) ? fromUrl : visibleDashboards[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the URL (an external system) post-hydration; see comment above.
    setDashboard((cur) => cur ?? next);
  }, [visibleDashboards]);

  // Dev guard: a default layout naming a tile the registry lacks renders
  // nothing, silently. Surface it once instead.
  useEffect(() => {
    assertDefaultLayoutsResolve(DEFAULT_LAYOUTS);
  }, []);

  const deps = useMemo(() => (dashboard ? DASHBOARD_DEPS[dashboard] : []), [dashboard]);
  const { data, loading: dataLoading, unavailable, refresh, lastLoadedAt } = useStatsData(
    deps,
    !!dashboard && !authLoading
  );

  // Layout subscription — re-subscribes when the dashboard or user changes.
  useEffect(() => {
    if (!dashboard) return;
    const unsub = subscribeDashboard(dashboard, effectiveUid, (spec) =>
      setLoadedLayout({ key: dashboard, tiles: spec.tiles })
    );
    return unsub;
  }, [dashboard, effectiveUid]);

  // Memoized so the array identity is stable across renders — the add/remove/
  // persist callbacks below close over it, and a fresh `[]` each render would
  // rebuild them (and re-render the canvas) on every keystroke elsewhere.
  const layout = useMemo(
    () => (loadedLayout?.key === dashboard ? loadedLayout.tiles : []),
    [loadedLayout, dashboard]
  );
  const layoutLoading = !dashboard || loadedLayout?.key !== dashboard;

  // Changing dashboards clears cross-filters: a vendor filter set on Purchasing
  // is meaningless on Staffing, and leaving it active would silently narrow
  // charts for a reason the user can no longer see.
  const selectDashboard = useCallback((next: DashboardKey) => {
    setDashboard(next);
    setCrossFilters([]);
    window.history.replaceState(null, '', `/stats?tab=${next}`);
  }, []);

  const range = useMemo(
    () => presetToRange(rangePreset, customStart, customEnd),
    [rangePreset, customStart, customEnd]
  );
  const filters: StatsFilterState = useMemo(
    () => ({ range, rangeLabel: rangeLabelFor(rangePreset, customStart, customEnd), crossFilters }),
    [range, rangePreset, customStart, customEnd, crossFilters]
  );

  /**
   * A new filter REPLACES any existing one on the same field — picking a second
   * vendor should swap, not AND two vendors into an empty result.
   *
   * `null` clears everything: a tile emits it when you re-click its selected
   * mark, and it carries no source id to be more surgical than that. Per-filter
   * removal is available on the filter shelf's chips.
   */
  const handleCrossFilter = useCallback((f: CrossFilter | null) => {
    setCrossFilters((cur) => {
      if (!f) return [];
      const others = cur.filter((c) => c.field !== f.field);
      const isSame = cur.some((c) => c.field === f.field && c.value === f.value);
      return isSame ? others : [...others, f];
    });
  }, []);

  const actor = useMemo(
    () => ({ uid: effectiveUid ?? '', name: userData?.fullName ?? 'Unknown' }),
    [effectiveUid, userData?.fullName]
  );

  const persistLayout = useCallback(
    (next: TileLayout[]) => {
      if (!dashboard) return;
      setLoadedLayout({ key: dashboard, tiles: next }); // optimistic — the grid must not lag the drag
      if (effectiveUid) void saveDashboardLayout(dashboard, effectiveUid, next, actor);
    },
    [dashboard, effectiveUid, actor]
  );

  const addTile = useCallback(
    (tileId: string) => {
      const def = TILE_REGISTRY.get(tileId);
      if (!def) return;
      const maxY = layout.reduce((m, t) => Math.max(m, t.y + t.h), 0);
      persistLayout([...layout, { tileId, x: 0, y: maxY, w: def.defaultW, h: def.defaultH }]);
    },
    [layout, persistLayout]
  );

  const removeTile = useCallback(
    (tileId: string) => persistLayout(layout.filter((t) => t.tileId !== tileId)),
    [layout, persistLayout]
  );

  const handleReset = useCallback(async () => {
    if (!dashboard || !effectiveUid) return;
    await resetDashboardLayout(dashboard, effectiveUid);
    setLoadedLayout({ key: dashboard, tiles: DEFAULT_LAYOUTS[dashboard] });
  }, [dashboard, effectiveUid]);

  const handlePublish = useCallback(() => {
    if (!dashboard) return;
    void publishDashboardLayout(dashboard, layout, actor);
  }, [dashboard, layout, actor]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!visibleDashboards.length) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <Card>
          <CardBody>
            <p className="text-danger">Access denied. Only admins, quartermasters, and medops can view statistics.</p>
            <Button color="primary" onPress={() => router.push('/dashboard')} className="mt-4">
              Go to Dashboard
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  const activeTileIds = layout.map((t) => t.tileId);
  const busy = dataLoading || layoutLoading || !dashboard;

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6 md:h-full md:flex md:flex-col md:min-h-0">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-4 flex-wrap flex-none">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Statistics</h1>
            <p className="text-sm text-foreground-500">
              {dashboard ? DASHBOARD_META[dashboard].blurb : ''}
              {lastLoadedAt && (
                <span className="text-foreground-400">
                  {' · '}updated {lastLoadedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
              {visibleDashboards.map((key) => (
                <button
                  key={key}
                  onClick={() => selectDashboard(key)}
                  className={`px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                    dashboard === key ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                  }`}
                >
                  {DASHBOARD_META[key].label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />} onPress={refresh}>
              Refresh
            </Button>
          </div>
        </div>

        {/* Filter shelf */}
        <div className="mb-4 flex-none">
          <FilterShelf
            filters={filters}
            rangePreset={rangePreset}
            customStart={customStart}
            customEnd={customEnd}
            onRangeChange={(p, s, e) => {
              setRangePreset(p);
              if (s !== undefined) setCustomStart(s);
              if (e !== undefined) setCustomEnd(e);
            }}
            onClearCrossFilter={(f) =>
              setCrossFilters((cur) => cur.filter((c) => !(c.field === f.field && c.value === f.value)))
            }
            onClearAll={() => setCrossFilters([])}
          />
        </div>

        {/* Rail + canvas */}
        {busy ? (
          <div className="flex items-center justify-center py-24 md:flex-1">
            <Spinner size="lg" color="primary" />
          </div>
        ) : dashboard === 'calls' ? (
          <CallsEmptyState />
        ) : (
          <div className="md:flex-1 md:min-h-0 md:grid md:grid-cols-[248px_1fr] md:gap-4">
            <aside className="mb-4 md:mb-0 md:min-h-0 md:overflow-hidden">
              <TileCatalog
                dashboard={dashboard!}
                allTiles={ALL_TILES}
                activeTileIds={activeTileIds}
                onAdd={addTile}
                onRemove={removeTile}
                onResetLayout={handleReset}
                onPublish={handlePublish}
                canPublish={isAdmin}
              />
            </aside>
            <DashboardCanvas
              tiles={layout}
              registry={TILE_REGISTRY}
              data={data}
              filters={filters}
              onCrossFilter={handleCrossFilter}
              onLayoutChange={persistLayout}
              editable
              unavailableDeps={unavailable as string[]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Calls dashboard exists before its data does. Showing this is deliberate:
 * an honest "not connected yet" reads better than four blank charts, and it
 * tells whoever lands here exactly what unblocks it.
 */
function CallsEmptyState() {
  const tileCount = tilesForDashboard('calls').length;
  return (
    <div className="md:flex-1 md:min-h-0 flex items-start justify-center pt-12">
      <div className="bg-content1 border border-divider rounded-large p-8 max-w-lg text-center">
        <BarChart3 size={28} className="mx-auto text-foreground-400 mb-3" />
        <p className="text-sm font-semibold text-foreground">No call data connected</p>
        <p className="text-xs text-foreground-500 mt-2 leading-relaxed">
          This app has no incident or response-time data of its own — {' '}
          <span className="font-mono">Event.callTime</span> is a report-for-duty time, not a 911 call.
          Call metrics light up once an ESO / NEMSIS 3.5 export is imported.
        </p>
        <p className="text-[11px] text-foreground-400 mt-3">
          {tileCount === 0
            ? 'Importer and call tiles are not built yet.'
            : `${tileCount} tile(s) ready and waiting for data.`}
        </p>
      </div>
    </div>
  );
}
