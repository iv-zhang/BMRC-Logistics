'use client';

/**
 * Shared chart component kit for the /stats dashboard. Every tile in the app
 * renders through these components — see the file header in `palette.ts` for
 * how theme-awareness works. This file owns no data logic: every component
 * here is a pure function of its props (see decisions.md D-27 / tile-types.ts
 * `TileProps` for how tiles feed data in).
 *
 * Recharts is used for every true chart form; FunnelTile and DataTable are
 * the two forms where a plain Recharts primitive is either optional
 * (Funnel — built here as a horizontal Bar chart, per the brief) or wrong
 * (DataTable needs a real semantic `<table>`, not an SVG chart).
 */

import * as React from 'react';
import { Inbox } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  PieChart,
  Pie,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from 'recharts';
import { CHART_COLORS, CHART_ORDINAL_RAMP, axisProps, gridProps, tooltipStyle } from './palette';

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Default value formatter used whenever a tile doesn't pass its own
 * `valueFormat`. Rounds away float noise (3.0000000001 → "3") before
 * formatting, and only shows decimals when the value actually has them.
 */
function defaultFormat(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: rounded % 1 === 0 ? 0 : 2 });
}

function seriesColor(color: string | undefined, index: number): string {
  return color || CHART_COLORS[index % CHART_COLORS.length];
}

function funnelColor(index: number, total: number): string {
  if (total <= 1) return CHART_ORDINAL_RAMP[Math.floor(CHART_ORDINAL_RAMP.length / 2)];
  const idx = Math.round((index * (CHART_ORDINAL_RAMP.length - 1)) / (total - 1));
  return CHART_ORDINAL_RAMP[idx];
}

interface TooltipPayloadEntry {
  color?: string;
  name?: React.ReactNode;
  value?: number | string;
}

interface ChartTooltipContentProps {
  active?: boolean;
  label?: React.ReactNode;
  payload?: TooltipPayloadEntry[];
  valueFormat?: (n: number) => string;
}

/**
 * Shared tooltip renderer for every Recharts-based tile: one card, values
 * lead (bold, high-contrast), series name follows (secondary), keyed by a
 * short line swatch rather than a filled box. Never shows a raw float —
 * every value goes through `valueFormat` (defaulting to `defaultFormat`).
 */
function ChartTooltipContent({ active, label, payload, valueFormat = defaultFormat }: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={tooltipStyle.contentStyle}>
      {label !== undefined && label !== null && <div style={tooltipStyle.labelStyle}>{label}</div>}
      <div className="flex flex-col gap-1">
        {payload.map((p, i) => {
          const num = typeof p.value === 'number' ? p.value : Number(p.value);
          return (
            <div key={i} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                style={{ width: 10, height: 2, borderRadius: 1, background: p.color, flex: 'none' }}
              />
              {p.name !== undefined && (
                <span style={{ ...tooltipStyle.itemStyle, color: 'hsl(var(--heroui-foreground-500))' }}>
                  {p.name}
                </span>
              )}
              <span
                className="font-mono font-semibold tabular-nums"
                style={{ ...tooltipStyle.itemStyle, marginLeft: 'auto', color: 'hsl(var(--heroui-foreground))' }}
              >
                {Number.isFinite(num) ? valueFormat(num) : String(p.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface LegendPayloadEntry {
  color?: string;
  value?: React.ReactNode;
}

/** Shared legend renderer — line-key swatches, small muted labels, wraps. */
function ChartLegendContent({ payload }: { payload?: LegendPayloadEntry[] }) {
  if (!payload || payload.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2">
      {payload.map((entry, i) => (
        <span
          key={i}
          className="flex items-center gap-1.5 text-[11px] font-medium"
          style={{ color: 'hsl(var(--heroui-foreground-500))' }}
        >
          <span aria-hidden="true" style={{ width: 10, height: 2, borderRadius: 1, background: entry.color, flex: 'none' }} />
          {entry.value}
        </span>
      ))}
    </div>
  );
}

/** Common outer frame every Recharts tile renders inside: fills its parent, carries the aria-label. */
function ChartFrame({
  height,
  ariaLabel,
  children,
}: {
  height: number;
  ariaLabel: string;
  children: React.ReactElement;
}) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  message: string;
  hint?: string;
}

/** A chart of zeroes is a lie — every tile below renders this instead when its data is empty. */
export function EmptyState({ message, hint }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
      <Inbox size={22} className="text-foreground-400" aria-hidden="true" />
      <span className="text-sm font-medium text-foreground-500">{message}</span>
      {hint && <span className="text-xs text-foreground-400">{hint}</span>}
    </div>
  );
}

// ── BarChartTile ─────────────────────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartTileProps {
  data: BarDatum[];
  horizontal?: boolean;
  onBarClick?: (label: string) => void;
  valueFormat?: (n: number) => string;
  color?: string;
  height?: number;
  selectedLabel?: string;
}

export function BarChartTile({
  data,
  horizontal = false,
  onBarClick,
  valueFormat = defaultFormat,
  color,
  height = 240,
  selectedLabel,
}: BarChartTileProps) {
  if (!data || data.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  const barColor = color || CHART_COLORS[0];
  const hasSelection = selectedLabel !== undefined && selectedLabel !== null;

  return (
    <ChartFrame height={height} ariaLabel={`Bar chart, ${data.length} ${data.length === 1 ? 'category' : 'categories'}`}>
      <BarChart
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        barCategoryGap="24%"
        accessibilityLayer
      >
        <CartesianGrid {...gridProps} horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" {...axisProps} tickFormatter={valueFormat} />
            <YAxis type="category" dataKey="label" {...axisProps} width={100} />
          </>
        ) : (
          <>
            <XAxis type="category" dataKey="label" {...axisProps} />
            <YAxis type="number" {...axisProps} tickFormatter={valueFormat} width={44} />
          </>
        )}
        <Tooltip
          cursor={tooltipStyle.cursor}
          content={<ChartTooltipContent valueFormat={valueFormat} />}
        />
        <Bar
          dataKey="value"
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
          onClick={onBarClick ? (entry: unknown) => onBarClick((entry as BarDatum).label) : undefined}
          cursor={onBarClick ? 'pointer' : undefined}
        >
          {data.map((d) => (
            <Cell
              key={d.label}
              fill={barColor}
              fillOpacity={hasSelection ? (d.label === selectedLabel ? 1 : 0.35) : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

// ── LineChartTile / AreaChartTile ───────────────────────────────────────────

export interface SeriesSpec {
  key: string;
  label: string;
  color?: string;
}

export interface LineChartTileProps {
  data: Record<string, string | number>[];
  xKey: string;
  series: SeriesSpec[];
  valueFormat?: (n: number) => string;
  height?: number;
}

export function LineChartTile({ data, xKey, series, valueFormat = defaultFormat, height = 240 }: LineChartTileProps) {
  if (!data || data.length === 0 || !series || series.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <ChartFrame height={height} ariaLabel={`Line chart, ${series.length} ${series.length === 1 ? 'series' : 'series'} over ${data.length} points`}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} tickFormatter={valueFormat} width={44} />
        <Tooltip
          cursor={{ stroke: 'hsl(var(--heroui-divider))' }}
          content={<ChartTooltipContent valueFormat={valueFormat} />}
        />
        {series.length > 1 && <Legend content={<ChartLegendContent />} />}
        {series.map((s, i) => {
          const c = seriesColor(s.color, i);
          return (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={c}
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--heroui-content1))', fill: c }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--heroui-content1))' }}
              isAnimationActive={false}
            />
          );
        })}
      </LineChart>
    </ChartFrame>
  );
}

export interface AreaChartTileProps extends LineChartTileProps {
  stacked?: boolean;
}

export function AreaChartTile({
  data,
  xKey,
  series,
  valueFormat = defaultFormat,
  height = 240,
  stacked = false,
}: AreaChartTileProps) {
  if (!data || data.length === 0 || !series || series.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <ChartFrame height={height} ariaLabel={`Area chart, ${series.length} series over ${data.length} points`}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} tickFormatter={valueFormat} width={44} />
        <Tooltip
          cursor={{ stroke: 'hsl(var(--heroui-divider))' }}
          content={<ChartTooltipContent valueFormat={valueFormat} />}
        />
        {series.length > 1 && <Legend content={<ChartLegendContent />} />}
        {series.map((s, i) => {
          const c = seriesColor(s.color, i);
          return (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'stack' : undefined}
              stroke={c}
              strokeWidth={2}
              fill={c}
              fillOpacity={0.1}
              isAnimationActive={false}
            />
          );
        })}
      </AreaChart>
    </ChartFrame>
  );
}

// ── ScatterChartTile ─────────────────────────────────────────────────────────

export interface ScatterDatum {
  x: number;
  y: number;
  label: string;
}

export interface ScatterChartTileProps {
  data: ScatterDatum[];
  xLabel: string;
  yLabel: string;
  valueFormat?: (n: number) => string;
  height?: number;
}

function ScatterTooltipContent({
  active,
  payload,
  xLabel,
  yLabel,
  valueFormat = defaultFormat,
}: {
  active?: boolean;
  payload?: { payload: ScatterDatum }[];
  xLabel: string;
  yLabel: string;
  valueFormat?: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div style={tooltipStyle.contentStyle}>
      <div style={tooltipStyle.labelStyle}>{d.label}</div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span style={{ ...tooltipStyle.itemStyle, color: 'hsl(var(--heroui-foreground-500))' }}>{xLabel}</span>
          <span
            className="font-mono font-semibold tabular-nums"
            style={{ ...tooltipStyle.itemStyle, marginLeft: 'auto', color: 'hsl(var(--heroui-foreground))' }}
          >
            {valueFormat(d.x)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ ...tooltipStyle.itemStyle, color: 'hsl(var(--heroui-foreground-500))' }}>{yLabel}</span>
          <span
            className="font-mono font-semibold tabular-nums"
            style={{ ...tooltipStyle.itemStyle, marginLeft: 'auto', color: 'hsl(var(--heroui-foreground))' }}
          >
            {valueFormat(d.y)}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 10px-diameter dot with a 2px surface ring, per the mark spec (marker ≥ 8px, ring separates overlaps). */
function ScatterDot(props: { cx?: number; cy?: number }) {
  const { cx, cy } = props;
  if (cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={5} fill={CHART_COLORS[0]} stroke="hsl(var(--heroui-content1))" strokeWidth={2} />;
}

export function ScatterChartTile({ data, xLabel, yLabel, valueFormat = defaultFormat, height = 240 }: ScatterChartTileProps) {
  if (!data || data.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <ChartFrame height={height} ariaLabel={`Scatter plot of ${xLabel} vs ${yLabel}, ${data.length} points`}>
      <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
        <CartesianGrid {...gridProps} vertical />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          {...axisProps}
          tickFormatter={valueFormat}
          label={{ value: xLabel, position: 'insideBottom', offset: -4, fontSize: 11, fill: 'hsl(var(--heroui-foreground-400))' }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          {...axisProps}
          tickFormatter={valueFormat}
          width={44}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11, fill: 'hsl(var(--heroui-foreground-400))' }}
        />
        <Tooltip
          cursor={{ strokeDasharray: '3 3', stroke: 'hsl(var(--heroui-divider))' }}
          content={<ScatterTooltipContent xLabel={xLabel} yLabel={yLabel} valueFormat={valueFormat} />}
        />
        <Scatter data={data} shape={ScatterDot} isAnimationActive={false} />
      </ScatterChart>
    </ChartFrame>
  );
}

// ── HistogramTile ────────────────────────────────────────────────────────────

export interface HistogramBin {
  label: string;
  from: number;
  to: number;
  value: number;
}

export interface HistogramTileProps {
  bins: HistogramBin[];
  xLabel?: string;
  height?: number;
}

export function HistogramTile({ bins, xLabel, height = 240 }: HistogramTileProps) {
  if (!bins || bins.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <ChartFrame height={height} ariaLabel={`Histogram${xLabel ? ` of ${xLabel}` : ''}, ${bins.length} bins`}>
      <BarChart
        data={bins}
        margin={{ top: 8, right: 12, left: 0, bottom: xLabel ? 18 : 0 }}
        barCategoryGap="4%"
        accessibilityLayer
      >
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval="preserveStartEnd"
          label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -10, fontSize: 11, fill: 'hsl(var(--heroui-foreground-400))' } : undefined}
        />
        <YAxis {...axisProps} width={36} allowDecimals={false} />
        <Tooltip cursor={tooltipStyle.cursor} content={<ChartTooltipContent />} />
        <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  );
}

// ── DonutTile ────────────────────────────────────────────────────────────────

export interface DonutDatum {
  label: string;
  value: number;
}

export interface DonutTileProps {
  data: DonutDatum[];
  valueFormat?: (n: number) => string;
  height?: number;
  centerLabel?: string;
  centerValue?: string;
}

export function DonutTile({ data, valueFormat = defaultFormat, height = 240, centerLabel, centerValue }: DonutTileProps) {
  const hasData = data && data.length > 0 && data.some((d) => d.value > 0);
  if (!hasData) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <div style={{ width: '100%', height, position: 'relative' }}>
      <ChartFrame height={height} ariaLabel={`Donut chart, ${data.length} categories`}>
        <PieChart>
          <Tooltip content={<ChartTooltipContent valueFormat={valueFormat} />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="hsl(var(--heroui-content1))"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((d, i) => (
              <Cell key={d.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Legend content={<ChartLegendContent />} verticalAlign="bottom" />
        </PieChart>
      </ChartFrame>
      {(centerLabel || centerValue) && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center justify-center"
          style={{ height: height - 24 }}
        >
          {centerValue && (
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{centerValue}</span>
          )}
          {centerLabel && <span className="text-[11px] font-medium text-foreground-400">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}

// ── FunnelTile ───────────────────────────────────────────────────────────────

export interface FunnelStage {
  label: string;
  value: number;
}

export interface FunnelTileProps {
  stages: FunnelStage[];
  valueFormat?: (n: number) => string;
  height?: number;
}

export function FunnelTile({ stages, valueFormat = defaultFormat, height = 240 }: FunnelTileProps) {
  if (!stages || stages.length === 0) {
    return <EmptyState message="No data for this range" />;
  }
  return (
    <ChartFrame height={height} ariaLabel={`Funnel chart, ${stages.length} stages`}>
      <BarChart
        data={stages}
        layout="vertical"
        margin={{ top: 8, right: 48, left: 8, bottom: 0 }}
        barCategoryGap="30%"
        accessibilityLayer
      >
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" {...axisProps} width={110} />
        <Tooltip cursor={tooltipStyle.cursor} content={<ChartTooltipContent valueFormat={valueFormat} />} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={28} isAnimationActive={false}>
          {stages.map((s, i) => (
            <Cell key={s.label} fill={funnelColor(i, stages.length)} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

// ── KpiTile ──────────────────────────────────────────────────────────────────

export interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  caption?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

const KPI_TONE_CLASS: Record<NonNullable<KpiTileProps['tone']>, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function KpiTile({ label, value, caption, tone = 'default' }: KpiTileProps) {
  if (value === null || value === undefined) {
    return <EmptyState message="No data" />;
  }
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-400">{label}</div>
      <div className={`font-mono text-[28px] font-semibold leading-tight tabular-nums ${KPI_TONE_CLASS[tone]}`}>
        {value}
      </div>
      {caption && <div className="mt-1 text-xs font-medium text-foreground-400">{caption}</div>}
    </div>
  );
}

// ── DataTable ────────────────────────────────────────────────────────────────

export interface DataTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  format?: (v: unknown) => string;
}

export interface DataTableProps {
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
  onRowClick?: (row: Record<string, unknown>) => void;
  maxHeight?: number;
}

export function DataTable({ columns, rows, onRowClick, maxHeight = 320 }: DataTableProps) {
  if (!columns || columns.length === 0 || !rows || rows.length === 0) {
    return <EmptyState message="No rows to show" />;
  }
  return (
    <div className="overflow-hidden rounded-large border border-divider bg-content1">
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-divider bg-content2">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-foreground-400 ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {rows.map((row, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={onRowClick ? 'cursor-pointer transition-colors duration-150 hover:bg-content2' : ''}
              >
                {columns.map((c) => {
                  const raw = row[c.key];
                  const isNum = typeof raw === 'number';
                  const display = c.format ? c.format(raw) : raw === null || raw === undefined ? '—' : String(raw);
                  return (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-3 py-2 text-foreground ${isNum ? 'font-mono tabular-nums' : ''} ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
