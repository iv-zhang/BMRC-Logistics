'use client';

import React from 'react';
import type { TileProps, TileDef } from '../tile-types';
import {
  BarChartTile,
  LineChartTile,
  HistogramTile,
  FunnelTile,
  KpiTile,
  DataTable,
  EmptyState,
} from '../chart-kit';
import { formatPercent, formatHours, formatNumber } from '@/app/lib/stats/shared';
import {
  staffingKpis,
  fillRateOverTime,
  unfilledSlotsByRole,
  attendanceFunnel,
  latenessHistogram,
  latenessByMember,
  hoursByMember,
  participationByCohort,
  certExpiryRunway,
  requestSupplyDemand,
} from '@/app/lib/stats/staffing';

// ── KPI Tile ─────────────────────────────────────────────────────────────

function StaffingKpisTile({ data, filters, tileId }: TileProps) {
  const kpis = staffingKpis(data, filters, tileId);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <KpiTile label="Events" value={formatNumber(kpis.eventCount)} />
      <KpiTile
        label="Fill Rate"
        value={kpis.overallFillRate !== null ? formatPercent(kpis.overallFillRate) : '—'}
      />
      <KpiTile
        label="Attendance"
        value={kpis.attendanceRate !== null ? formatPercent(kpis.attendanceRate) : '—'}
      />
      <KpiTile label="No-shows" value={formatNumber(kpis.noShowCount)} />
      <KpiTile label="Total Hours" value={formatHours(kpis.totalHours)} />
      <KpiTile label="Active Members" value={formatNumber(kpis.membersActive)} />
    </div>
  );
}

// ── Fill Rate Over Time ──────────────────────────────────────────────────

function FillRateOverTimeTile({ data, filters, tileId }: TileProps) {
  const rows = fillRateOverTime(data, filters, tileId);

  if (!rows.length) {
    return <EmptyState message="No events in this period" />;
  }

  // Remove the rate field since it may be null; LineChartTile only accepts string|number
  const chartData = rows.map(({ label, required, filled }) => ({
    label,
    required,
    filled,
  }));

  return (
    <LineChartTile
      data={chartData}
      xKey="label"
      series={[
        { key: 'filled', label: 'Filled', color: '#10b981' },
        { key: 'required', label: 'Required' },
      ]}
      valueFormat={formatNumber}
      height={240}
    />
  );
}

// ── Unfilled Slots by Role ───────────────────────────────────────────────

function UnfilledSlotsTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = unfilledSlotsByRole(data, filters, tileId);

  const selectedFilter = filters.crossFilters.find(
    (f) => f.field === 'role' && f.sourceTileId !== tileId
  );
  const selectedLabel = selectedFilter?.label;

  const handleBarClick = (label: string) => {
    if (selectedLabel === label) {
      onCrossFilter(null);
    } else {
      onCrossFilter({
        field: 'role',
        value: label,
        label,
        sourceTileId: tileId,
      });
    }
  };

  if (!rows.length) {
    return <EmptyState message="All slots filled" />;
  }

  return (
    <BarChartTile
      data={rows}
      onBarClick={handleBarClick}
      valueFormat={formatNumber}
      selectedLabel={selectedLabel}
      height={240}
    />
  );
}

// ── Attendance Funnel ────────────────────────────────────────────────────

function AttendanceFunnelTile({ data, filters, tileId }: TileProps) {
  const rows = attendanceFunnel(data, filters, tileId);

  if (!rows.length) {
    return <EmptyState message="No requests" />;
  }

  const stages = rows.map((r) => ({
    label: r.stage,
    value: r.value,
  }));

  return (
    <FunnelTile stages={stages} valueFormat={formatNumber} height={240} />
  );
}

// ── Lateness Histogram ───────────────────────────────────────────────────

function LatenessHistogramTile({ data, filters, tileId }: TileProps) {
  const bins = latenessHistogram(data, filters, tileId);

  if (!bins.length) {
    return <EmptyState message="No check-ins" />;
  }

  return (
    <HistogramTile bins={bins} xLabel="Minutes late" height={240} />
  );
}

// ── Lateness by Member ───────────────────────────────────────────────────

function LatenessByMemberTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = latenessByMember(data, filters, tileId);

  const selectedFilter = filters.crossFilters.find(
    (f) => f.field === 'memberName' && f.sourceTileId !== tileId
  );
  const selectedLabel = selectedFilter?.label;

  const handleBarClick = (label: string) => {
    if (selectedLabel === label) {
      onCrossFilter(null);
    } else {
      onCrossFilter({
        field: 'memberName',
        value: label,
        label,
        sourceTileId: tileId,
      });
    }
  };

  const barData = rows.map((r) => ({
    label: r.label,
    value: r.medianLate,
  }));

  if (!barData.length) {
    return <EmptyState message="No check-in data" />;
  }

  return (
    <BarChartTile
      data={barData}
      horizontal
      onBarClick={handleBarClick}
      valueFormat={(n) => `${formatNumber(n)} min`}
      selectedLabel={selectedLabel}
      height={240}
    />
  );
}

// ── Hours by Member ──────────────────────────────────────────────────────

function HoursByMemberTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = hoursByMember(data, filters, tileId);

  const selectedFilter = filters.crossFilters.find(
    (f) => f.field === 'memberName' && f.sourceTileId !== tileId
  );
  const selectedLabel = selectedFilter?.label;

  const handleRowClick = (row: Record<string, unknown>) => {
    const label = row.label as string;
    if (selectedLabel === label) {
      onCrossFilter(null);
    } else {
      onCrossFilter({
        field: 'memberName',
        value: label,
        label,
        sourceTileId: tileId,
      });
    }
  };

  if (!rows.length) {
    return <EmptyState message="No shift data" />;
  }

  const tableRows = rows.map((r) => ({
    label: r.label,
    allTimeHours: r.allTimeHours,
    semesterHours: r.semesterHours,
    shifts: r.shifts,
  }));

  return (
    <DataTable
      columns={[
        { key: 'label', label: 'Member' },
        { key: 'allTimeHours', label: 'All-time', align: 'right', format: (v) => formatHours(v as number) },
        { key: 'semesterHours', label: 'This Semester', align: 'right', format: (v) => formatHours(v as number) },
        { key: 'shifts', label: 'Shifts', align: 'right', format: (v) => formatNumber(v as number) },
      ]}
      rows={tableRows}
      onRowClick={handleRowClick}
      maxHeight={280}
    />
  );
}

// ── Participation by Cohort ──────────────────────────────────────────────

function ParticipationByCohortTile({ data, filters, tileId }: TileProps) {
  const rows = participationByCohort(data, filters, tileId);

  const barData = rows.map((r) => ({
    label: r.label,
    value: r.avgShiftsPerMember ?? 0,
  }));

  if (!barData.length) {
    return <EmptyState message="No participation data" />;
  }

  return (
    <BarChartTile
      data={barData}
      valueFormat={(n) => n.toFixed(1)}
      height={240}
    />
  );
}

// ── Certification Runway ─────────────────────────────────────────────────

function CertExpiryRunwayTile({ data, filters, tileId }: TileProps) {
  const rows = certExpiryRunway(data, filters, tileId);

  const toneMap: Record<string, 'danger' | 'warning' | 'default'> = {
    Expired: 'danger',
    '<30d': 'warning',
    '30-60d': 'default',
    '60-90d': 'default',
    '>90d': 'default',
  };

  if (!rows.length || rows.every((r) => r.value === 0)) {
    return <EmptyState message="No members" />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {rows.map((row) => (
        <KpiTile
          key={row.label}
          label={row.label}
          value={formatNumber(row.value)}
          tone={toneMap[row.label]}
        />
      ))}
    </div>
  );
}

// ── Request Supply/Demand ────────────────────────────────────────────────

function RequestSupplyDemandTile({ data, filters, tileId, onCrossFilter }: TileProps) {
  const rows = requestSupplyDemand(data, filters, tileId);

  const selectedFilter = filters.crossFilters.find(
    (f) => f.field === 'eventName' && f.sourceTileId !== tileId
  );
  const selectedLabel = selectedFilter?.label;

  const handleRowClick = (row: Record<string, unknown>) => {
    const label = row.label as string;
    if (selectedLabel === label) {
      onCrossFilter(null);
    } else {
      onCrossFilter({
        field: 'eventName',
        value: label,
        label,
        sourceTileId: tileId,
      });
    }
  };

  if (!rows.length) {
    return <EmptyState message="No events" />;
  }

  const tableRows = rows.map((r) => ({
    label: r.label,
    requests: r.requests,
    slots: r.slots,
    ratio: r.ratio,
  }));

  return (
    <DataTable
      columns={[
        { key: 'label', label: 'Event' },
        {
          key: 'requests',
          label: 'Requests',
          align: 'right',
          format: (v) => formatNumber(v as number),
        },
        { key: 'slots', label: 'Slots', align: 'right', format: (v) => formatNumber(v as number) },
        {
          key: 'ratio',
          label: 'Ratio',
          align: 'right',
          format: (v) => (v === null ? '—' : (v as number).toFixed(2)),
        },
      ]}
      rows={tableRows}
      onRowClick={handleRowClick}
      maxHeight={280}
    />
  );
}

// ── Tile Definitions ─────────────────────────────────────────────────────

export const STAFFING_TILES: TileDef[] = [
  {
    id: 'staffing.kpis',
    title: 'Staffing Overview',
    description: 'Key staffing metrics for the selected period',
    dashboard: 'staffing',
    component: StaffingKpisTile,
    defaultW: 12,
    defaultH: 2,
    dataDeps: ['events', 'shiftRequests'],
  },
  {
    id: 'staffing.fillRateOverTime',
    title: 'Fill Rate Over Time',
    description: 'Slot fill rate trended over time',
    dashboard: 'staffing',
    component: FillRateOverTimeTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['events', 'shiftRequests'],
  },
  {
    id: 'staffing.unfilledSlots',
    title: 'Unfilled Slots by Role',
    description: 'FTO and EMT positions left open',
    dashboard: 'staffing',
    component: UnfilledSlotsTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['events'],
  },
  {
    id: 'staffing.attendanceFunnel',
    title: 'Attendance Funnel',
    description: 'Request flow from signup to outcome',
    dashboard: 'staffing',
    component: AttendanceFunnelTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['shiftRequests'],
  },
  {
    id: 'staffing.latenessHistogram',
    title: 'Lateness Distribution',
    description: 'Distribution of arrival times relative to shift start',
    dashboard: 'staffing',
    component: LatenessHistogramTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['shiftRequests'],
  },
  {
    id: 'staffing.latenessByMember',
    title: 'Median Lateness by Member',
    description: 'Average arrival lateness per volunteer',
    dashboard: 'staffing',
    component: LatenessByMemberTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['shiftRequests'],
  },
  {
    id: 'staffing.hoursByMember',
    title: 'Hours by Member',
    description: 'Shift hours logged per volunteer',
    dashboard: 'staffing',
    component: HoursByMemberTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['shiftRequests', 'users'],
  },
  {
    id: 'staffing.participationByCohort',
    title: 'Participation by Cohort',
    description: 'Shifts per volunteer, grouped by experience level',
    dashboard: 'staffing',
    component: ParticipationByCohortTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['shiftRequests', 'users'],
  },
  {
    id: 'staffing.certExpiryRunway',
    title: 'Certification Runway',
    description: 'Volunteers by days until cert expiry (most urgent first)',
    dashboard: 'staffing',
    component: CertExpiryRunwayTile,
    defaultW: 6,
    defaultH: 6,
    dataDeps: ['users'],
  },
  {
    id: 'staffing.requestSupplyDemand',
    title: 'Signup Supply vs. Demand',
    description: 'Requests received vs. slots per event',
    dashboard: 'staffing',
    component: RequestSupplyDemandTile,
    defaultW: 6,
    defaultH: 7,
    dataDeps: ['events', 'shiftRequests'],
  },
];
