'use client';

/** Display helpers for vehicle roster + shift-log UI. */

import { FUEL_LEVEL_STEPS } from '@/app/config/org-config';
import type { VehicleShiftReadings } from '@/app/types';

/** Stored fuel value (0/25/50/75/100) → gauge label (E/¼/½/¾/F). */
export function fuelLabel(value: number | null | undefined): string | null {
  if (typeof value !== 'number') return null;
  return FUEL_LEVEL_STEPS.find((s) => s.value === value)?.label ?? `${value}%`;
}

export function formatWhen(d: Date | unknown): string {
  if (!(d instanceof Date)) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function readingsSummary(r?: VehicleShiftReadings): string {
  if (!r) return '—';
  const parts: string[] = [];
  if (typeof r.mileage === 'number') parts.push(`${r.mileage} mi`);
  const fuel = fuelLabel(r.fuelLevel);
  if (fuel) parts.push(`Fuel ${fuel}`);
  if (typeof r.batteryLevel === 'number') parts.push(`Battery ${r.batteryLevel}%`);
  return parts.length ? parts.join(' · ') : '—';
}
