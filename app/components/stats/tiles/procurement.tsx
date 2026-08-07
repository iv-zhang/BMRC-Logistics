'use client';

import React, { useState } from 'react';
import {
  procurementKpis,
  spendOverTime,
  spendByVendor,
  spendByCategory,
  unitPriceTrend,
  unitPriceItems,
  buyListLatency,
  openOrdersAging,
  orderFillRate,
} from '@/app/lib/stats/procurement';
import { groupBy, formatCurrency, formatNumber, formatPercent, formatDays } from '@/app/lib/stats/shared';
import { TileProps, TileDef } from '@/app/components/stats/tile-types';
import {
  KpiTile,
  BarChartTile,
  AreaChartTile,
  LineChartTile,
  DataTable,
  EmptyState,
  type BarDatum,
  type DataTableColumn,
} from '@/app/components/stats/chart-kit';

// ── 1. Procurement KPIs ──────────────────────────────────────────────────────

function ProcurementKpisTile({ data, filters, tileId }: TileProps) {
  const kpis = procurementKpis(data, filters, tileId);

  if (!kpis) {
    return <EmptyState message="No data for this range" />;
  }

  return (
    <div className="grid grid-cols-6 gap-3">
      <KpiTile label="Total Spend" value={formatCurrency(kpis.totalSpend)} />
      <KpiTile label="Orders" value={formatNumber(kpis.orderCount)} />
      <KpiTile label="Avg Order Value" value={formatCurrency(kpis.avgOrderValue)} />
      <KpiTile label="Overhead" value={formatPercent(kpis.overheadPct)} />
      <KpiTile label="Open Orders" value={formatNumber(kpis.openOrderCount)} />
      <KpiTile label="Request to Shelf" value={formatDays(kpis.medianRequestToShelfDays)} />
    </div>
  );
}

// ── 2. Spend Over Time ───────────────────────────────────────────────────────

function SpendOverTimeTile({ data, filters, tileId }: TileProps) {
  const rows = spendOverTime(data, filters, tileId);

  if (!rows || rows.length === 0) {
    return <EmptyState message="No data for this range" />;
  }

  return (
    <AreaChartTile
      data={rows as unknown as Record<string, string | number>[]}
      xKey="label"
      series={[
        { key: 'subtotal', label: 'Subtotal' },
        { key: 'shipping', label: 'Shipping' },
        { key: 'tax', label: 'Tax' },
      ]}
      valueFormat={formatCurrency}
      stacked
      height={240}
    />
  );
}

// ── 3. Spend by Vendor ───────────────────────────────────────────────────────

function SpendByVendorTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = spendByVendor(data, filters, tileId);
  const selectedVendor = filters.crossFilters.find(
    (f) => f.field === 'vendor' && f.sourceTileId === tileId
  )?.value;

  if (!rows || rows.length === 0) {
    return <EmptyState message="No data for this range" />;
  }

  const chartData: BarDatum[] = rows.map((r) => ({ label: r.label, value: r.value }));

  return (
    <BarChartTile
      data={chartData}
      horizontal
      valueFormat={formatCurrency}
      onBarClick={(label) => {
        if (label === selectedVendor) {
          onCrossFilter(null);
        } else {
          onCrossFilter({
            field: 'vendor',
            value: label,
            label,
            sourceTileId: tileId,
          });
        }
      }}
      selectedLabel={selectedVendor}
      height={240}
    />
  );
}

// ── 4. Spend by Category ─────────────────────────────────────────────────────

function SpendByCategoryTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = spendByCategory(data, filters, tileId);
  const selectedCategory = filters.crossFilters.find(
    (f) => f.field === 'category' && f.sourceTileId === tileId
  )?.value;

  if (!rows || rows.length === 0) {
    return <EmptyState message="No data for this range" />;
  }

  const chartData: BarDatum[] = rows.map((r) => ({ label: r.label, value: r.value }));

  return (
    <BarChartTile
      data={chartData}
      horizontal
      valueFormat={formatCurrency}
      onBarClick={(label) => {
        if (label === selectedCategory) {
          onCrossFilter(null);
        } else {
          onCrossFilter({
            field: 'category',
            value: label,
            label,
            sourceTileId: tileId,
          });
        }
      }}
      selectedLabel={selectedCategory}
      height={240}
    />
  );
}

// ── 5. Unit Price Trend ──────────────────────────────────────────────────────

function UnitPriceTrendTile({ data, filters }: TileProps) {
  const items = unitPriceItems(data);
  const [selectedItem, setSelectedItem] = useState<string>(items[0] ?? '');

  if (!items || items.length === 0) {
    return <EmptyState message="No items with price history" />;
  }

  if (!selectedItem) {
    return <EmptyState message="No item selected" />;
  }

  const rows = unitPriceTrend(data, filters, selectedItem);

  if (!rows || rows.length === 0) {
    return <EmptyState message="No data for this range" />;
  }

  // Group rows by vendor and date label, creating a data structure for LineChartTile
  // We want: [{ label: "Jan 1", vendorA: 10.5, vendorB: 12.0 }, ...]
  const byLabel = groupBy(rows, (r) => r.label);
  const chartData = Array.from(byLabel.entries()).map(([label, vendorRows]) => {
    const point: Record<string, string | number> = { label };
    for (const r of vendorRows) {
      point[r.vendor] = r.unitPrice;
    }
    return point;
  });

  // Extract unique vendors in order of first appearance
  const vendors: string[] = [];
  for (const row of rows) {
    if (!vendors.includes(row.vendor)) {
      vendors.push(row.vendor);
    }
  }
  const series = vendors.map((v) => ({ key: v, label: v }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-foreground-400">Item</label>
        <select
          value={selectedItem}
          onChange={(e) => setSelectedItem(e.target.value)}
          className="rounded-md border border-divider bg-content1 px-2 py-1 text-sm text-foreground"
        >
          {items.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <LineChartTile
        data={chartData}
        xKey="label"
        series={series}
        valueFormat={formatCurrency}
        height={220}
      />
    </div>
  );
}

// ── 6. Buy-List Latency ──────────────────────────────────────────────────────

function BuyListLatencyTile({ data, filters, tileId }: TileProps) {
  const rows = buyListLatency(data, filters, tileId);

  if (!rows || rows.length === 0) {
    return <EmptyState message="No data for this range" />;
  }

  const chartData: BarDatum[] = rows.map((r) => ({
    label: r.stage,
    value: r.medianDays ?? 0,
  }));

  return (
    <BarChartTile
      data={chartData}
      horizontal
      valueFormat={formatDays}
      height={160}
    />
  );
}

// ── 7. Open Orders Aging ─────────────────────────────────────────────────────

function OpenOrdersAgingTile({ data, filters, tileId }: TileProps) {
  const rows = openOrdersAging(data, filters, tileId);

  if (!rows || rows.length === 0) {
    return <EmptyState message="No open orders" />;
  }

  const columns: DataTableColumn[] = [
    { key: 'label', label: 'PO / Vendor' },
    { key: 'vendor', label: 'Vendor' },
    { key: 'daysOpen', label: 'Days Open', align: 'right', format: (v) => formatDays(v as number) },
    { key: 'total', label: 'Total', align: 'right', format: (v) => formatCurrency(v as number) },
    { key: 'status', label: 'Status' },
  ];

  return <DataTable columns={columns} rows={rows as unknown as Record<string, unknown>[]} maxHeight={280} />;
}

// ── 8. Order Fill Rate ───────────────────────────────────────────────────────

function OrderFillRateTile({ data, filters, tileId }: TileProps) {
  const result = orderFillRate(data, filters, tileId);

  if (!result || (!result.overall && (!result.lines || result.lines.length === 0))) {
    return <EmptyState message="No fulfilled orders" />;
  }

  const columns: DataTableColumn[] = [
    { key: 'label', label: 'Item' },
    { key: 'ordered', label: 'Ordered', align: 'right', format: (v) => formatNumber(v as number) },
    { key: 'received', label: 'Received', align: 'right', format: (v) => formatNumber(v as number) },
    { key: 'shortBy', label: 'Short By', align: 'right', format: (v) => formatNumber(v as number) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <KpiTile
          label="Fill Rate"
          value={formatPercent(result.overall)}
          tone={result.overall && result.overall >= 0.95 ? 'success' : result.overall && result.overall >= 0.8 ? 'warning' : 'danger'}
        />
      </div>
      {result.lines && result.lines.length > 0 && (
        <DataTable columns={columns} rows={result.lines as unknown as Record<string, unknown>[]} maxHeight={220} />
      )}
    </div>
  );
}

// ── Tile Registry ────────────────────────────────────────────────────────────

export const PROCUREMENT_TILES: TileDef[] = [
  {
    id: 'procurement.kpis',
    title: 'Purchasing Overview',
    description: 'Headline KPIs: total spend, order count, overhead, latency',
    dashboard: 'procurement',
    component: ProcurementKpisTile,
    defaultW: 12,
    defaultH: 2,
    dataDeps: ['purchases', 'buyList'],
  },
  {
    id: 'procurement.spendOverTime',
    title: 'Spend Over Time',
    description: 'Total spend by order date, stacked by cost component',
    dashboard: 'procurement',
    component: SpendOverTimeTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['purchases'],
  },
  {
    id: 'procurement.spendByVendor',
    title: 'Spend by Vendor',
    description: 'Total spend per vendor, clickable to cross-filter',
    dashboard: 'procurement',
    component: SpendByVendorTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['purchases'],
  },
  {
    id: 'procurement.spendByCategory',
    title: 'Spend by Category',
    description: 'Total goods spend per category, clickable to cross-filter',
    dashboard: 'procurement',
    component: SpendByCategoryTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['purchases'],
  },
  {
    id: 'procurement.unitPriceTrend',
    title: 'Unit Price Trend',
    description: 'Received unit price over time for a chosen item, by vendor',
    dashboard: 'procurement',
    component: UnitPriceTrendTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['purchases'],
  },
  {
    id: 'procurement.buyListLatency',
    title: 'Request → Shelf Latency',
    description: 'Median days by pipeline stage: request→order, order→receive, request→receive',
    dashboard: 'procurement',
    component: BuyListLatencyTile,
    defaultW: 6,
    defaultH: 4,
    dataDeps: ['purchases', 'buyList'],
  },
  {
    id: 'procurement.openOrdersAging',
    title: 'Open Orders Aging',
    description: 'Orders still pending or partially received, sorted by days open',
    dashboard: 'procurement',
    component: OpenOrdersAgingTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['purchases'],
  },
  {
    id: 'procurement.orderFillRate',
    title: 'Order Fill Rate',
    description: 'Received-vs-ordered fill rate, overall and by line',
    dashboard: 'procurement',
    component: OrderFillRateTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['purchases'],
  },
];
