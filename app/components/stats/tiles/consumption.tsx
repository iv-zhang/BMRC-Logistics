'use client';

/**
 * Usage-dashboard tiles for /stats ("consumption" `DashboardKey`).
 *
 * Each component is a pure function of `TileProps` (`data`, `filters`,
 * `tileId`, `onCrossFilter`) — see `app/components/stats/tile-types.ts`.
 * A tile renders ONLY its inner content; `tile-frame` supplies the card
 * chrome (title, description, remove/resize affordances), so nothing here
 * repeats the tile's own title.
 *
 * Selectors come from `app/lib/stats/consumption.ts` (statpack/inventory
 * usage) and `app/lib/stats/restock.ts` (restock report/action analytics,
 * ported from the old `/stats` "Restock" tab). `consumption.ts`'s
 * `shelfDrift` selector is deliberately NOT wired to a tile here — it always
 * returns `[]` because the underlying "expected shelf qty" isn't persisted
 * anywhere yet (see that function's doc comment), and shipping an
 * always-empty tile would misreport as "no drift" rather than "unknown".
 */

import * as React from 'react';
import type { TileDef, TileProps } from '@/app/components/stats/tile-types';
import type { CrossFilterField } from '@/app/lib/stats/shared';
import { formatNumber, formatHours, formatDays } from '@/app/lib/stats/shared';
import {
  consumptionKpis,
  consumptionOverTime,
  topConsumedItems,
  daysOfCover,
  usagePerDeployment,
  expiryWaste,
  restockLatencyHistogram,
  medicationActivity,
} from '@/app/lib/stats/consumption';
import {
  currentlyMissing,
  missingAgeSummary,
  topRestockBoxes,
  topReportedItems,
  reportsOverTime,
  restockKpis,
} from '@/app/lib/stats/restock';
import {
  BarChartTile,
  LineChartTile,
  AreaChartTile,
  HistogramTile,
  KpiTile,
  DataTable,
  EmptyState,
} from '@/app/components/stats/chart-kit';
import { CHART_SEMANTIC } from '@/app/components/stats/palette';

// ── Cross-filter click helpers ──────────────────────────────────────────────

/** The value this tile itself is currently filtering on for `field`, if any. */
function ownSelection(props: TileProps, field: CrossFilterField): string | undefined {
  return props.filters.crossFilters.find((f) => f.field === field && f.sourceTileId === props.tileId)?.value;
}

/** Toggle a cross-filter: clicking the already-selected mark clears it (Tableau's "use as filter" behavior). */
function toggleCrossFilter(props: TileProps, field: CrossFilterField, label: string) {
  if (label === ownSelection(props, field)) {
    props.onCrossFilter(null);
  } else {
    props.onCrossFilter({ field, value: label, label, sourceTileId: props.tileId });
  }
}

// ── 1. Usage Overview (KPI row) ─────────────────────────────────────────────

function ConsumptionKpisTile({ data, filters, tileId }: TileProps) {
  const kpis = consumptionKpis(data, filters, tileId);
  return (
    <div className="grid h-full grid-cols-2 gap-3 md:grid-cols-4">
      <KpiTile label="Units Used" value={kpis.totalUnitsUsed === null ? null : formatNumber(kpis.totalUnitsUsed)} caption="Shortfall + restock actions" />
      <KpiTile
        label="Items At Risk"
        value={kpis.itemsAtRisk === null ? null : formatNumber(kpis.itemsAtRisk)}
        caption="< 14 days of cover"
        tone={kpis.itemsAtRisk !== null && kpis.itemsAtRisk > 0 ? 'warning' : 'default'}
      />
      <KpiTile
        label="Median Restock Latency"
        value={kpis.medianRestockLatencyHours === null ? null : formatHours(kpis.medianRestockLatencyHours)}
        caption="Report → resolved"
      />
      <KpiTile
        label="Expired Units"
        value={kpis.expiredUnits === null ? null : formatNumber(kpis.expiredUnits)}
        caption="Lost to expiry"
        tone={kpis.expiredUnits !== null && kpis.expiredUnits > 0 ? 'danger' : 'default'}
      />
    </div>
  );
}

// ── 2. Consumption Over Time ────────────────────────────────────────────────

function ConsumptionOverTimeTile(props: TileProps) {
  const rows = consumptionOverTime(props.data, props.filters, props.tileId);
  return <LineChartTile data={rows} xKey="label" series={[{ key: 'value', label: 'Units used' }]} />;
}

// ── 3. Most-Used Items ──────────────────────────────────────────────────────

function TopItemsTile(props: TileProps) {
  const rows = topConsumedItems(props.data, props.filters, props.tileId);
  const selected = ownSelection(props, 'itemName');
  return (
    <BarChartTile
      data={rows}
      horizontal
      selectedLabel={selected}
      onBarClick={(label) => toggleCrossFilter(props, 'itemName', label)}
    />
  );
}

// ── 4. Days of Cover ─────────────────────────────────────────────────────────

function toneLabel(days: number | null): string {
  if (days === null) return 'No burn';
  if (days < 7) return 'Critical';
  if (days < 14) return 'Low';
  return 'OK';
}

function DaysOfCoverTile(props: TileProps) {
  const rows = daysOfCover(props.data, props.filters, props.tileId);
  if (rows.length === 0) return <EmptyState message="No consumable items to cover" />;
  return (
    <DataTable
      maxHeight={260}
      onRowClick={(row) => toggleCrossFilter(props, 'itemName', String(row.itemName))}
      columns={[
        { key: 'itemName', label: 'Item' },
        { key: 'reserveUnits', label: 'Reserve', align: 'right', format: (v) => formatNumber(v as number) },
        { key: 'burnPerDay', label: 'Burn/day', align: 'right', format: (v) => formatNumber(v as number, 2) },
        // daysOfCover === null means zero burn = infinite cover — formatDays
        // renders that as "—", never a fabricated "0 days".
        { key: 'daysOfCover', label: 'Days of Cover', align: 'right', format: (v) => formatDays(v as number | null) },
        { key: 'status', label: 'Status', align: 'right' },
      ]}
      rows={rows.map((r) => ({ ...r, status: toneLabel(r.daysOfCover) }))}
    />
  );
}

// ── 5. Usage per Deployment ──────────────────────────────────────────────────

function UsagePerDeploymentTile(props: TileProps) {
  const perPack = usagePerDeployment(props.data, props.filters, props.tileId);
  // perCheckout is null for packs with zero checkouts in range — excluded
  // rather than drawn as a fabricated zero-height bar (see CLAUDE.md's
  // "never a fabricated 0" rule).
  const rows = perPack
    .filter((r) => r.perCheckout !== null)
    .map((r) => ({ label: r.label, value: r.perCheckout as number }));
  const selected = ownSelection(props, 'packName');
  return (
    <BarChartTile
      data={rows}
      selectedLabel={selected}
      valueFormat={(n) => formatNumber(n, 1)}
      onBarClick={(label) => toggleCrossFilter(props, 'packName', label)}
    />
  );
}

// ── 6. Expiry Waste ───────────────────────────────────────────────────────────

function ExpiryWasteTile(props: TileProps) {
  const rows = expiryWaste(props.data, props.filters, props.tileId).map((r) => ({ label: r.label, value: r.units }));
  return <BarChartTile data={rows} horizontal color={CHART_SEMANTIC.bad} />;
}

// ── 7. Restock Latency (histogram) ───────────────────────────────────────────

function RestockLatencyTile(props: TileProps) {
  const bins = restockLatencyHistogram(props.data, props.filters, props.tileId);
  return <HistogramTile bins={bins} xLabel="Hours to resolve" />;
}

// ── 8. Medication Activity ───────────────────────────────────────────────────

function MedicationActivityTile(props: TileProps) {
  // Mapped into fresh object literals: named interfaces (MedicationActivityRow)
  // don't carry the implicit index signature TS grants object type literals,
  // so passing the selector's return type straight through fails against
  // AreaChartTile's `Record<string, string | number>[]` prop type.
  const rows = medicationActivity(props.data, props.filters, props.tileId).map((r) => ({
    label: r.label,
    administered: r.administered,
    wasted: r.wasted,
    received: r.received,
  }));
  return (
    <AreaChartTile
      data={rows}
      xKey="label"
      stacked
      series={[
        { key: 'administered', label: 'Administered' },
        { key: 'wasted', label: 'Wasted' },
        { key: 'received', label: 'Received' },
      ]}
    />
  );
}

// ── 9. Currently Missing ─────────────────────────────────────────────────────

function CurrentlyMissingTile({ data, filters, tileId }: TileProps) {
  const rows = currentlyMissing(data, filters, tileId);
  const summary = missingAgeSummary(data, filters, tileId);
  if (rows.length === 0) {
    return <EmptyState message="Nothing outstanding" hint="All reported items have been replaced." />;
  }
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-end gap-4 text-[11px] uppercase tracking-wide text-foreground-400">
        <span>
          Longest{' '}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {summary.maxOpenAgeHours !== null ? formatHours(summary.maxOpenAgeHours) : '—'}
          </span>
        </span>
        <span>
          Avg{' '}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {summary.avgOpenAgeHours !== null ? formatHours(summary.avgOpenAgeHours) : '—'}
          </span>
        </span>
      </div>
      <DataTable
        maxHeight={220}
        columns={[
          { key: 'name', label: 'Item / Box' },
          { key: 'ageHours', label: 'Missing For', align: 'right', format: (v) => formatHours(v as number) },
        ]}
        rows={rows.map((r) => ({ ...r }))}
      />
    </div>
  );
}

// ── 10. Top Restock Boxes ────────────────────────────────────────────────────

function TopRestockBoxesTile(props: TileProps) {
  const rows = topRestockBoxes(props.data, props.filters, props.tileId);
  return <BarChartTile data={rows} horizontal />;
}

// ── 11. Top Reported Items ───────────────────────────────────────────────────

function TopReportedItemsTile(props: TileProps) {
  const rows = topReportedItems(props.data, props.filters, props.tileId);
  return <BarChartTile data={rows} horizontal />;
}

// ── 12. Reports Over Time ────────────────────────────────────────────────────

function ReportsOverTimeTile(props: TileProps) {
  const rows = reportsOverTime(props.data, props.filters, props.tileId).map((r) => ({ ...r }));
  return <LineChartTile data={rows} xKey="label" series={[{ key: 'value', label: 'Reports' }]} />;
}

// ── 13. Restock Overview (KPI row) ───────────────────────────────────────────

function RestockKpisTile({ data, filters, tileId }: TileProps) {
  const kpis = restockKpis(data, filters, tileId);
  return (
    <div className="grid h-full grid-cols-2 gap-3 md:grid-cols-4">
      <KpiTile label="Total Reports" value={formatNumber(kpis.totalReports)} caption="In range" />
      <KpiTile
        label="Open Reports"
        value={formatNumber(kpis.openReports)}
        caption="Unresolved"
        tone={kpis.openReports > 0 ? 'warning' : 'default'}
      />
      <KpiTile label="Restock Actions" value={formatNumber(kpis.totalActions)} caption="Manual restocks" />
      <KpiTile
        label="Avg Time to Replace"
        value={kpis.avgResolveHours === null ? null : formatHours(kpis.avgResolveHours)}
        caption="Resolved reports"
      />
    </div>
  );
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const CONSUMPTION_TILES: TileDef[] = [
  {
    id: 'consumption.kpis',
    title: 'Usage Overview',
    description: 'Headline burn, at-risk items, restock latency, and expiry waste.',
    dashboard: 'consumption',
    component: ConsumptionKpisTile,
    defaultW: 12,
    defaultH: 2,
    dataDeps: ['statpackLogs', 'restockActions', 'inventory', 'restockReports'],
  },
  {
    id: 'consumption.overTime',
    title: 'Consumption Over Time',
    description: 'Units consumed per period, from checkin shortfalls and restock actions.',
    dashboard: 'consumption',
    component: ConsumptionOverTimeTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['statpackLogs', 'restockActions'],
  },
  {
    id: 'consumption.topItems',
    title: 'Most-Used Items',
    description: 'Items with the largest checkin shortfall, click to filter other tiles.',
    dashboard: 'consumption',
    component: TopItemsTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['statpackLogs'],
  },
  {
    id: 'consumption.daysOfCover',
    title: 'Days of Cover',
    description: 'Back-reserve stock divided by recent burn rate, soonest-to-run-out first.',
    dashboard: 'consumption',
    component: DaysOfCoverTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['inventory', 'statpackLogs', 'restockActions'],
  },
  {
    id: 'consumption.usagePerDeployment',
    title: 'Usage per Deployment',
    description: 'Items used per checkout, by pack.',
    dashboard: 'consumption',
    component: UsagePerDeploymentTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['statpackLogs', 'statpacks'],
  },
  {
    id: 'consumption.expiryWaste',
    title: 'Expiry Waste',
    description: 'Units lost to expiry, by item.',
    dashboard: 'consumption',
    component: ExpiryWasteTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['inventory'],
  },
  {
    id: 'consumption.restockLatency',
    title: 'Restock Latency',
    description: 'Distribution of resolved-report turnaround time, in hours.',
    dashboard: 'consumption',
    component: RestockLatencyTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['restockReports'],
  },
  {
    id: 'consumption.medicationActivity',
    title: 'Medication Activity',
    description: 'Administered, wasted, and received medication units per period.',
    dashboard: 'consumption',
    component: MedicationActivityTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['medicationLogs'],
  },
  {
    id: 'consumption.currentlyMissing',
    title: 'Currently Missing',
    description: 'Still-open restock reports, longest-outstanding first.',
    dashboard: 'consumption',
    component: CurrentlyMissingTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['restockReports'],
  },
  {
    id: 'consumption.topRestockBoxes',
    title: 'Top Restock Boxes',
    description: 'Restock boxes with the most reports in range.',
    dashboard: 'consumption',
    component: TopRestockBoxesTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['restockReports'],
  },
  {
    id: 'consumption.topReportedItems',
    title: 'Top Reported Items',
    description: 'Items named in restock reports the most.',
    dashboard: 'consumption',
    component: TopReportedItemsTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['restockReports'],
  },
  {
    id: 'consumption.reportsOverTime',
    title: 'Reports Over Time',
    description: 'Restock report volume per period.',
    dashboard: 'consumption',
    component: ReportsOverTimeTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['restockReports'],
  },
  {
    id: 'consumption.restockKpis',
    title: 'Restock Overview',
    description: 'Report volume, open count, restock actions, and resolve time.',
    dashboard: 'consumption',
    component: RestockKpisTile,
    defaultW: 12,
    defaultH: 2,
    dataDeps: ['restockReports', 'restockActions'],
  },
];
