import type { StorageLocationRef } from '@/app/types';

/**
 * Canonical separator + level label style for every location path in the app.
 * The legacy `displayLocation` branch in item-status.ts imports this so both
 * the structured and legacy formats render identically (UX-5).
 */
export const LOCATION_SEPARATOR = ' › ';

/** Canonical level label, e.g. `L2`. */
export function formatLevelLabel(level: number | string): string {
  return `L${level}`;
}

/**
 * Format a StorageLocationRef into a human-readable string.
 * Examples:
 *   "HQ / Back" → zone only
 *   "HQ / Back › Shelf A" → zone + shelf
 *   "HQ / Back › Shelf A › L2" → zone + shelf + level
 *   "HQ / Back › Shelf A › L2 › Bin 3" → full path
 */
export function formatStorageLocation(loc?: StorageLocationRef): string {
  if (!loc) return '';
  const parts: string[] = [];
  if (loc.zoneName) parts.push(loc.zoneName);
  if (loc.shelfName) parts.push(loc.shelfName);
  if (loc.level != null) parts.push(formatLevelLabel(loc.level));
  if (loc.containerName) parts.push(loc.containerName);
  return parts.join(LOCATION_SEPARATOR);
}

/**
 * Return a short version of the location for compact card displays.
 * Shows the most specific part (container > shelf > zone).
 */
export function shortStorageLocation(loc?: StorageLocationRef): string {
  if (!loc) return '';
  if (loc.containerName) return loc.containerName;
  if (loc.shelfName) {
    const suffix = loc.level != null ? ` L${loc.level}` : '';
    return `${loc.shelfName}${suffix}`;
  }
  return loc.zoneName ?? '';
}
